import { and, eq, isNull, sql } from "drizzle-orm";
import { sealBox, utf8 } from "radium-crypto";
import { z } from "zod";
import {
  limitNotificationBody,
  notificationAad,
  notificationTitle,
} from "contracts/notifications/contract";
import { chats } from "../chatroom/schema";
import { e2eeIdentities } from "../e2ee/schema";
import { limitEvents } from "../gateway/schema";
import type { Runtime } from "../runtime";
import { notifications } from "./schema";

/**
 * Sealing of a notification's detail to its recipient (Convex `src/notifications/sealing.ts`).
 * The outbox job carries only the notification id; the content is loaded here, so no plaintext
 * ever sits in a job payload. A row that has a native box or a historical sidecar is never sealed
 * again: a box is opaque and must stay byte-identical, and readers prefer the box, so a new box
 * beside a sidecar would shadow its content. Every failure leaves the generic notification, never
 * a plaintext fallback.
 */

const sealPayload = z.object({ notification: z.string() });

/** The bounded plaintext sealed into a notification box. */
export type NotificationContent = { title: string; body: string };

/** Outbox handler of `notifications.seal`; idempotent. */
export async function runSealJob(runtime: Runtime, payload: unknown) {
  const { db } = runtime.drivers;
  const { notification } = sealPayload.parse(payload);
  const [row] = await db
    .select({
      userId: notifications.userId,
      workspace: notifications.workspace,
      kind: notifications.kind,
      hasBox: sql<boolean>`${notifications.sealedBox} is not null`,
      hasLegacy: sql<boolean>`${notifications.legacyContent} is not null`,
      chatId: chats.id,
      chatKeyed: sql<boolean>`${chats.e2eeId} is not null or ${chats.legacyContent} is not null`,
      chatTitle: chats.title,
      credentialName: limitEvents.credentialName,
      providerName: limitEvents.providerName,
      meter: limitEvents.meter,
      keyId: e2eeIdentities.keyId,
      publicKey: e2eeIdentities.encryptionPublicKey,
    })
    .from(notifications)
    .leftJoin(chats, eq(chats.id, notifications.chat))
    .leftJoin(limitEvents, eq(limitEvents.id, notifications.limitEvent))
    .leftJoin(
      e2eeIdentities,
      and(eq(e2eeIdentities.userId, notifications.userId), eq(e2eeIdentities.status, "active")),
    )
    .where(eq(notifications.id, notification));
  if (!row || row.hasBox || row.hasLegacy || row.keyId === null || row.publicKey === null) {
    return;
  }

  // A keyed chat's title is unavailable to the server, and a title moved into a migration
  // sidecar is no longer readable here; neither may be mistaken for a legacy title. Limit detail
  // comes from the owner's limit event, so notifications never store it.
  const body =
    row.chatId !== null
      ? row.chatKeyed
        ? "Session"
        : row.chatTitle?.trim() || "Untitled session"
      : row.credentialName !== null && row.providerName !== null
        ? limitNotificationBody({
            credential: row.credentialName,
            provider: row.providerName,
            meter: row.meter?.label,
          })
        : "Workspace";
  const content: NotificationContent = {
    title: notificationTitle(row.kind).slice(0, 80),
    body: body.slice(0, 160),
  };

  let box: Uint8Array;
  try {
    box = await sealBox({
      recipientPublicKey: row.publicKey,
      plaintext: utf8(JSON.stringify(content)),
      aad: notificationAad(row.userId, row.workspace ?? undefined, notification),
      pad: "short",
    });
  } catch {
    // An unusable recipient key leaves the generic notification; retrying cannot fix it.
    console.error("notifications: sealing failed");
    return;
  }

  // Stored only while the recipient's active identity is still the one sealed to, and the row
  // still has neither a box nor historical content (a rotation or a concurrent run in between
  // stores nothing).
  await db
    .update(notifications)
    .set({ sealedKeyId: row.keyId, sealedBox: box })
    .where(
      and(
        eq(notifications.id, notification),
        isNull(notifications.sealedBox),
        isNull(notifications.legacyContent),
        sql`exists (select 1 from ${e2eeIdentities} where ${e2eeIdentities.userId} = ${notifications.userId} and ${e2eeIdentities.status} = 'active' and ${e2eeIdentities.keyId} = ${row.keyId})`,
      ),
    );
}
