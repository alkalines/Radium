import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { toBase64Url } from "radium-crypto";
import {
  notificationCategory,
  notificationPath,
  notificationTitle,
} from "contracts/notifications/contract";
import type { Database } from "../drivers/types";
import { notifications } from "./schema";

/**
 * Browser side of delivery (Convex `src/notifications/inbox.ts`): the list open tabs read, the
 * claim that makes one tab (and so one device) responsible for the sound and system
 * notification, and retention.
 */

/** Notifications each open tab reads. Tabs only act on rows that appear after they loaded. */
const RECENT_LIMIT = 20;

/**
 * A tab that reconnects after a long sleep must not ring for old news; it still shows the toast.
 * Longer than the 10 s push grace, so a slow tab can still claim before the fallback runs.
 */
const CLAIM_WINDOW_MS = 5 * 60 * 1000;

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The user's newest notifications, newest first. Title and body are the generic text of the
 * kind; the detail is in `sealed` (or a historical `legacyContent` sidecar), which only the
 * recipient's device opens. Historical plaintext never reaches the client.
 */
export async function recentNotifications(db: Database, userId: string) {
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      userId: notifications.userId,
      sealedKeyId: notifications.sealedKeyId,
      sealedBox: notifications.sealedBox,
      legacyContent: notifications.legacyContent,
      workspace: notifications.workspace,
      chat: notifications.chat,
      createdAt: notifications.createdAt,
      seenAt: notifications.seenAt,
      deliveryAt: notifications.deliveryAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(RECENT_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    category: notificationCategory(row.kind),
    userId: row.userId,
    sealed:
      row.sealedKeyId !== null && row.sealedBox !== null
        ? { keyId: row.sealedKeyId, box: toBase64Url(row.sealedBox) }
        : null,
    legacyContent: row.legacyContent,
    title: notificationTitle(row.kind),
    body: row.chat ? "Session" : "Workspace",
    /** App-relative path the notification opens. */
    path: notificationPath({ chat: row.chat ?? undefined }),
    workspace: row.workspace,
    chat: row.chat,
    createdAt: row.createdAt.getTime(),
    /** Some tab already claimed it (played the sound, showed the system notification). */
    claimed: row.seenAt !== null,
    /** It went to the user's devices because no tab claimed it in time. */
    pushed: row.deliveryAt !== null,
  }));
}

/**
 * Claims a notification for the calling tab. Exactly one caller gets `true`, and only while the
 * notification is the caller's, fresh, and neither claimed nor pushed; that caller plays the
 * sound and shows the system notification. One conditional update decides it, against other tabs
 * and against the push fallback (which requires `seen_at` unset in the same way).
 */
export async function claimNotification(
  db: Database,
  userId: string,
  notification: string,
): Promise<boolean> {
  const claimed = await db
    .update(notifications)
    .set({ seenAt: sql`now()` })
    .where(
      and(
        eq(notifications.id, notification),
        eq(notifications.userId, userId),
        isNull(notifications.seenAt),
        isNull(notifications.deliveryAt),
        gt(notifications.createdAt, sql`now() - ${`${CLAIM_WINDOW_MS} milliseconds`}::interval`),
      ),
    )
    .returning({ id: notifications.id });
  return claimed.length > 0;
}

/**
 * Deletes notifications older than 7 days, at most `batch` per call (the `retention` task).
 *
 * @returns how many were deleted.
 */
export async function pruneNotifications(
  db: Database,
  now: number,
  batch: number,
): Promise<number> {
  const expired = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(lt(notifications.createdAt, new Date(now - RETENTION_MS)))
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(batch);
  const deleted = await db
    .delete(notifications)
    .where(inArray(notifications.id, expired))
    .returning({ id: notifications.id });
  return deleted.length;
}
