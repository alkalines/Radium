import { openBox } from "radium-crypto";
import { notificationAad } from "backend/src/notifications/contract";
import type { LegacyBox } from "backend/src/e2ee/legacy-contract";
import type { Id } from "backend/convex/_generated/dataModel";
import { openLegacyContent } from "./legacy-content";
import { keyManager, useRememberedIdentity } from "./key-manager";

type SealedNotification = {
  _id: string;
  userId: string;
  workspace?: string;
  sealed?: { keyId: string; box: ArrayBuffer };
  legacyContent?: LegacyBox;
};

/** Authenticate and parse notification content; never return partial or malformed plaintext. */
export async function openNotificationBox(
  notification: SealedNotification,
  seed: Uint8Array,
): Promise<{ title: string; body: string } | null> {
  if (!notification.sealed) return null;
  try {
    const plaintext = await openBox({
      seed,
      box: new Uint8Array(notification.sealed.box),
      aad: notificationAad(notification.userId, notification.workspace, notification._id),
      pad: "short",
    });
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (!value || typeof value !== "object") return null;
      const content = value as Record<string, unknown>;
      return typeof content.title === "string" && typeof content.body === "string"
        ? { title: content.title, body: content.body } : null;
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return null;
  }
}

/** Opens one authenticated notification; malformed or unavailable content stays generic. */
export async function openNotification(
  notification: SealedNotification,
  remembered = false,
): Promise<{ title: string; body: string } | null> {
  if (!notification.sealed && notification.legacyContent) {
    const legacy = notification.legacyContent;
    if (remembered || legacy.kind !== "identity") return null;
    const before = keyManager.getSnapshot();
    if (before.state !== "unlocked" || before.userId !== notification.userId || before.keyId !== legacy.keyId) return null;
    try {
      // Identity boxes never use a workspace key; the id only binds the AAD string.
      const value = await openLegacyContent<unknown>(legacy, {
        table: "notifications", record: notification._id, workspace: notification.workspace as Id<"workspaces"> | undefined,
      });
      const after = keyManager.getSnapshot();
      if (after.state !== "unlocked" || after.userId !== before.userId || after.keyId !== before.keyId ||
          !value || typeof value !== "object") return null;
      const content = value as Record<string, unknown>;
      return typeof content.title === "string" && typeof content.body === "string"
        ? { title: content.title, body: content.body } : null;
    } catch {
      return null;
    }
  }
  const sealed = notification.sealed;
  if (!sealed) return null;
  try {
    const open = (identity: { encryption: { seed: Uint8Array } }) =>
      openNotificationBox(notification, identity.encryption.seed);
    if (remembered) return await useRememberedIdentity(notification.userId, sealed.keyId, open);
    const before = keyManager.getSnapshot();
    if (before.state !== "unlocked" || before.userId !== notification.userId || before.keyId !== sealed.keyId) return null;
    const content = await keyManager.useAmk(async (_, identity) => open(identity));
    const after = keyManager.getSnapshot();
    return after.state === "unlocked" && after.userId === before.userId && after.keyId === before.keyId
      ? content : null;
  } catch {
    return null;
  }
}
