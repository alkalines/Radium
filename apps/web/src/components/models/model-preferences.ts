import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";

const noModels: string[] = [];

/**
 * The signed-in user's model preferences (`api.preferences`): pinned models show first in a
 * `Pinned` group and hidden models leave pickers unless currently selected. User-level, so they
 * follow the user across workspaces; slugs of models a workspace cannot route are simply unused.
 * ACP agent models pin as `acp:<agentId>:<model>` (see `ModelPicker`'s `pinScope`).
 * Setters report failures with a toast; pinning un-hides and hiding un-pins on the server.
 */
export function useModelPreferences() {
  const { data } = useQuery(convexQuery(api.preferences.get, {}));
  const setModelPinnedMutation = useMutation(api.preferences.setModelPinned);
  const setModelHiddenMutation = useMutation(api.preferences.setModelHidden);

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
