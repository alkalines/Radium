import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import {
  notificationCategory,
  resolveNotificationPreferences,
  type NotificationKind,
  type NotificationPreferences,
} from "./contract";

/**
 * How long open browser tabs have to claim a notification before it falls back to push. Tabs
 * receive it over their live query within about a second; the margin covers a busy client.
 */
export const BROWSER_CLAIM_GRACE_MS = 10_000;

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 400;

export type NotificationInput = {
  userId: string;
  workspace?: Id<"workspaces">;
  kind: NotificationKind;
  title: string;
  body: string;
  chat?: Id<"aisdk_chats">;
  limitEvent?: Id<"limit_events">;
  createdAt: number;
};

/** The user's resolved notification preferences (defaults for unset categories). */
export async function loadNotificationPreferences(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<NotificationPreferences> {
  const row = await ctx.db
    .query("user_preferences")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  return resolveNotificationPreferences(row?.notifications);
}

function bounded(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Create one notification and start its delivery. This is the single entry point for every
 * producer, so the channel order lives in one place:
 *
 * 1. **Open browser tab.** Every open tab of the user sees the row through `notifications.recent`
 *    and shows a toast; the first to call `notifications.claim` plays the sound and, when the
 *    tab is in the background, shows the system notification. A claim stops the fallback, so a
 *    device never rings twice for one notification.
 * 2. **Phone** (planned): `deliverFallback` will try the user's Expo app before the desktop.
 * 3. **Desktop push:** Web Push to the user's subscribed browsers, which shows the system
 *    notification through the service worker even with every tab closed.
 *
 * Returns `null` without writing when the user switched the notification's category off.
 */
export async function notify(
  ctx: MutationCtx,
  input: NotificationInput,
): Promise<Id<"notifications"> | null> {
  const preferences = await loadNotificationPreferences(ctx, input.userId);
  if (!preferences[notificationCategory(input.kind)].enabled) return null;

  const id = await ctx.db.insert("notifications", {
    userId: input.userId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    kind: input.kind,
    title: bounded(input.title, MAX_TITLE_LENGTH),
    body: bounded(input.body, MAX_BODY_LENGTH),
    ...(input.chat ? { chat: input.chat } : {}),
    ...(input.limitEvent ? { limitEvent: input.limitEvent } : {}),
    createdAt: input.createdAt,
  });

  await ctx.scheduler.runAfter(BROWSER_CLAIM_GRACE_MS, internal.notifications.deliverFallback, {
    notification: id,
  });
  return id;
}
