import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Id } from "backend/convex/_generated/dataModel";
import { generateEncryptionKeyPair, randomBytes, toBase64Url } from "radium-crypto";
import {
  decryptFileUrl,
  encryptFile,
  fileUrlWithKey,
  openMessages,
  openQueue,
  openTitle,
  parseFileFragment,
  sealMessagesForFork,
  sealQueue,
  sealTitle,
  type ChatContentKey,
  type ChatQueue,
} from "./chat-content";

const workspaceId = "workspace-test" as Id<"workspaces">;
async function context() {
  const key = await generateEncryptionKeyPair();
  return {
    ...key,
    e2eeId: toBase64Url(randomBytes(16)),
    epoch: 1,
    workspaceId,
  } satisfies ChatContentKey & { seed: Uint8Array };
}

describe("sealed chat content", () => {
  test("opens capsule batches and preserves revisions and plaintext migration entries", async () => {
    const chat = await context();
    const messages: UIMessage[] = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "Private prompt" }] },
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Private answer" }] },
    ];
    const sealed = await sealMessagesForFork(messages, chat);
    expect(sealed.capsules).toHaveLength(1);
    const entries = sealed.messages.map((row, position) => ({
      position,
      messageId: row.messageId,
      revision: 1,
      sealed: { capsuleId: row.capsuleId, envelope: row.envelope },
    }));
    const opened = await openMessages(entries, sealed.capsules, chat);
    expect(opened.messages).toEqual(messages);
    expect(opened.revisions).toEqual({ "user-1": 1, "assistant-1": 1 });
    const legacy: UIMessage = { id: "legacy", role: "user", parts: [] };
    expect((await openMessages([{ position: 0, message: legacy }], [], chat)).messages).toEqual([
      legacy,
    ]);
    const legacyWithoutId = await openMessages(
      [{ position: 4, message: { role: "user", parts: [] } }],
      [],
      chat,
    );
    expect(legacyWithoutId.messages[0]?.id).toBe(`${chat.e2eeId}:legacy:4`);
    const tampered = sealed.capsules.map((row) => {
      const capsule = row.capsule.slice(0);
      new Uint8Array(capsule)[40] ^= 1;
      return { ...row, capsule };
    });
    await expect(openMessages(entries, tampered, chat)).rejects.toThrow();
    await expect(
      openMessages(entries, sealed.capsules, { ...chat, e2eeId: toBase64Url(randomBytes(16)) }),
    ).rejects.toThrow();
    await expect(openMessages(entries, [], chat)).rejects.toThrow();
  });

  test("title and queued prompt boxes round trip and reject a different chat", async () => {
    const chat = await context();
    const title = { title: "Private title", emoji: "R" };
    const titleBox = await sealTitle(title, chat);
    expect(await openTitle(titleBox, chat)).toEqual(title);
    const queue: ChatQueue = {
      text: "Private queued prompt",
      model: "test-model",
      files: [],
      webSearch: false,
    };
    const queueBox = await sealQueue(queue, chat);
    expect(await openQueue(queueBox, chat)).toEqual(queue);
    const otherChat = { ...chat, e2eeId: toBase64Url(randomBytes(16)) };
    await expect(openTitle(titleBox, otherChat)).rejects.toThrow();
    await expect(openQueue(queueBox, otherChat)).rejects.toThrow();
  });

  test("encrypted file fragment opens downloaded bytes without sending the fragment", async () => {
    const chat = await context();
    const source = new Blob(["private attachment\u0000bytes"], { type: "text/plain" });
    const encrypted = await encryptFile(source, chat);
    expect(encrypted.body.type).toBe("application/octet-stream");
    expect(encrypted.register).not.toHaveProperty("filename");
    const storageUrl = URL.createObjectURL(encrypted.body);
    try {
      const url = fileUrlWithKey(storageUrl, encrypted.fileId, chat.e2eeId, encrypted.objectKey);
      expect(parseFileFragment(url)?.storageUrl).toBe(storageUrl);
      expect(parseFileFragment(url)?.objectKey).toEqual(encrypted.objectKey);
      expect(await (await decryptFileUrl(url, workspaceId)).text()).toBe(await source.text());
      const wrongChat = fileUrlWithKey(
        storageUrl,
        encrypted.fileId,
        toBase64Url(randomBytes(16)),
        encrypted.objectKey,
      );
      await expect(decryptFileUrl(wrongChat, workspaceId)).rejects.toThrow();
      await expect(decryptFileUrl(url, "other-workspace" as Id<"workspaces">)).rejects.toThrow();
      expect(() => parseFileFragment(`${storageUrl}#rf1.invalid`)).toThrow();
    } finally {
      encrypted.objectKey.fill(0);
      URL.revokeObjectURL(storageUrl);
    }
  });
});
