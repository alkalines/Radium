import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { sessionNotificationKindValidator } from "contracts/notifications/contract";
import { limitEventKindValidator } from "contracts/limits/events";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import { user } from "../auth/schema";
import { bytes, checkIn, createdAt, id, instant, json, literals } from "../db/columns";
import { chats } from "../chatroom/schema";
import { limitEvents } from "../gateway/schema";
import { workspaces } from "../workspaces/schema";

const SESSION_KINDS = literals(sessionNotificationKindValidator);
const NOTIFICATION_KINDS = literals(
  z.union([sessionNotificationKindValidator, limitEventKindValidator]),
);
const DELIVERY_CHANNELS = ["web_push"] as const;

const sqlList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * One notification for one user: a Chatroom run outcome for the user who sent it, or a limit
 * event for the workspace owner. Open browser tabs claim it (`seen_at`); unclaimed ones fall back
 * to push (`delivery_*`). Kept 7 days by `created_at`. Title and body are not stored: both are the
 * generic text of `kind` (and whether `chat` is set); the sealed box carries the detail.
 *
 * Sealing is an outbox job that fills `sealed_*` afterwards; a row without a box is shown as the
 * generic notification. A notification belongs to its chat or limit event and goes with it.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    /** The recipient. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspace: text("workspace").references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    // A session notification has no use once its chat is gone: it opens that chat.
    chat: text("chat").references(() => chats.id, { onDelete: "cascade" }),
    // Limit events are pruned after 30 days, long after their notification.
    limitEvent: text("limit_event").references(() => limitEvents.id, { onDelete: "cascade" }),
    /** Identity-bound content sealed to the recipient's active key; both are set together. */
    sealedKeyId: text("sealed_key_id"),
    sealedBox: bytes("sealed_box"),
    /**
     * Set by the first open tab that claimed it (conditional update); push fallback is skipped once
     * set.
     */
    seenAt: instant("seen_at"),
    /**
     * Set when the fallback sent it to devices because no open tab claimed it in time: channel,
     * time and device count are set together; `delivery_delivered` follows the push result.
     */
    deliveryChannel: text("delivery_channel", { enum: DELIVERY_CHANNELS }),
    deliveryAt: instant("delivery_at"),
    deliveryDevices: integer("delivery_devices"),
    deliveryDelivered: integer("delivery_delivered"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("notifications_kind", table.kind, NOTIFICATION_KINDS),
    checkIn("notifications_delivery_channel", table.deliveryChannel, DELIVERY_CHANNELS),
    // Session kinds point at their chat, limit kinds at their event, never both.
    check(
      "notifications_subject",
      sql`(${table.kind} in (${sqlList(SESSION_KINDS)}) and ${table.chat} is not null and ${table.limitEvent} is null)
        or (${table.kind} not in (${sqlList(SESSION_KINDS)}) and ${table.chat} is null and ${table.limitEvent} is not null)`,
    ),
    check(
      "notifications_sealed",
      sql`num_nonnulls(${table.sealedKeyId}, ${table.sealedBox}) in (0, 2)`,
    ),
    // A native box is never written beside a historical sidecar: readers prefer the box, so it
    // would shadow the sidecar's content.
    check(
      "notifications_sealed_legacy",
      sql`${table.sealedBox} is null or ${table.legacyContent} is null`,
    ),
    check(
      "notifications_delivery",
      sql`num_nonnulls(${table.deliveryChannel}, ${table.deliveryAt}, ${table.deliveryDevices}) in (0, 3)
        and (${table.deliveryDelivered} is null or ${table.deliveryChannel} is not null)`,
    ),
    // A tab claim and the push fallback exclude each other: each is a conditional update that
    // requires the other to be unset.
    check(
      "notifications_claim_or_delivery",
      sql`${table.seenAt} is null or ${table.deliveryAt} is null`,
    ),
    // The feed: a user's newest notifications (notifications.recent).
    index("notifications_user_created").on(table.userId, table.createdAt),
    // Retention: notifications older than 7 days (notifications.prune).
    index("notifications_created").on(table.createdAt),
    // The cascades from `chats` and `limit_events`.
    index("notifications_chat")
      .on(table.chat)
      .where(sql`${table.chat} is not null`),
    index("notifications_limit_event")
      .on(table.limitEvent)
      .where(sql`${table.limitEvent} is not null`),
  ],
);

/**
 * Web Push subscriptions (one per browser profile), registered from Settings > Notifications. Only
 * endpoints of known push services are accepted (`src/notifications/push.ts`); a browser profile
 * receives pushes for whoever signed in last, so registering an endpoint another user holds moves
 * the row to the caller.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** Browser and OS reported by the client, for the device list. */
    label: text("label").notNull(),
    lastDeliveredAt: instant("last_delivered_at"),
    createdAt: createdAt(),
  },
  (table) => [
    // The server POSTs to the endpoint, so it must be HTTPS (the host allowlist is code).
    check("push_subscriptions_https", sql`${table.endpoint} ~* '^https://'`),
    // One row per endpoint; subscribe upserts on it and unsubscribe finds it by endpoint.
    uniqueIndex("push_subscriptions_endpoint").on(table.endpoint),
    // A user's devices and the fallback's push targets (push.listDevices, push.pushTargets).
    index("push_subscriptions_user").on(table.userId),
  ],
);
