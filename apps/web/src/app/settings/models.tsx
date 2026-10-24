import { createFileRoute } from "@tanstack/react-router";

import { ModelPreferencesPanel } from "@/components/models/model-preferences-panel";
import { requireSession } from "@/lib/require-session";

export const Route = createFileRoute("/settings/models")({
  staticData: {
    pageTitle: "Models",
    screen: "settings",
  },
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  component: ModelPreferencesPanel,
});
