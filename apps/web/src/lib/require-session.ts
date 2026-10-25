import { ensureSession as ensureSessionClient } from "@better-auth-ui/core";
import { ensureSessionServer } from "@better-auth-ui/core/server";
import type { QueryClient } from "@tanstack/react-query";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";

import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";

// Better Auth UI types its server argument as a full Better Auth instance; `lib/auth.ts` is a
// request-forwarding adapter that implements only `api.getSession({ headers, baseURL })`.
const ensureAdapterSession = ensureSessionServer as unknown as (
  queryClient: QueryClient,
  adapter: typeof auth,
  params: Parameters<typeof auth.api.getSession>[0],
) => ReturnType<typeof auth.api.getSession>;

const ensureSession = createIsomorphicFn()
  .server((queryClient: QueryClient) =>
    ensureAdapterSession(queryClient, auth, {
      baseURL: getRequestUrl().origin,
      headers: getRequestHeaders(),
    }),
  )
  .client((queryClient: QueryClient) => ensureSessionClient(queryClient, authClient));

/**
 * Route `beforeLoad` guard: resolves the Better Auth session on the server or client and
 * redirects to sign-in (returning to `location.href`) when there is none. Returns the session so
 * routes can expose it in their context.
 */
export async function requireSession({
  queryClient,
  location,
}: {
  queryClient: QueryClient;
  location: ParsedLocation;
}) {
  const session = await ensureSession(queryClient);

  if (!session) {
    throw redirect({
      to: "/auth/$path",
      params: { path: "sign-in" },
      search: { redirectTo: location.href },
    });
  }

  return session;
}
