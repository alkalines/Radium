import { createFileRoute } from "@tanstack/react-router";

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
  loader: ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.auth.me.queryOptions());
  },
  component: HomeScreen,
});
