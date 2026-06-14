import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { ensureSession as ensureSessionClient } from "@better-auth-ui/react";
import { ensureSession as ensureSessionServer } from "@better-auth-ui/react/server";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";

import {
  ChatroomSettings,
  chatroomSections,
  type ChatroomSection,
} from "@/components/chatroom/chatroom-settings";
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
        ensureSessionServer(queryClient, auth, {
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
  component: ChatroomPage,
});

function ChatroomPage() {
  const { section } = Route.useParams();

  return (
    <div className="w-full max-w-3xl mx-auto p-4 md:p-6">
      <ChatroomSettings section={section as ChatroomSection} hideNav />
    </div>
  );
}
