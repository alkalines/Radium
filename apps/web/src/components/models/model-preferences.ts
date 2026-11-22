import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTrpc } from "@/lib/trpc";

const noModels: string[] = [];

/**
 * The signed-in user's model preferences (`preferences` router): pinned models show first in a
 * `Pinned` group and hidden models leave pickers unless currently selected. User-level, so they
 * follow the user across workspaces; slugs of models a workspace cannot route are simply unused.
 * ACP agent models pin as `acp:<agentId>:<model>` (see `ModelPicker`'s `pinScope`).
 * Setters report failures with a toast; pinning un-hides and hiding un-pins on the server.
 */
export function useModelPreferences() {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const { data } = useQuery(trpc.preferences.get.queryOptions());
  // Pinning un-hides and hiding un-pins, so either change refreshes the one preferences read.
  const refreshPreferences = () =>
    queryClient.invalidateQueries({ queryKey: trpc.preferences.get.queryKey() });
  const { mutateAsync: setModelPinnedMutation } = useMutation(
    trpc.preferences.setModelPinned.mutationOptions({ onSuccess: refreshPreferences }),
  );
  const { mutateAsync: setModelHiddenMutation } = useMutation(
    trpc.preferences.setModelHidden.mutationOptions({ onSuccess: refreshPreferences }),
  );

  async function setModelPinned(model: string, pinned: boolean) {
    try {
      await setModelPinnedMutation({ model, pinned });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update pinned models.");
    }
  }

  async function setModelHidden(model: string, hidden: boolean) {
    try {
      await setModelHiddenMutation({ model, hidden });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update hidden models.");
    }
  }

  return {
    pinnedModels: data?.pinnedModels ?? noModels,
    hiddenModels: data?.hiddenModels ?? noModels,
    isLoading: data === undefined,
    setModelPinned,
    setModelHidden,
  };
}
