import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { AppRouter } from "server/router";

/**
 * Where tRPC calls go. Browsers call their own origin, which forwards `/api/*` to the backend.
 * Server rendering calls the backend directly (`API_INTERNAL_URL`) with the incoming request's
 * cookie, so a loader sees the same session as the browser.
 */
const trpcTarget = createIsomorphicFn()
  .server(() => {
    const backendUrl = process.env.API_INTERNAL_URL;
    if (!backendUrl) {
      throw new Error("API_INTERNAL_URL is not configured.");
    }
    const cookie = getRequestHeaders().get("cookie");
    return { url: new URL("/api/trpc", backendUrl).toString(), headers: cookie ? { cookie } : {} };
  })
  .client(() => ({ url: "/api/trpc", headers: {} }));

/**
 * tRPC for one router instance (one per server render, one in the browser): query and mutation
 * options for TanStack Query, typed by the backend's `AppRouter`. The web app imports only that
 * type from the backend.
 */
export function createTrpc(queryClient: QueryClient): Trpc {
  const target = trpcTarget();
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: target.url, headers: () => trpcTarget().headers })],
  });
  return createTRPCOptionsProxy<AppRouter>({ client, queryClient });
}

export type Trpc = TRPCOptionsProxy<AppRouter>;
