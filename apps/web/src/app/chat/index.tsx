import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { api } from "backend/convex/_generated/api";
import { requireSession } from "@/lib/require-session";

/**
 * New-session draft Tab. The Window renders every open Session Tab itself (`SessionScreen`) and
 * keeps it mounted so background streams keep running, so this route renders nothing. `draft`
 * identifies one draft Tab when several are open; `project` preselects a Project for a new draft
 * (ignored once the Tab has restored choices or when the Project is not in its workspace).
 */
export const Route = createFileRoute("/chat/")({
  staticData: {
    pageTitle: "New session",
    screen: "session",
  },
  validateSearch: (search: Record<string, unknown>): { draft?: string; project?: string } => ({
    draft: typeof search.draft === "string" ? search.draft : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: () => null,
});
