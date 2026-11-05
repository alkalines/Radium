import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { requireSession } from "@/lib/require-session";

/**
 * Session Tab for one chat. The Window renders every open Session Tab itself (`SessionScreen`) and
 * keeps it mounted so background streams keep running, so this route renders nothing. `model` and
 * `provider` preselect the Model control (forks pass the model chosen for the next turn).
 */
export const Route = createFileRoute("/chat/$chatId")({
  staticData: {
    pageTitle: "Session",
    screen: "session",
  },
  validateSearch: (search: Record<string, unknown>): { model?: string; provider?: string } => ({
    model: typeof search.model === "string" ? search.model : undefined,
    provider: typeof search.provider === "string" ? search.provider : undefined,
  }),
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  loader: async ({ context: { queryClient }, params: { chatId } }) => {
    const id = chatId as Id<"aisdk_chats">;
    const chat = queryClient.prefetchQuery(convexQuery(api.aisdk.GetChat, { chatId: id }));
    const messages = queryClient.prefetchQuery(
      convexQuery(api.aisdk.GetChatMessages, { chatId: id }),
    );
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));

    // The Session screen renders a spinner until the chat and its messages load. Streamed results
    // land before hydration but after the server rendered that spinner, so the server waits for
    // them to render what the client hydrates. Client navigations stay instant.
    if (typeof window === "undefined") await Promise.all([chat, messages]);
  },
  component: () => null,
});
