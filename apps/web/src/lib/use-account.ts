import { useQuery } from "@tanstack/react-query";

import { useTrpc } from "@/lib/trpc";

/**
 * The signed-in account from the backend (`auth.me`). Convex-backed queries wait for `signedIn`
 * before they subscribe; `signInRequired` is the backend's refusal for a missing session. That
 * refusal is final, so the query does not retry it.
 */
export function useAccount() {
  const trpc = useTrpc();
  const { data: user, error, isPending } = useQuery(
    trpc.auth.me.queryOptions(undefined, { retry: false }),
  );

  return {
    signedIn: user !== undefined,
    signInRequired: error?.data?.code === "UNAUTHORIZED",
    isPending,
  };
}
