import { skipToken, useQuery } from "@tanstack/react-query";
import { useTrpc } from "@/lib/trpc";
import { retryTransient } from "@/lib/trpc-error";

/**
 * The workspace's Workers with presence and Gateway access (owner-only; `undefined` skips). One
 * query for every screen that shows them, refetched on focus and on `workers` events (a Worker
 * coming online publishes one, `lib/live-events.ts`); going offline is derived from the last
 * heartbeat by the presence clock, so no reading has to arrive for an online label to age out.
 */
export function useWorkers(workspace: string | undefined) {
  const trpc = useTrpc();
  return useQuery(
    trpc.workers.list.queryOptions(workspace ? { workspace } : skipToken, {
      retry: retryTransient,
      refetchOnWindowFocus: true,
    }),
  );
}
