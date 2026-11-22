import { createFileRoute } from "@tanstack/react-router";

import { ActivityPanel } from "@/components/gateway/activity-panel";
import { WorkspaceSettingsGate } from "@/components/settings/workspace-settings-gate";
import { requireSession } from "@/lib/require-session";

export const Route = createFileRoute("/gateway/activity")({
  staticData: {
    pageTitle: "Activity",
    screen: "settings",
    settingsWidth: "wide",
  },
  validateSearch: (search: Record<string, unknown>): { project?: string } => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  loader: ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.auth.me.queryOptions());
  },
  component: ActivityPage,
});

function ActivityPage() {
  const { project } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkspaceSettingsGate
      title="Activity"
      ownerOnlyDetail="Workspace usage and estimated cost are visible only to the workspace owner."
    >
      <ActivityPanel
        project={project}
        onProjectChange={(next) => void navigate({ search: { project: next }, replace: true })}
      />
    </WorkspaceSettingsGate>
  );
}
