import { useQuery } from "@tanstack/react-query";

import { useTrpc } from "@/lib/trpc";
import { trpcClient } from "@/lib/trpc-client";

/**
 * The signed-in account's server-side key status (`e2ee.myKeyStatus`): whether it has keys, which
 * key is active and the recovery wrapper hash a replacement is signed over. It needs the session,
 * so nothing is asked without a user, and the cache entry is keyed by that user (under the
 * procedure's own key, so `trpc.e2ee.pathKey()` still invalidates it) so another account never
 * reads the previous one's answer. Public data only.
 */
export function useServerKeyStatus(userId: string | undefined) {
  const trpc = useTrpc();
  return useQuery({
    queryKey: [...trpc.e2ee.myKeyStatus.queryKey(), userId],
    queryFn: () => trpcClient().e2ee.myKeyStatus.query(),
    enabled: Boolean(userId),
  });
}
