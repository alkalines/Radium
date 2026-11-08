import { convexBetterAuthReactStart } from "@convex-dev/better-auth/react-start";
import { getRequestIP } from "@tanstack/react-start/server";

const betterAuth = convexBetterAuthReactStart({
  convexUrl: process.env.VITE_CONVEX_URL!,
  convexSiteUrl: process.env.VITE_CONVEX_SITE_URL!,
  basePath: "/api/auth",
});

export const { getToken, fetchAuthQuery, fetchAuthMutation, fetchAuthAction } = betterAuth;

const PROXY_SECRET_HEADER = "x-radium-proxy-secret";
const PROXY_CLIENT_IP_HEADER = "x-radium-proxy-client-ip";

/**
 * Proxies `/api/auth/*` to the Convex site and tells it who the real client is.
 *
 * Every auth request reaches Convex from this server, so without help Better Auth's per-IP rate
 * limits (OPAQUE sign-in and reset: 5 per minute) would count all users in one bucket. When
 * `AUTH_PROXY_SECRET` is set (same value on the Convex deployment), the proxy sends the client
 * address with that secret; Convex trusts the address only together with the secret. Client-sent
 * copies of both headers are always replaced or removed, so a browser cannot choose its own bucket.
 *
 * The client address is the socket peer unless `AUTH_TRUST_X_FORWARDED_FOR=true`, which is only
 * correct when this server runs behind a reverse proxy that overwrites `X-Forwarded-For`.
 */
export function handler(request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete(PROXY_SECRET_HEADER);
  headers.delete(PROXY_CLIENT_IP_HEADER);

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
  return betterAuth.handler(
    new Request(request.url, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      // @ts-expect-error `duplex` is required by fetch for streamed bodies but missing from RequestInit types.
      duplex: "half",
    }),
  );
}
