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
  loader: ({ context: { queryClient }, params: { chatId } }) => {
    void queryClient.prefetchQuery(
      convexQuery(api.aisdk.GetChat, { chatId: chatId as Id<"aisdk_chats"> }),
    );
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: () => null,
});
