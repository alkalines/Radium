import { and, eq } from "drizzle-orm";
import { notificationCategory, type NotificationKind } from "contracts/notifications/contract";
import type { Database } from "../drivers/types";
import { e2eeIdentities } from "../e2ee/schema";
import { enqueueJob } from "../jobs/outbox";
import { notificationPreferences } from "../workspaces/preferences";
import { notifications, pushSubscriptions } from "./schema";

/**
 * How long open browser tabs have to claim a notification before it falls back to push. Tabs
 * see it on their next `notifications.recent` read; the margin covers a busy client.
 */
export const BROWSER_CLAIM_GRACE_MS = 10_000;

/** Outbox job: seal a notification's title and body to the recipient (`./sealing.ts`). */
export const SEAL_JOB = "notifications.seal";
/** Outbox job: push an unclaimed notification to the recipient's browsers (`./push.ts`). */
export const FALLBACK_JOB = "notifications.fallback";

/** What a producer says happened; the row carries no text, clients render the generic text of `kind`. */
export type NotificationInput = {
  userId: string;
  workspace?: string;
  kind: NotificationKind;
  /** The chat a session notification opens; set for session kinds only. */
  chat?: string;
  /** The limit event of a limit notification; set for limit kinds only. */
  limitEvent?: string;
  createdAt?: Date;
};

/**
 * Creates one notification for `userId`, the single write path of every producer (Chatroom run
 * ends, ACP turns, limit events), so the channel order lives in one place:
 *
 * 1. **Open browser tab.** Every open tab of the user reads the row through
 *    `notifications.recent` and shows a toast; the first to `notifications.claim` it plays the
 *    sound and, in a background tab, shows the system notification. A claim stops the fallback.
 * 2. **Desktop push.** {@link FALLBACK_JOB} runs {@link BROWSER_CLAIM_GRACE_MS} later and sends an
 *    unclaimed notification to the user's subscribed browsers.
 *
 * With an active identity, {@link SEAL_JOB} seals the detail (chat title, limit credential) to the
 * recipient; until then, and without an identity, the row shows the generic text of its kind.
 * Pass the producer's transaction as `db`, so the row and its jobs exist exactly when the chat or
 * limit event they point at does, and collect the job ids in `jobs` to hand them to
 * `dispatchJobs` after commit (the one-minute sweep runs them otherwise).
 *
 * Writes nothing when the user switched the notification's category off.
 *
 * @returns the new notification's id, or `null` when the category is off.
 */
export async function notify(
  db: Database,
  input: NotificationInput,
  jobs?: (string | null)[],
): Promise<string | null> {
  const preferences = await notificationPreferences(db, input.userId);
  if (!preferences[notificationCategory(input.kind)].enabled) {
    return null;
  }

  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      workspace: input.workspace ?? null,
      kind: input.kind,
      chat: input.chat ?? null,
      limitEvent: input.limitEvent ?? null,
      createdAt: input.createdAt,
    })
    .returning({ id: notifications.id });
  const id = row!.id;
  const payload = { notification: id };

  // Only queue work that can do something: a key to seal to, a device to push to. (Convex always
  // scheduled the fallback, so a device registered during the 10 s grace also got the push.)
  const [identity] = await db
    .select({ id: e2eeIdentities.id })
    .from(e2eeIdentities)
    .where(and(eq(e2eeIdentities.userId, input.userId), eq(e2eeIdentities.status, "active")))
    .limit(1);
  if (identity) {
    const job = await enqueueJob(db, { kind: SEAL_JOB, payload });
    jobs?.push(job);
  }
  const [device] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, input.userId))
    .limit(1);
  if (device) {
    const job = await enqueueJob(db, {
      kind: FALLBACK_JOB,
      payload,
      runAt: new Date(Date.now() + BROWSER_CLAIM_GRACE_MS),
    });
    jobs?.push(job);
  }
  return id;
}
