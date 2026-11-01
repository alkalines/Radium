import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { chatroomSections } from "@/components/chatroom/chatroom-settings";
import { AgentsPanel } from "@/components/chatroom/agents-panel";
import { PreferencesPanel } from "@/components/chatroom/preferences-panel";
import { ToolsPanel } from "@/components/chatroom/tools-panel";
import { WorkspaceSettingsGate } from "@/components/settings/workspace-settings-gate";
import { WorkerManagement } from "@/components/workspaces/worker-management";
import { requireSession } from "@/lib/require-session";
import { api } from "backend/convex/_generated/api";

export const Route = createFileRoute("/chatroom/$section")({
  staticData: {
    pageTitle: "Chatroom",
    screen: "settings",
  },
  async beforeLoad({ params: { section }, context: { queryClient }, location }) {
    if (!chatroomSections.some((entry) => entry.value === section)) {
      throw notFound();
    }

    const session = await requireSession({ queryClient, location });
    return { session };
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: ChatroomPage,
});

const chatroomOwnerOnlyDetail =
  "Shared chat defaults, agents, tools, and MCP servers stay with the workspace owner. You can still start and use chats here.";

function ChatroomPage() {
  const { section } = Route.useParams();
  const chatroomSection = chatroomSections.find((entry) => entry.value === section);

  if (!chatroomSection) {
    throw notFound();
  }

  switch (chatroomSection.value) {
    // Members may open the Workers page; it drops its owner controls itself.
    case "workers":
      return (
        <WorkspaceSettingsGate title={chatroomSection.label}>
          <WorkerManagement />
        </WorkspaceSettingsGate>
      );
    case "preferences":
      return (
        <WorkspaceSettingsGate
          title={chatroomSection.label}
          ownerOnlyDetail={chatroomOwnerOnlyDetail}
        >
          <PreferencesPanel />
        </WorkspaceSettingsGate>
      );
    case "agents":
      return (
        <WorkspaceSettingsGate
          title={chatroomSection.label}
          ownerOnlyDetail={chatroomOwnerOnlyDetail}
        >
          <AgentsPanel />
        </WorkspaceSettingsGate>
      );
    case "tools":
      return (
        <WorkspaceSettingsGate
          title={chatroomSection.label}
          ownerOnlyDetail={chatroomOwnerOnlyDetail}
        >
          <ToolsPanel />
        </WorkspaceSettingsGate>
      );
  }
}
