import { useEffect, useLayoutEffect, useRef } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import {
  NOTIFICATION_OPEN_MESSAGE,
  currentPushSubscription,
  notificationPermission,
  notificationWorker,
  pushSubscriptionFields,
  showSystemNotification,
} from "./browser-notifications";
import { playNotificationSound, primeNotificationAudio } from "./notification-sounds";
import { NotificationToaster, showNotificationToast } from "./notification-toast";

type NotificationView = FunctionReturnType<typeof api.notifications.recent>[number];

/**
 * A tab without focus waits this long before claiming, so a focused tab (where the user is
 * looking) gets the sound when several tabs are open.
 */
const BACKGROUND_CLAIM_DELAY_MS = 1_500;

function isViewing(notification: NotificationView, activeChatId: string | undefined) {
  return (
    notification.chat !== undefined &&
    notification.chat === activeChatId &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

/**
 * The open-tab channel of notification delivery (`backend/src/notifications/notify.ts`). Every
 * open tab watches the user's recent notifications and, for each one that arrives while it is
 * open, shows a toast (top right, newest first) unless the user is looking at that very session.
 * Then one tab claims it: the claim winner plays the category's sound (when enabled) and, if it
 * is in the background, shows a system notification. A claimed notification is never pushed, so
 * a device rings once. Clicking a toast or system notification opens the session, or Gateway >
 * Limits in the notification's workspace.
 *
 * Mounted once by the Window; renders the notifications Toaster.
 */
export function NotificationCenter({ activeChatId }: { activeChatId?: string }) {
  const { isAuthenticated } = useConvexAuth();
  const navigate = useNavigate();
  const { setWorkspace } = useWorkspace();
  const { data: notifications } = useQuery(
    convexQuery(api.notifications.recent, isAuthenticated ? {} : "skip"),
  );
  const { data: preferences } = useQuery(
    convexQuery(api.notifications.getPreferences, isAuthenticated ? {} : "skip"),
  );
  const claim = useMutation(api.notifications.claim);
  const subscribe = useMutation(api.notifications.subscribe);

  // Rows present at load are history; only rows that arrive afterwards notify.
  const known = useRef<Set<string> | null>(null);

  function open(target: { path: string; workspace?: string; chat?: string }) {
    // Limit events belong to a workspace; Gateway pages show the current one.
    if (target.chat === undefined && target.workspace) {
      setWorkspace(target.workspace as Id<"workspaces">);
    }
    void navigate({ href: target.path });
  }

  // Read when a delayed claim settles or a click arrives, not when the notification arrived.
  const latest = useRef({ activeChatId, preferences, open });
  useLayoutEffect(() => {
    latest.current = { activeChatId, preferences, open };
  });

  useEffect(() => primeNotificationAudio(), []);

  // Signing in or out starts a new history.
  useEffect(() => {
    known.current = null;
  }, [isAuthenticated]);

  // Clicks on system notifications (shown here or pushed) arrive from the service worker.
  useEffect(() => {
    if (!isAuthenticated || !("serviceWorker" in navigator)) return;

    void notificationWorker();
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; path?: unknown; workspace?: unknown } | null;
      if (data?.type !== NOTIFICATION_OPEN_MESSAGE || typeof data.path !== "string") return;
      if (!data.path.startsWith("/")) return;
      latest.current.open({
        path: data.path,
        ...(typeof data.workspace === "string" ? { workspace: data.workspace } : {}),
        ...(data.path.startsWith("/chat/") ? { chat: data.path.slice("/chat/".length) } : {}),
      });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [isAuthenticated]);

  // A browser keeps its push subscription across sign-ins; re-register it for whoever is signed
  // in now, so pushes follow the current user (the server moves the endpoint).
  useEffect(() => {
    if (!isAuthenticated || notificationPermission() !== "granted") return;

    void currentPushSubscription().then((subscription) => {
      if (subscription) void subscribe(pushSubscriptionFields(subscription)).catch(() => {});
    });
  }, [isAuthenticated, subscribe]);

  useEffect(() => {
    if (!notifications) return;
    if (known.current === null) {
      known.current = new Set(notifications.map((notification) => notification._id));
      return;
    }

    const seen = known.current;
    const arrived = notifications.filter((notification) => !seen.has(notification._id)).reverse();
    for (const notification of arrived) {
      seen.add(notification._id);
      // Pushed while this tab was asleep or disconnected: the device already showed it.
      if (notification.pushed) continue;

      if (!isViewing(notification, latest.current.activeChatId)) {
        showNotificationToast(notification, () => latest.current.open(notification));
      }
      if (notification.claimed) continue;

      const delay = document.hasFocus() ? 0 : BACKGROUND_CLAIM_DELAY_MS;
      window.setTimeout(() => {
        void claim({ notification: notification._id })
          .then((won) => {
            const { activeChatId: chatId, preferences: current } = latest.current;
            if (!won || isViewing(notification, chatId)) return;

            if (current?.[notification.category].sound)
              playNotificationSound(notification.category);
            const isForeground = document.visibilityState === "visible" && document.hasFocus();
            if (!isForeground) {
              void showSystemNotification({ ...notification, id: notification._id }, () =>
                latest.current.open(notification),
              );
            }
          })
          .catch(() => {
            // A failed claim leaves the notification to the push fallback.
          });
      }, delay);
    }
  }, [notifications, claim]);

  return <NotificationToaster />;
}
