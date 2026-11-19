import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import {
  notificationCategory,
  notificationTitle,
  resolveNotificationPreferences,
  type NotificationKind,
  type NotificationPreferences,
} from "./contract";
import { readMigrationState } from "../e2ee/migration-contract";

/**
 * How long open browser tabs have to claim a notification before it falls back to push. Tabs
 * receive it over their live query within about a second; the margin covers a busy client.
 */
export const BROWSER_CLAIM_GRACE_MS = 10_000;

export type NotificationInput = {
  userId: string;
  workspace?: Id<"workspaces">;
  kind: NotificationKind;
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
  // Best-effort alerts must not write while the encryption cutover freeze keeps data stable.
  if ((await readMigrationState(ctx))?.frozen) return null;
  const preferences = await loadNotificationPreferences(ctx, input.userId);
  if (!preferences[notificationCategory(input.kind)].enabled) return null;

  const identity = await ctx.db
    .query("e2ee_identities")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", input.userId).eq("status", "active"))
    .first();

  const id = await ctx.db.insert("notifications", {
    userId: input.userId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    kind: input.kind,
    title: notificationTitle(input.kind),
    body: input.chat ? "Session" : "Workspace",
    ...(input.chat ? { chat: input.chat } : {}),
    ...(input.limitEvent ? { limitEvent: input.limitEvent } : {}),
    createdAt: input.createdAt,
    ...(identity ? { sealingPending: true } : {}),
  });

  if (identity) {
    await ctx.scheduler.runAfter(0, internal.notifications.sealNotification, { notification: id });
  }

  await ctx.scheduler.runAfter(BROWSER_CLAIM_GRACE_MS, internal.notifications.deliverFallback, {
    notification: id,
  });
  return id;
}
