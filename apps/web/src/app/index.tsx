import { createFileRoute } from "@tanstack/react-router";
import { convexQuery } from "@convex-dev/react-query";

import { api } from "backend/convex/_generated/api";
import { HomeScreen } from "@/components/home/home-screen";
import { requireSession } from "@/lib/require-session";

export const Route = createFileRoute("/")({
  staticData: {
    pageTitle: "Home",
    screen: "home",
  },
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: HomeScreen,
});
