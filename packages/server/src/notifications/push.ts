import { buildPushPayload } from "@block65/webcrypto-web-push";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { fromBase64Url, toBase64Url } from "radium-crypto";
import { z } from "zod";
import {
  notificationCategory,
  notificationPath,
  notificationTitle,
  type NotificationKind,
} from "contracts/notifications/contract";
import type { Config } from "../config";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { logger } from "../logging/server";
import type { Runtime } from "../runtime";
import { notifications, pushSubscriptions } from "./schema";

/**
 * Web Push (Convex `src/notifications/{push,web-push}.ts`): per-browser subscriptions, the VAPID
 * configuration, and the fallback that sends a notification no open tab claimed. Payloads are
 * RFC 8291 `aes128gcm`, signed with RFC 8292 VAPID through WebCrypto
 * (`@block65/webcrypto-web-push`), posted with `runtime.fetch`.
 */

const MAX_SUBSCRIPTIONS_PER_USER = 20;
export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_KEY_LENGTH = 256;
const MAX_LABEL_LENGTH = 120;
/** One push service request; a stalled endpoint fails instead of holding the job. */
const PUSH_REQUEST_TIMEOUT_MS = 10_000;

// The server POSTs to subscription endpoints, so a browser-supplied URL must not be able to point
// it at internal hosts. These are the push services of Chromium browsers (FCM), Firefox (Mozilla
// autopush), Edge (WNS), and Safari (APNs web push).
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

/** The VAPID configuration, or `null` while Web Push is not configured. */
export function webPushConfig(config: Config): WebPushConfig | null {
  const publicKey = config.WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = config.WEB_PUSH_VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: config.WEB_PUSH_SUBJECT ?? config.SITE_URL };
}

/** A browser `PushSubscription` key: base64url of exactly `length` bytes (and a P-256 point). */
function validKey(value: string, length: number, point = false) {
  if (value.length === 0 || value.length > MAX_KEY_LENGTH) return false;
  try {
    const bytes = fromBase64Url(value);
    return bytes.byteLength === length && (!point || bytes[0] === 0x04);
  } catch {
    return false;
  }
}

export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
};

/**
 * Registers this browser's push subscription for `userId`. Idempotent per endpoint; an endpoint
 * another user registered moves to the caller, because a browser profile receives pushes for
 * whoever signed in last. At most 20 per user, under a per-user lock so parallel registrations
 * cannot pass the cap.
 *
 * @returns the subscription's id, so the client can name "this device".
 */
