import { v } from "convex/values";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { notificationCategory, notificationPath, type NotificationKind } from "./contract";

/**
 * Web Push: per-browser subscriptions, the VAPID configuration, and the data the Node sender
 * (`src/notifications/web-push.ts`) reads and writes. The sender lives in a separate module
 * because the `web-push` library needs the Node runtime.
 */

const MAX_SUBSCRIPTIONS_PER_USER = 20;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;
const MAX_LABEL_LENGTH = 120;

// The backend POSTs to subscription endpoints, so a browser-supplied URL must not be able to
// point it at internal hosts. These are the push services of Chromium browsers (FCM), Firefox
// (Mozilla autopush), Edge (WNS), and Safari (APNs web push).
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

/** Whether `endpoint` is an HTTPS URL on a known browser push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return false;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export type WebPushConfig = { publicKey: string; privateKey: string; subject: string };

/**
 * VAPID keys from the Convex environment (`bunx web-push generate-vapid-keys`). Web Push is
 * disabled while either key is missing. The subject defaults to `SITE_URL`; push services
 * require a `mailto:` or `https:` contact.
 */
export function webPushConfig(): WebPushConfig | null {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_SUBJECT ?? process.env.SITE_URL;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

async function requireUserId(ctx: MutationCtx) {
  const user = await authComponent.getAuthUser(ctx);
  if (!user) throw new Error("Not logged in.");
  return user._id;
}

/** The VAPID public key browsers subscribe with; `null` while Web Push is not configured. */
export const pushConfig = query({
  args: {},
  returns: v.object({ publicKey: v.union(v.string(), v.null()) }),
  handler: async () => ({ publicKey: webPushConfig()?.publicKey ?? null }),
});

/**
 * The caller's subscribed browsers, newest first, without endpoints or keys. `endpoint` is the
 * asking browser's own subscription, so its row can be marked as this device.
 */
export const listDevices = query({
  args: { endpoint: v.optional(v.string()) },
  returns: v.array(
    v.object({
      _id: v.id("push_subscriptions"),
      label: v.string(),
      createdAt: v.number(),
      lastDeliveredAt: v.optional(v.number()),
      current: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];

    const rows = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(MAX_SUBSCRIPTIONS_PER_USER);
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        _id: row._id,
        label: row.label,
        createdAt: row.createdAt,
        ...(row.lastDeliveredAt !== undefined ? { lastDeliveredAt: row.lastDeliveredAt } : {}),
        current: args.endpoint !== undefined && row.endpoint === args.endpoint,
      }));
  },
});

/**
 * Register this browser's push subscription for the caller. Idempotent per endpoint; an endpoint
 * registered by another user moves to the caller, because a browser profile receives pushes for
 * whoever signed in last. Returns the subscription ID so the client can name "this device".
 */
export const subscribe = mutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    label: v.string(),
  },
  returns: v.id("push_subscriptions"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!isAllowedPushEndpoint(args.endpoint)) {
      throw new Error("This browser's push service is not supported.");
    }
    if (
      args.p256dh.length === 0 ||
      args.p256dh.length > MAX_KEY_LENGTH ||
      args.auth.length === 0 ||
      args.auth.length > MAX_KEY_LENGTH
    ) {
      throw new Error("Invalid push subscription.");
    }

    const label = args.label.trim().slice(0, MAX_LABEL_LENGTH) || "Browser";
    const fields = { userId, p256dh: args.p256dh, auth: args.auth, label };
    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (existing) {
      await ctx.db.patch("push_subscriptions", existing._id, fields);
      return existing._id;
    }

    const owned = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(MAX_SUBSCRIPTIONS_PER_USER);
    if (owned.length >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new Error("Too many devices. Remove one in Settings > Notifications first.");
    }
    return await ctx.db.insert("push_subscriptions", {
      ...fields,
      endpoint: args.endpoint,
      createdAt: Date.now(),
    });
  },
});

/** Remove one of the caller's devices (by ID from `listDevices`, or this browser's endpoint). */
export const unsubscribe = mutation({
  args: {
    device: v.optional(v.id("push_subscriptions")),
    endpoint: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    let row: Doc<"push_subscriptions"> | null = null;
    if (args.device) {
      row = await ctx.db.get("push_subscriptions", args.device);
    } else if (args.endpoint) {
      const endpoint = args.endpoint;
      row = await ctx.db
        .query("push_subscriptions")
        .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
        .unique();
    }
    if (row && row.userId === userId) await ctx.db.delete("push_subscriptions", row._id);
    return null;
  },
});

// Session outcomes are stale within the hour; limit events stay useful for half a day.
function pushTtlSeconds(kind: NotificationKind) {
  return notificationCategory(kind) === "limits" ? 12 * 60 * 60 : 60 * 60;
}

/** What the Node sender pushes for one notification, or `null` once it no longer applies. */
export const pushTargets = internalQuery({
  args: { notification: v.id("notifications") },
  returns: v.union(
    v.null(),
    v.object({
      payload: v.string(),
      ttlSeconds: v.number(),
      urgency: v.union(v.literal("normal"), v.literal("high")),
      subscriptions: v.array(
        v.object({
          _id: v.id("push_subscriptions"),
          endpoint: v.string(),
          p256dh: v.string(),
          auth: v.string(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const notification = await ctx.db.get("notifications", args.notification);
    if (!notification || notification.seenAt !== undefined) return null;

    const subscriptions = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", notification.userId))
      .take(MAX_SUBSCRIPTIONS_PER_USER);

    // Read by `apps/web/public/notifications-sw.js`. The push service only relays the encrypted
    // payload; the session title is the most chat content it carries.
    const payload = JSON.stringify({
      id: notification._id,
      kind: notification.kind,
      category: notificationCategory(notification.kind),
      title: notification.title,
      body: notification.body,
      path: notificationPath(notification),
      ...(notification.workspace ? { workspace: notification.workspace } : {}),
    });
    const urgency: "normal" | "high" =
      notificationCategory(notification.kind) === "limits" ? "normal" : "high";
    return {
      payload,
      ttlSeconds: pushTtlSeconds(notification.kind),
      urgency,
      subscriptions: subscriptions.map((row) => ({
        _id: row._id,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
      })),
    };
  },
});

/**
 * Record one Web Push fan-out: delivered devices get `lastDeliveredAt`, and subscriptions the push
 * service reported gone (404/410) are removed so they are not retried.
 */
export const recordPushResult = internalMutation({
  args: {
    notification: v.id("notifications"),
    delivered: v.array(v.id("push_subscriptions")),
    expired: v.array(v.id("push_subscriptions")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const id of args.delivered) {
      const row = await ctx.db.get("push_subscriptions", id);
      if (row) await ctx.db.patch("push_subscriptions", id, { lastDeliveredAt: now });
    }
    for (const id of args.expired) {
      const row = await ctx.db.get("push_subscriptions", id);
      if (row) await ctx.db.delete("push_subscriptions", id);
    }

    const notification = await ctx.db.get("notifications", args.notification);
    if (notification?.delivery) {
      await ctx.db.patch("notifications", notification._id, {
        delivery: { ...notification.delivery, delivered: args.delivered.length },
      });
    }
    return null;
  },
});
