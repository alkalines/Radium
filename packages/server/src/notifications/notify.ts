import { notificationCategory, type NotificationKind } from "contracts/notifications/contract";
import type { Database } from "../drivers/types";
import { notificationPreferences } from "../workspaces/preferences";
import { notifications } from "./schema";

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
 * ends, limit events). Open browser tabs see the row and claim it (`seen_at`). Pass the
 * producer's transaction as `db` so the row exists exactly when the chat or limit event it points
 * at does.
 *
 * Writes nothing when the user switched the notification's category off.
 *
 * Not written yet: sealing the box to the recipient's identity key and the Web Push fallback
 * for notifications no tab claimed within 10 s (both are the notifications slice); until then a
 * row is shown as the generic notification and never pushed.
 *
 * @returns the new notification's id, or `null` when the category is off.
 */
export async function notify(db: Database, input: NotificationInput): Promise<string | null> {
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
  return row!.id;
}
