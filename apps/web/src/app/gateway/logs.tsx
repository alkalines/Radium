import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { LogsPanel } from "@/components/gateway/logs-panel";
import { WorkspaceSettingsGate } from "@/components/settings/workspace-settings-gate";
import { requireSession } from "@/lib/require-session";
import { api } from "backend/convex/_generated/api";

export const Route = createFileRoute("/gateway/logs")({
  staticData: {
    pageTitle: "Logs",
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
  component: LogsPage,
});

function LogsPage() {
  return (
    <WorkspaceSettingsGate
      title="Logs"
      ownerOnlyDetail="Gateway request logs for this workspace are visible only to the workspace owner."
    >
      <LogsPanel />
    </WorkspaceSettingsGate>
  );
}
