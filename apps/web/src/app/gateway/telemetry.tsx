import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";

import { TelemetryPanel } from "@/components/gateway/telemetry-panel";
import { WorkspaceSettingsGate } from "@/components/settings/workspace-settings-gate";
import { requireSession } from "@/lib/require-session";
import { api } from "backend/convex/_generated/api";

export const Route = createFileRoute("/gateway/telemetry")({
  staticData: {
    pageTitle: "Telemetry",
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
  component: TelemetryRoute,
});

/** Owner-only request list; request and session pages (`/gateway/telemetry/...`) render in its place. */
function TelemetryRoute() {
  const isDetail = useRouterState({
    select: (state) => state.location.pathname !== "/gateway/telemetry",
  });

  return (
    <WorkspaceSettingsGate
      title="Telemetry"
      ownerOnlyDetail="Workspace-wide requests and payloads are visible only to the workspace owner."
    >
      {isDetail ? <Outlet /> : <TelemetryPanel />}
    </WorkspaceSettingsGate>
  );
}
