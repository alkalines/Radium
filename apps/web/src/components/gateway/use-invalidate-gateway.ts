import { useQueryClient } from "@tanstack/react-query";

import { useTrpc } from "@/lib/trpc";

/**
 * Refreshes every Gateway read a provider, model, or credential change can touch: the provider
 * list and credential pools, the routable model catalogue, routing state, and credential limits.
 * Convex pushed these on its own; tRPC reads only change when they are invalidated.
 */
export function useInvalidateGateway() {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.providers.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.models.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.routing.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.limits.pathKey() }),
    ]);
}
