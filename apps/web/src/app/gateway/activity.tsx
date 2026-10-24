import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ActivityPanel } from "@/components/gateway/activity-panel";
import { WorkspaceSettingsGate } from "@/components/settings/workspace-settings-gate";
import { requireSession } from "@/lib/require-session";
import { api } from "backend/convex/_generated/api";

export const Route = createFileRoute("/gateway/activity")({
  staticData: {
    pageTitle: "Activity",
    screen: "settings",
    settingsWidth: "wide",
  },
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <WorkspaceSettingsGate
      title="Activity"
      ownerOnlyDetail="Workspace usage and estimated cost are visible only to the workspace owner."
    >
      <ActivityPanel />
    </WorkspaceSettingsGate>
  );
}
