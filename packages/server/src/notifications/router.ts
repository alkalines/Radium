import * as z from "zod";
import { notificationCategoryValidator } from "contracts/notifications/contract";
import { publicProcedure, router, sessionProcedure } from "../trpc/init";
import { notificationPreferences, setNotificationPreference } from "../workspaces/preferences";
import { claimNotification, recentNotifications } from "./inbox";
import {
  listPushDevices,
  MAX_ENDPOINT_LENGTH,
  MAX_KEY_LENGTH,
  subscribePush,
  unsubscribePush,
  webPushConfig,
} from "./push";

const id = z.string().min(1).max(128);
const endpoint = z.string().min(1).max(MAX_ENDPOINT_LENGTH);

/** Notifications of the signed-in user (Convex `notifications.*`). */
export const notificationsRouter = router({
  recent: sessionProcedure.query(({ ctx }) =>
    recentNotifications(ctx.runtime.drivers.db, ctx.user.id),
  ),
  claim: sessionProcedure
    .input(z.object({ notification: id }))
    .mutation(({ ctx, input }) =>
      claimNotification(ctx.runtime.drivers.db, ctx.user.id, input.notification),
    ),
  getPreferences: sessionProcedure.query(({ ctx }) =>
    notificationPreferences(ctx.runtime.drivers.db, ctx.user.id),
  ),
  setPreference: sessionProcedure
    .input(
      z.object({ category: notificationCategoryValidator, enabled: z.boolean(), sound: z.boolean() }),
    )
    .mutation(async ({ ctx, input }) => {
      await setNotificationPreference(ctx.runtime.drivers.db, ctx.user.id, input.category, input);
      return null;
    }),
  /** The VAPID public key browsers subscribe with; `null` while Web Push is not configured. */
  pushConfig: publicProcedure.query(({ ctx }) => ({
    publicKey: webPushConfig(ctx.runtime.config)?.publicKey ?? null,
  })),
  listDevices: sessionProcedure
    .input(z.object({ endpoint: endpoint.optional() }))
    .query(({ ctx, input }) =>
      listPushDevices(ctx.runtime.drivers.db, ctx.user.id, input.endpoint),
    ),
  subscribe: sessionProcedure
    .input(
      z.object({
        endpoint,
        p256dh: z.string().max(MAX_KEY_LENGTH),
        auth: z.string().max(MAX_KEY_LENGTH),
        label: z.string().max(512),
      }),
    )
    .mutation(({ ctx, input }) => subscribePush(ctx.runtime.drivers.db, ctx.user.id, input)),
  unsubscribe: sessionProcedure
    .input(z.object({ device: id.optional(), endpoint: endpoint.optional() }))
    .mutation(async ({ ctx, input }) => {
      await unsubscribePush(ctx.runtime.drivers.db, ctx.user.id, input);
      return null;
    }),
});