export async function subscribePush(
  db: Database,
  userId: string,
  input: PushSubscriptionInput,
): Promise<string> {
  if (!isAllowedPushEndpoint(input.endpoint)) {
    throw new AppError("BAD_REQUEST", "This browser's push service is not supported.");
  }
  // The keys every payload is encrypted to (RFC 8291 §3): a P-256 point and a 16-byte secret.
  if (!validKey(input.p256dh, 65, true) || !validKey(input.auth, 16)) {
    throw new AppError("BAD_REQUEST", "Invalid push subscription.");
  }
  const label = input.label.trim().slice(0, MAX_LABEL_LENGTH) || "Browser";
  const fields = { userId, p256dh: input.p256dh, auth: input.auth, label };

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`notifications:push:${userId}`}, 0))`,
    );
    const [existing] = await tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, input.endpoint));
    if (!existing) {
      const owned = await tx
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId))
        .limit(MAX_SUBSCRIPTIONS_PER_USER);
      if (owned.length >= MAX_SUBSCRIPTIONS_PER_USER) {
        throw new AppError(
          "BAD_REQUEST",
          "Too many devices. Remove one in Settings > Notifications first.",
        );
      }
    }
    // The endpoint may be registered concurrently by another user (another lock); the unique
    // endpoint makes that an update.
    const [row] = await tx
      .insert(pushSubscriptions)
      .values({ ...fields, endpoint: input.endpoint })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: fields })
      .returning({ id: pushSubscriptions.id });
    return row!.id;
  });
}

/** Removes one of the caller's devices, by id from `listDevices` or by this browser's endpoint. */
export async function unsubscribePush(
  db: Database,
  userId: string,
  input: { device?: string; endpoint?: string },
) {
  const target = input.device
    ? eq(pushSubscriptions.id, input.device)
    : input.endpoint
      ? eq(pushSubscriptions.endpoint, input.endpoint)
      : undefined;
  if (!target) return;
  await db.delete(pushSubscriptions).where(and(target, eq(pushSubscriptions.userId, userId)));
}

/**
 * The caller's subscribed browsers, newest first, without endpoints or keys. `endpoint` is the
 * asking browser's own subscription, so its row can be marked as this device.
 */
export async function listPushDevices(db: Database, userId: string, endpoint?: string) {
  const rows = await db
    .select({
      id: pushSubscriptions.id,
      label: pushSubscriptions.label,
      endpoint: pushSubscriptions.endpoint,
      createdAt: pushSubscriptions.createdAt,
      lastDeliveredAt: pushSubscriptions.lastDeliveredAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
    .limit(MAX_SUBSCRIPTIONS_PER_USER);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.getTime(),
    lastDeliveredAt: row.lastDeliveredAt?.getTime() ?? null,
    current: endpoint !== undefined && row.endpoint === endpoint,
  }));
}

// Session outcomes are stale within the hour; limit events stay useful for half a day.
function pushTtlSeconds(kind: NotificationKind) {
  return notificationCategory(kind) === "limits" ? 12 * 60 * 60 : 60 * 60;
}

type PushedNotification = {
  id: string;
  userId: string;
  workspace: string | null;
  kind: NotificationKind;
  chat: string | null;
  sealedKeyId: string | null;
  sealedBox: Uint8Array | null;
};

/**
 * The push payload: routing metadata and the sealed box, never title or body plaintext beyond the
 * generic text of the kind (historical rows may hold plaintext, so their sidecar is not sent).
 * The service worker opens the box with the recipient's remembered keys.
 */
export function pushPayload(row: PushedNotification) {
  return JSON.stringify({
    id: row.id,
    kind: row.kind,
    category: notificationCategory(row.kind),
    userId: row.userId,
    ...(row.sealedKeyId && row.sealedBox
      ? { sealed: { keyId: row.sealedKeyId, box: toBase64Url(row.sealedBox) } }
      : {}),
    title: notificationTitle(row.kind),
    body: row.chat ? "Session" : "Workspace",
    path: notificationPath({ chat: row.chat ?? undefined }),
    ...(row.workspace ? { workspace: row.workspace } : {}),
  });
}

const fallbackPayload = z.object({ notification: z.string() });

/**
 * Outbox handler of `notifications.fallback`, due 10 s after the notification was created. An
 * unclaimed notification is marked delivered and sent to every subscribed browser of its user;
 * a claimed one (an open tab already alerted) stops here, so nothing rings twice. The mark is a
 * conditional update that requires `seen_at` unset, and a claim requires `delivery_at` unset, so
 * exactly one of them wins. Without VAPID keys or devices nothing is marked and a late tab can
 * still claim.
 *
 * Marking commits before sending, so a retry (or a runner that died mid-send) never pushes twice;
 * push failures other than an expired subscription are logged and not retried.
 */
export async function runFallbackJob(runtime: Runtime, payload: unknown) {
  const { db } = runtime.drivers;
  const { notification } = fallbackPayload.parse(payload);
  const config = webPushConfig(runtime.config);
  if (!config) return;

  const [owner] = await db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.id, notification));
  if (!owner) return;
  const devices = await db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, owner.userId))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
    .limit(MAX_SUBSCRIPTIONS_PER_USER);
  if (devices.length === 0) return;

  const [marked] = await db
    .update(notifications)
    .set({
      deliveryChannel: "web_push",
      deliveryAt: sql`now()`,
      deliveryDevices: devices.length,
    })
    .where(
      and(
        eq(notifications.id, notification),
        isNull(notifications.seenAt),
        isNull(notifications.deliveryAt),
      ),
    )
    .returning({
      id: notifications.id,
      userId: notifications.userId,
      workspace: notifications.workspace,
      kind: notifications.kind,
      chat: notifications.chat,
      sealedKeyId: notifications.sealedKeyId,
      sealedBox: notifications.sealedBox,
    });
  if (!marked) return;

  const message = pushPayload(marked);
  const ttl = pushTtlSeconds(marked.kind);
  const urgency = notificationCategory(marked.kind) === "limits" ? "normal" : "high";
  const results = await Promise.all(
    devices.map((device) => sendPush(runtime, config, device, message, ttl, urgency)),
  );
  const delivered = devices.filter((_, index) => results[index] === "delivered");
  const expired = devices.filter((_, index) => results[index] === "expired");

  if (delivered.length > 0) {
    await db
      .update(pushSubscriptions)
      .set({ lastDeliveredAt: sql`now()` })
      .where(
        inArray(
          pushSubscriptions.id,
          delivered.map((device) => device.id),
        ),
      );
  }
  if (expired.length > 0) {
    // Only the subscription that was sent to: an endpoint re-registered in the meantime (new
    // keys, perhaps another user) stays.
    await db
      .delete(pushSubscriptions)
      .where(
        or(
          ...expired.map((device) =>
            and(
              eq(pushSubscriptions.id, device.id),
              eq(pushSubscriptions.p256dh, device.p256dh),
              eq(pushSubscriptions.auth, device.auth),
            ),
          ),
        ),
      );
  }
  await db
    .update(notifications)
    .set({ deliveryDelivered: delivered.length })
    .where(eq(notifications.id, notification));
}

type PushOutcome = "delivered" | "expired" | "failed";

/** Sends one encrypted push; 404/410 mean the browser dropped the subscription. */
async function sendPush(
  runtime: Runtime,
  config: WebPushConfig,
  device: { endpoint: string; p256dh: string; auth: string },
  message: string,
  ttl: number,
  urgency: "normal" | "high",
): Promise<PushOutcome> {
  let status: number | null = null;
  try {
    const request = await buildPushPayload(
      { data: message, options: { ttl, urgency } },
      {
        endpoint: device.endpoint,
        expirationTime: null,
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
      config,
    );
    const response = await runtime.fetch(device.endpoint, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    status = response.status;
    if (response.ok) return "delivered";
    if (status === 404 || status === 410) return "expired";
  } catch {
    // Network failure, timeout or an unusable subscription key; logged below.
  }
  logger.warn("notifications.web_push_failed", { metadata: { status } });
  return "failed";
}
