import webpush, { WebPushError } from "web-push";
import { v } from "convex/values";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { internalAction } from "../../convex/_generated/server";
import { logger } from "../logging/server";
import { webPushConfig } from "./push";

/**
 * Send one notification to every subscribed browser of its user. Node-only (the `web-push`
 * library), registered from `convex/notifications_push.ts`; import nothing from here into
 * default-runtime modules. Scheduled once by `deliverFallback`, which already marked the
 * notification delivered, so a retry never pushes twice; failures other than an expired
 * subscription are logged and dropped.
 */
export const send = internalAction({
  args: { notification: v.id("notifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = webPushConfig();
    if (!config) return null;

    const target = await ctx.runQuery(internal.notifications.pushTargets, args);
    if (!target || target.subscriptions.length === 0) return null;

    const delivered: Id<"push_subscriptions">[] = [];
    const expired: Id<"push_subscriptions">[] = [];
    await Promise.all(
      target.subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            target.payload,
            { vapidDetails: config, TTL: target.ttlSeconds, urgency: target.urgency },
          );
          delivered.push(subscription._id);
        } catch (error) {
          // 404/410: the browser dropped the subscription (unsubscribed, cleared site data).
          if (
            error instanceof WebPushError &&
            (error.statusCode === 404 || error.statusCode === 410)
          ) {
            expired.push(subscription._id);
            return;
          }
          logger.warn("notifications.web_push_failed", {
            metadata: { status: error instanceof WebPushError ? error.statusCode : null },
          });
        }
      }),
    );

    await ctx.runMutation(internal.notifications.recordPushResult, {
      notification: args.notification,
      delivered,
      expired,
    });
    return null;
  },
});
