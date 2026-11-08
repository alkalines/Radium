import type { GenericCtx } from "@convex-dev/better-auth";
import { equalBytes } from "radium-crypto";
import type { DataModel } from "../../convex/_generated/dataModel";

/**
 * Request header Better Auth's rate limiter reads the client address from
 * (`advanced.ipAddress.ipAddressHeaders`). Only {@link prepareAuthRequest} sets it; any value
 * the request arrived with is removed first, so a client cannot pick its own rate-limit bucket
 * (audit I4).
 */
export const CLIENT_IP_HEADER = "x-radium-client-ip";

/**
 * Headers a trusted server-side auth proxy (the web app forwards `/api/auth/*` from its own
 * server, so Convex sees the web server's address for every user) uses to pass on the address
 * of its client. Honored only together with the deployment's `AUTH_PROXY_SECRET`.
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
 * names, otherwise the one Convex observed for the HTTP action. Forwarding headers a client can
 * set (`x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`, …) are never read. `null` outside an
 * HTTP request.
 */
async function clientAddress(
  ctx: GenericCtx<DataModel>,
  request: Request,
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

  if (!("meta" in ctx) || !("getRequestMetadata" in ctx.meta)) {
    return null;
  }
  const { ip } = await ctx.meta.getRequestMetadata();
  return ip;
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

/**
 * Ingress policy for every Better Auth HTTP request, applied by `createAuth` before Better Auth
 * sees the request (its rate limiter runs before any plugin hook could change headers):
 *
 * - Sets {@link CLIENT_IP_HEADER} to the client's address (see {@link clientAddress}) and strips
 *   the proxy headers so the secret never reaches Better Auth or its logs. Without an address,
 *   Better Auth falls back to one shared bucket per path and logs a warning: a denial-of-service
 *   risk, not a bypass. Behind the web app's proxy without `AUTH_PROXY_SECRET`, every user
 *   shares the web server's bucket.
 * - Bounds the body to {@link MAX_AUTH_REQUEST_BYTES}.
 * - Refuses OPAQUE POSTs whose `Origin` is not the web app (`SITE_URL`). Better Auth's own
 *   origin check skips the plugin's endpoints (assessment F7), so without this a third-party page
 *   could sign a visitor into an attacker's account (login CSRF).
 *
 * @returns the request to hand to Better Auth, or a 403/413 response.
 */
export async function prepareAuthRequest(
  ctx: GenericCtx<DataModel>,
  request: Request,
  proxySecret: string | undefined = process.env.AUTH_PROXY_SECRET,
  siteUrl: string | undefined = process.env.SITE_URL,
): Promise<Request | Response> {
  // OPAQUE endpoints: `/sign-up/opaque/*`, `/sign-in/opaque/*`, `/opaque/*`, `/reset/opaque/*`.
  const isOpaqueEndpoint = new URL(request.url).pathname.split("/").includes("opaque");
  if (request.method === "POST" && isOpaqueEndpoint && !isSiteOrigin(request, siteUrl)) {
    return jsonError(403, "Invalid origin.");
  }

  const ip = await clientAddress(ctx, request, proxySecret);
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
    return jsonError(413, "Request body too large.");
  }
  return new Request(request.url, { method: request.method, headers, body });
}

/** True when the request's `Origin` is exactly the web app's origin. A missing `Origin` fails. */
function isSiteOrigin(request: Request, siteUrl: string | undefined) {
  const origin = request.headers.get("origin");
  if (!origin || !siteUrl) {
    return false;
  }
  return origin === new URL(siteUrl).origin;
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
