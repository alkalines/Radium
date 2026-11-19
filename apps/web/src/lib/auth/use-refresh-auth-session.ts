import { authQueryKeys } from "@better-auth-ui/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

/**
 * Returns a callback that drops every cached Better Auth query and waits for the active ones to
 * refetch. OPAQUE flows call the client plugin directly instead of Better Auth UI's mutations, so
 * nothing else invalidates the cached session: without this, a route guard that runs right after
 * sign-in (or unlock, or reset) still sees the signed-out session cached before it and redirects
 * back to sign-in.
 */
export function useRefreshAuthSession() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.resetQueries({ queryKey: authQueryKeys.all }),
    [queryClient],
  );
}
