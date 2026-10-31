import { v } from "convex/values";
import { internal } from "../../convex/_generated/api";
import { internalMutation, mutation, query } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import schema from "../../convex/schema";
import {
  notificationCategory,
  notificationCategoryValidator,
  notificationPath,
  resolvedNotificationPreferencesValidator,
  resolveNotificationPreferences,
} from "./contract";
import { loadNotificationPreferences } from "./notify";
import { webPushConfig } from "./push";

/**
 * Browser side of delivery: the live list open tabs watch, the claim that makes one tab (and so
 * one device) responsible for the sound and system notification, the push fallback for
 * notifications nobody claimed, retention, and the user's notification preferences.
 */

/** Notifications each open tab watches. Tabs only act on rows that appear after they loaded. */
const RECENT_LIMIT = 20;

/**
 * A tab that reconnects after a long sleep must not ring for old news; it still shows the toast.
 * Longer than `BROWSER_CLAIM_GRACE_MS`, so a slow tab can still claim before the fallback runs.
 */
const CLAIM_WINDOW_MS = 5 * 60 * 1000;

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

const notificationViewValidator = v.object({
  _id: v.id("notifications"),
  kind: schema.tables.notifications.validator.fields.kind,
  category: notificationCategoryValidator,
  title: v.string(),
  body: v.string(),
  /** App-relative path the notification opens. */
  path: v.string(),
  workspace: v.optional(v.id("workspaces")),
  chat: v.optional(v.id("aisdk_chats")),
  createdAt: v.number(),
  /** Some tab already claimed it (played the sound, showed the system notification). */
  claimed: v.boolean(),
  /** It went to the user's devices because no tab claimed it in time. */
  pushed: v.boolean(),
});

/** The caller's newest notifications, newest first; empty when signed out. */
export const recent = query({
  args: {},
  returns: v.array(notificationViewValidator),
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];

    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(RECENT_LIMIT);
    return rows.map((row) => ({
      _id: row._id,
      kind: row.kind,
      category: notificationCategory(row.kind),
      title: row.title,
      body: row.body,
      path: notificationPath(row),
      ...(row.workspace ? { workspace: row.workspace } : {}),
      ...(row.chat ? { chat: row.chat } : {}),
      createdAt: row.createdAt,
      claimed: row.seenAt !== undefined,
      pushed: row.delivery !== undefined,
    }));
  },
});

/**
 * Claim a notification for the calling tab. Exactly one caller gets `true`, and only while the
 * notification is fresh and was neither claimed nor pushed; that caller plays the sound and shows
 * the system notification. Claiming stops the push fallback.
 */
export const claim = mutation({
  args: { notification: v.id("notifications") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not logged in.");

    const row = await ctx.db.get("notifications", args.notification);
    if (!row || row.userId !== user._id) return false;
    if (row.seenAt !== undefined || row.delivery !== undefined) return false;

    const now = Date.now();
    if (now - row.createdAt > CLAIM_WINDOW_MS) return false;

    await ctx.db.patch("notifications", row._id, { seenAt: now });
    return true;
  },
});

/**
 * Runs `BROWSER_CLAIM_GRACE_MS` after a notification was created. Unclaimed notifications go to
 * the user's devices; claimed ones (an open tab already alerted) stop here, so nothing rings
 * twice.
 */
export const deliverFallback = internalMutation({
  args: { notification: v.id("notifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("notifications", args.notification);
    if (!row || row.seenAt !== undefined || row.delivery !== undefined) return null;

    // @todo(expo): Phone before desktop. Once the Expo app exists, look up the user's Expo push
    // tokens here (registered by the app and stored by `@convex-dev/expo-push-notifications`,
    // which batches, retries, and drops expired tokens). When the user has one, send through that
    // component, record `delivery: { channel: "expo", ... }` (widen the schema literal), and
    // return, so the desktop below is only the last resort. The browser-claim rule above already
    // keeps a phone silent while one of the user's tabs is open.

    if (!webPushConfig()) return null;
    const subscriptions = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", row.userId))
      .take(1);
    if (subscriptions.length === 0) return null;

    const now = Date.now();
    await ctx.db.patch("notifications", row._id, {
      delivery: { channel: "web_push", at: now, devices: 0 },
    });
    await ctx.scheduler.runAfter(0, internal.notifications_push.send, { notification: row._id });
    return null;
  },
});

/** Remove notifications older than 7 days. Bounded per run. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", Date.now() - RETENTION_MS))
      .take(PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete("notifications", row._id);
    return null;
  },
});

/** The caller's notification preferences with defaults filled in. */
export const getPreferences = query({
  args: {},
  returns: resolvedNotificationPreferencesValidator,
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return resolveNotificationPreferences(undefined);
    return await loadNotificationPreferences(ctx, user._id);
  },
});

/**
 * Switch one category on or off, or silence it. Account-level (`user_preferences`), so it applies
 * on every device; turning a category off stops new notifications of it on every channel.
 */
export const setPreference = mutation({
  args: {
    category: notificationCategoryValidator,
    enabled: v.boolean(),
    sound: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not logged in.");

    const row = await ctx.db
      .query("user_preferences")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    const notifications = {
      ...row?.notifications,
      [args.category]: { enabled: args.enabled, sound: args.sound },
    };
    if (row) {
      await ctx.db.patch("user_preferences", row._id, { notifications });
    } else {
      await ctx.db.insert("user_preferences", {
        userId: user._id,
        pinnedModels: [],
        hiddenModels: [],
        notifications,
      });
    }
    return null;
  },
});
