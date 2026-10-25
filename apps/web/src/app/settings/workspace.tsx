import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceManagement } from "@/components/workspaces/workspace-management";
import { requireSession } from "@/lib/require-session";

export const Route = createFileRoute("/settings/workspace")({
  staticData: {
    pageTitle: "Workspace",
    screen: "settings",
  },
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  component: WorkspaceManagement,
});
