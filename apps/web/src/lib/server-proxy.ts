import { getRequestIP } from "@tanstack/react-start/server";

import { serverOrigin } from "./server-origin";

// Hop-by-hop headers describe one connection and must not be forwarded (RFC 9110 §7.6.1); `host` is
// set by fetch for the upstream.
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

/**
 * Forwards a request to `target` and streams the response back unchanged, so SSE and chat streams
 * flush as they are produced and uploads are not buffered. Redirects are returned to the caller
 * instead of being followed with the caller's cookies.
 */
export async function proxyRequest(
  request: Request,
  target: URL,
  headers: Headers,
): Promise<Response> {
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);

  // The incoming request comes from the server runtime's own Request class, which undici's
  // `new Request(request, init)` cannot clone; rebuild it from its parts instead.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
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

/**
 * Forwards `/api/*` to packages/server under the same path, so the browser only ever talks to the
 * page's origin (no CORS, first-party cookies) whether or not a reverse proxy sits in front.
 *
 * The server sees the public host and scheme in `X-Forwarded-Host`/`-Proto` (its WebSocket Origin
 * check and, later, Better Auth rely on them) and the client address in `X-Forwarded-For`.
 * Client-sent copies are always replaced. The address is the socket peer unless
 * `AUTH_TRUST_X_FORWARDED_FOR=true`, which is only correct behind a proxy that overwrites it.
 */
export function proxyToServer(request: Request): Promise<Response> {
  const source = new URL(request.url);
  const target = new URL(source.pathname + source.search, serverOrigin());

  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", source.host);
  headers.set("x-forwarded-proto", source.protocol.slice(0, -1));
  headers.delete("x-forwarded-for");
  const clientIp = getRequestIP({
    xForwardedFor: process.env.AUTH_TRUST_X_FORWARDED_FOR === "true",
  });
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  return proxyRequest(request, target, headers);
}
