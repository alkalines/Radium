import { getRequestIP } from "@tanstack/react-start/server";

const PROXY_SECRET_HEADER = "x-radium-proxy-secret";
const PROXY_CLIENT_IP_HEADER = "x-radium-proxy-client-ip";

// Connection-level headers that describe this hop, not the request.
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
];

/** A request as srvx hands it over on Bun (Nitro's Bun preset): with the serving Bun server. */
type BunRequest = Request & {
  runtime?: { bun?: { server?: { timeout?(request: Request, seconds: number): void } } };
};

/**
 * Forwards a browser request for `/api/*` to the backend at `API_INTERNAL_URL`, path and query
 * unchanged, streaming both bodies. Browsers only ever talk to the web origin, so the backend
 * needs no CORS and its session cookies live on this origin (`docs/Backend_Migration.md`).
 *
 * The backend rate-limits auth per client address, but every forwarded request comes from this
 * server. When `AUTH_PROXY_SECRET` is set (same value on the backend), the forwarder names the
 * client address together with that secret; the backend trusts the address only with the secret.
 * Client-sent copies of both headers are always removed, so a browser cannot choose its own bucket.
 * The client address is the socket peer unless `AUTH_TRUST_X_FORWARDED_FOR=true`, which is only
 * correct behind a reverse proxy that overwrites `X-Forwarded-For`.
 */
export async function forwardToBackend(request: Request): Promise<Response> {
  const backendUrl = process.env.API_INTERNAL_URL;
  if (!backendUrl) {
    return Response.json({ error: "API_INTERNAL_URL is not configured." }, { status: 500 });
  }

  const source = new URL(request.url);
  const target = new URL(`${source.pathname}${source.search}`, backendUrl);
  // Live stream reads and Electric shape long-polls (20 s) stay quiet for long stretches (the
  // stream server sends no keepalives), and Bun's 10 s per-connection idle timeout would cut them.
  // srvx exposes the Bun server on the request under Nitro; other runtimes have no such timeout.
  if (source.pathname.startsWith("/api/streams/") || source.pathname.startsWith("/api/shapes/")) {
    const bunRequest: BunRequest = request;
    bunRequest.runtime?.bun?.server?.timeout?.(request, 0);
  }

  const headers = new Headers(request.headers);
  for (const name of [...HOP_BY_HOP_HEADERS, PROXY_SECRET_HEADER, PROXY_CLIENT_IP_HEADER]) {
    headers.delete(name);
  }
  const secret = process.env.AUTH_PROXY_SECRET;
  const clientIp = getRequestIP({
    xForwardedFor: process.env.AUTH_TRUST_X_FORWARDED_FOR === "true",
  });
  if (secret && clientIp) {
    headers.set(PROXY_SECRET_HEADER, secret);
    headers.set(PROXY_CLIENT_IP_HEADER, clientIp);
  }

  // The incoming request comes from the server runtime's own Request class, which undici's
  // `new Request(request, init)` cannot clone; rebuild it from its parts instead.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    // Redirects go back to the browser; following them here would carry its cookies along.
    redirect: "manual",
    signal: request.signal,
    // @ts-expect-error `duplex` is required by fetch for streamed bodies but missing from RequestInit types.
    duplex: "half",
  });

  // fetch decompresses upstream responses, so these headers no longer describe the body.
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
