import { skipToken, useQuery } from "@tanstack/react-query";
import { useTrpc } from "@/lib/trpc";
import { retryTransient } from "@/lib/trpc-error";

/** How often Worker presence is refetched while a screen showing it is open (a heartbeat is 20 s). */
const WORKER_LIST_REFRESH_MS = 30_000;

/**
 * The workspace's Workers with presence and Gateway access (owner-only; `undefined` skips). One
 * query for every screen that shows them, refetched on focus and every 30 seconds, so an online
 * label never ages out without a new reading.
 */
export function useWorkers(workspace: string | undefined) {
  const trpc = useTrpc();
  return useQuery(
    trpc.workers.list.queryOptions(workspace ? { workspace } : skipToken, {
      retry: retryTransient,
      refetchOnWindowFocus: true,
      // A refusal (a member asking) is final; only a working query keeps its presence fresh.
      refetchInterval: (query) => (query.state.status === "error" ? false : WORKER_LIST_REFRESH_MS),
    }),
  );
}
