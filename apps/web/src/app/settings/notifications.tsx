import { createFileRoute } from "@tanstack/react-router";

import { NotificationsPanel } from "@/components/notifications/notifications-panel";
import { requireSession } from "@/lib/require-session";

export const Route = createFileRoute("/settings/notifications")({
  staticData: {
    pageTitle: "Notifications",
    screen: "settings",
  },
  async beforeLoad({ context: { queryClient }, location }) {
    const session = await requireSession({ queryClient, location });
    return { session };
  },
  component: NotificationsPanel,
});
