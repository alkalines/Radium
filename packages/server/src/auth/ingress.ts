import { equalBytes } from "radium-crypto";

/**
 * Request header Better Auth's rate limiter reads the client address from. Only
 * {@link prepareAuthRequest} sets it; a client-sent copy is always replaced or removed.
 */
export const CLIENT_IP_HEADER = "x-radium-client-ip";

/**
 * Headers the web server's `/api/*` forwarder uses to pass on its client's address (every browser
 * request reaches the backend from the web server). Honored only together with
 * `AUTH_PROXY_SECRET`.
 */
export const PROXY_SECRET_HEADER = "x-radium-proxy-secret";
export const PROXY_CLIENT_IP_HEADER = "x-radium-proxy-client-ip";

/**
 * Largest auth request body accepted. OPAQUE messages are capped at 4096 base64url characters
 * and a key bundle is about 3 KB; the headroom is for profile updates carrying a resized avatar
 * data URL. Anything larger is refused before Better Auth parses JSON (audit I5).
 */
export const MAX_AUTH_REQUEST_BYTES = 256 * 1024;

/** SHA-256 of a header value, so secrets of any length compare in constant time. */
async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Address to rate-limit this request by: the one a request authenticated with the proxy secret
 * names, otherwise the connection's peer. Forwarding headers a client can set
 * (`x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`, …) are never read.
 */
async function clientAddress(
  request: Request,
  peerAddress: string | null,
  proxySecret: string | undefined,
) {
  const presented = request.headers.get(PROXY_SECRET_HEADER);
  const forwarded = request.headers.get(PROXY_CLIENT_IP_HEADER);
  if (proxySecret && presented && forwarded) {
    // Hashing first makes the comparison independent of where (and whether) lengths differ.
    if (equalBytes(await digest(presented), await digest(proxySecret))) {
      return forwarded;
    }
  }
  return peerAddress;
}

/**
 * Reads the body up to `limit` bytes. Returns `null` as soon as the declared or streamed size
 * exceeds it, so an oversized (or chunked, undeclared) body is never buffered whole.
 */
async function readBoundedBody(request: Request, limit: number) {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit)) {
    return null;
  }
  if (!request.body) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Inputs of {@link prepareAuthRequest} that come from configuration and the connection. */
export type AuthIngress = {
  siteUrl: string;
  proxySecret: string | undefined;
  /** Address of the connection's peer, as the runtime reports it; `null` when unknown. */
  peerAddress: string | null;
};

/**
 * Ingress policy for every Better Auth HTTP request, applied before Better Auth sees it (its rate
 * limiter runs before any plugin hook could change headers):
 *
 * - Sets {@link CLIENT_IP_HEADER} to the client's address (see {@link clientAddress}) and strips
 *   the proxy headers so the secret never reaches Better Auth or its logs. Without an address,
 *   Better Auth falls back to one shared bucket per path: a denial-of-service risk, not a bypass.
 *   Behind the web forwarder without `AUTH_PROXY_SECRET`, every user shares the web server's
 *   bucket.
 * - Bounds the body to {@link MAX_AUTH_REQUEST_BYTES}.
 * - Refuses OPAQUE POSTs whose `Origin` is not the web app (`SITE_URL`). Better Auth's own
 *   origin check skips the plugin's endpoints (assessment F7), so without this a third-party page
 *   could sign a visitor into an attacker's account (login CSRF).
 *
 * @returns the request to hand to Better Auth, or a 403/413 response.
 */
export async function prepareAuthRequest(
  request: Request,
  ingress: AuthIngress,
): Promise<Request | Response> {
  // OPAQUE endpoints: `/sign-up/opaque/*`, `/sign-in/opaque/*`, `/opaque/*`, `/reset/opaque/*`.
  const isOpaqueEndpoint = new URL(request.url).pathname.split("/").includes("opaque");
  if (
    request.method === "POST" &&
    isOpaqueEndpoint &&
    request.headers.get("origin") !== ingress.siteUrl
  ) {
    return Response.json({ message: "Invalid origin." }, { status: 403 });
  }

  const ip = await clientAddress(request, ingress.peerAddress, ingress.proxySecret);
  const headers = new Headers(request.headers);
  headers.delete(PROXY_SECRET_HEADER);
  headers.delete(PROXY_CLIENT_IP_HEADER);
  headers.delete(CLIENT_IP_HEADER);
  if (ip) {
    headers.set(CLIENT_IP_HEADER, ip);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    return new Request(request.url, { method: request.method, headers });
  }

  const body = await readBoundedBody(request, MAX_AUTH_REQUEST_BYTES);
  if (!body) {
    return Response.json({ message: "Request body too large." }, { status: 413 });
  }
  return new Request(request.url, { method: request.method, headers, body });
}
