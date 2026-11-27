import type { QueryClient } from "@tanstack/react-query";
import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
  type TRPCLink,
} from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { AppRouter } from "server/trpc";

import { serverOrigin } from "./server-origin";

let tabSocket: ReturnType<typeof createWSClient> | undefined;

/**
 * The Tab's one WebSocket to packages/server, shared by every subscription. Same origin as the page
 * (relayed by `src/server/api-ws.ts`, or routed directly by a reverse proxy), so the session cookie
 * authenticates the upgrade. Opened on the first subscription.
 */
function getTabSocket() {
  tabSocket ??= createWSClient({
    url: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws`,
    lazy: { enabled: true, closeMs: 0 },
    // Detects a dead connection (sleep, network change) within ~35 s so wsLink reconnects and
    // resumes tracked subscriptions from their last event ID.
    keepAlive: { enabled: true, intervalMs: 30_000, pongTimeoutMs: 5_000 },
  });
  return tabSocket;
}

function createLinks(): TRPCLink<AppRouter>[] {
  if (typeof window === "undefined") {
    // SSR runs next to the server, so it calls it directly instead of through the public origin.
    // Forwarding the visitor's session cookie arrives with Better Auth (T2).
    return [httpBatchLink({ url: `${serverOrigin()}/api/trpc` })];
  }

  return [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: wsLink({ client: getTabSocket() }),
      false: httpBatchLink({ url: "/api/trpc" }),
    }),
  ];
}

/**
 * TanStack Query options for every packages/server procedure (`trpc.system.health.queryOptions()`),
 * bound to the router's query client. Queries and mutations go over batched HTTP, subscriptions
 * over the Tab's WebSocket.
 */
export function createTRPC(queryClient: QueryClient) {
  const client = createTRPCClient<AppRouter>({ links: createLinks() });
  return createTRPCOptionsProxy<AppRouter>({ client, queryClient });
}

export type TRPC = ReturnType<typeof createTRPC>;
