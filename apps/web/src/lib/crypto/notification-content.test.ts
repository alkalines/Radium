import { describe, expect, test } from "bun:test";
import { generateEncryptionKeyPair, sealBox, toBase64Url, utf8 } from "radium-crypto";
import { notificationAad } from "contracts/notifications/contract";
import { openNotificationBox } from "./notification-content";

describe("notification content", () => {
  test("opens only for the recipient and authenticated row, workspace and user", async () => {
    const recipient = await generateEncryptionKeyPair();
    const other = await generateEncryptionKeyPair();
    const notification = { id: "notification-1", userId: "alice", workspace: "workspace-1" };
    const box = await sealBox({
      recipientPublicKey: recipient.publicKey,
      plaintext: utf8(JSON.stringify({ title: "Finished", body: "Private title" })),
      aad: notificationAad(notification.userId, notification.workspace, notification.id),
      pad: "short",
    });
    const sealed = { ...notification, sealed: { keyId: "key-1", box: toBase64Url(box) } };
    expect(await openNotificationBox(sealed, recipient.seed)).toEqual({ title: "Finished", body: "Private title" });
    expect(await openNotificationBox(sealed, other.seed)).toBeNull();
    expect(await openNotificationBox({ ...sealed, userId: "bob" }, recipient.seed)).toBeNull();
    expect(await openNotificationBox({ ...sealed, workspace: "workspace-2" }, recipient.seed)).toBeNull();
    expect(await openNotificationBox({ ...sealed, id: "notification-2" }, recipient.seed)).toBeNull();
    const damaged = box.slice();
    damaged[damaged.length - 1] ^= 1;
    expect(await openNotificationBox({ ...sealed, sealed: { ...sealed.sealed, box: toBase64Url(damaged) } }, recipient.seed)).toBeNull();
  });
});
