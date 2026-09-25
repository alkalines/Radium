import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { ensureSession as ensureSessionClient } from "@better-auth-ui/core";
import { ensureSessionServer } from "@better-auth-ui/core/server";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";

import { convexQuery } from "@convex-dev/react-query";

import {
  ChatroomSettings,
  chatroomSections,
  type ChatroomSection,
} from "@/components/chatroom/chatroom-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { api } from "backend/convex/_generated/api";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/chatroom/$section")({
  staticData: {
    pageTitle: "Chatroom",
  },
  async beforeLoad({ params: { section }, context: { queryClient }, location }) {
    if (!chatroomSections.some((entry) => entry.value === section)) {
      throw notFound();
    }

    const ensureSession = createIsomorphicFn()
      .server(() =>
        ensureSessionServer(queryClient, auth as any, {
          baseURL: getRequestUrl().origin,
          headers: getRequestHeaders(),
        }),
      )
      .client(() => ensureSessionClient(queryClient, authClient));

    const session = await ensureSession();

    if (!session) {
      throw redirect({
        to: "/auth/$path",
        params: { path: "sign-in" },
        search: { redirectTo: location.href },
      });
    }

    return { session };
  },
  loader: ({ context: { queryClient }, params: { section } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: ChatroomPage,
});

function ChatroomPage() {
  const { section } = Route.useParams();
  const { workspace, isLoading } = useWorkspace();

  if (isLoading) {
    return <Skeleton className="mx-auto h-32 w-full max-w-3xl" />;
  }

  if (!workspace) {
    return (
      <WorkspaceNotice
        title="Workspace unavailable"
        description="Select an active workspace to view Chatroom settings."
      />
    );
  }

  if (workspace.role === "member") {
    return (
      <WorkspaceNotice
        title="Chatroom settings are owner-only"
        description={`You can start and use chats in ${workspace.name}. Only its owner can change shared defaults, tools, and MCP servers.`}
      />
    );
  }

  return (
    <div className="w-full max-w-3xl mx-auto p-4 md:p-6">
      <ChatroomSettings section={section as ChatroomSection} hideNav />
    </div>
  );
}

function WorkspaceNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <Alert>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
    </div>
  );
}
