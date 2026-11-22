import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
import type { AppRouter } from "server/router";

/** Browsers call their own origin, which forwards `/api/*` to the backend. */
export const browserTrpcUrl = "/api/trpc";

let client: TRPCClient<AppRouter> | undefined;

/**
 * The browser's shared vanilla tRPC client, for imperative code (`lib/crypto`) that calls a
 * procedure outside React Query's cache. Browser-only: it sends no server-render cookie. It lives
 * apart from `./trpc` because the service worker bundles `lib/crypto`, and `./trpc` imports
 * TanStack Start's server runtime.
 */
export function trpcClient(): TRPCClient<AppRouter> {
  client ??= createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: browserTrpcUrl })] });
  return client;
}
