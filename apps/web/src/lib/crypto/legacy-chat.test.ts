import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { FileUIPart, UIMessage } from "ai";
import type { ConvexReactClient } from "convex/react";
import type { Id } from "backend/convex/_generated/dataModel";
import type { LegacyBox } from "backend/src/e2ee/legacy-contract";
import { toBase64Url } from "radium-crypto";
import * as chatContent from "./chat-content";
import * as chatKeys from "./chat-keys";
import * as legacyContent from "./legacy-content";
import { configureCryptoClient } from "./runtime";
import {
  ChatKeysRequiredError,
  openHistoricalChat,
  openHistoricalFile,
  reencryptMessageFiles,
  requireChatKeys,
} from "./legacy-chat";

const chatId = "chat" as Id<"aisdk_chats">;
const workspaceId = "workspace" as Id<"workspaces">;
const box = (name: string) =>
  ({ kind: "identity", keyId: name, epoch: 1, box: new ArrayBuffer(1) }) as LegacyBox;
const key = { workspaceId, e2eeId: "e2ee", epoch: 1, publicKey: new Uint8Array(32) };

const historicalRows = new Map<string, { recordId: string; legacyContent: LegacyBox } | null>();
const queries: unknown[] = [];
beforeAll(() => {
  configureCryptoClient({
    query: async (_fn: unknown, args: { url: string }) => {
      queries.push(args.url);
      return historicalRows.get(args.url) ?? null;
    },
    mutation: async () => null,
  } as unknown as ConvexReactClient);
});
afterEach(() => {
  historicalRows.clear();
  queries.length = 0;
});

function opened(byBox: Record<string, unknown>) {
  return spyOn(legacyContent, "openLegacyContent").mockImplementation((async (sealed: LegacyBox) => {
    const value = byBox[sealed.keyId];
    if (value instanceof Error) throw value;
    return value;
  }) as typeof legacyContent.openLegacyContent);
}

describe("historical chat content", () => {
  test("embedded history, queue, title and emoji come from the chat sidecar", async () => {
    const queue = { text: "hi", files: [], model: "m", webSearch: false };
    opened({ chat: { messages: [{ id: "a", role: "user", parts: [] }, { role: "user", parts: [] }], messages_queue: queue, title: "T", emoji: "🔒" } });
    const result = await openHistoricalChat(
      { chatId, workspaceId, legacyContent: box("chat"), wants: { title: true, queue: true } },
      [],
    );
    expect(result.entries.map((entry) => [entry.position, entry.messageId])).toEqual([[0, "a"], [1, undefined]]);
    expect(result.queue).toEqual(queue);
    expect(result.title).toEqual({ title: "T", emoji: "🔒" });
  });

  test("row sidecars keep message IDs and revisions; sealed rows are never reopened", async () => {
    // An unneeded chat sidecar would reject here, so success proves it was not required.
    opened({
      chat: new Error("chat sidecar not needed"),
      stale: new Error("superseded sidecar not needed"),
      row: { message: { id: "old", role: "user", parts: [] } },
    });
    const sealed = { capsuleId: "c", envelope: new ArrayBuffer(1) };
    const result = await openHistoricalChat(
      { chatId, workspaceId, legacyContent: box("chat"), wants: { title: false, queue: false } },
      [
        { position: 0, messageId: "old", revision: 3, recordId: "r0", legacyContent: box("row") },
        { position: 1, messageId: "native", revision: 2, sealed, recordId: "r1", legacyContent: box("stale") },
      ],
    );
    expect(result.entries[0]).toMatchObject({ position: 0, messageId: "old", revision: 3, message: { id: "old" } });
    expect(result.entries[1]).toEqual({ position: 1, messageId: "native", revision: 2, sealed });
  });

  test("a failed request's error text is restored from the chat sidecar only when wanted", async () => {
    opened({ chat: { interruptionMessage: "Quota exceeded" } });
    const entries = [{ position: 0, messageId: "n", revision: 1, sealed: { capsuleId: "c", envelope: new ArrayBuffer(1) } }];
    const wanted = await openHistoricalChat(
      { chatId, workspaceId, legacyContent: box("chat"), wants: { title: false, queue: false, interruption: true } },
      entries,
    );
    expect(wanted.interruptionMessage).toBe("Quota exceeded");
    expect(wanted.entries).toEqual(entries);
    const unwanted = await openHistoricalChat(
      { chatId, workspaceId, legacyContent: box("chat"), wants: { title: false, queue: false } },
      entries,
    );
    expect(unwanted.interruptionMessage).toBeUndefined();
  });

  test("custody and malformed sidecars reject instead of showing partial history", async () => {
    // Meeting custody first asks for a key it can be released to; the read still reports custody.
    const prepare = spyOn(chatKeys, "prepareCustodyRelease").mockResolvedValue(true);
    opened({ chat: new legacyContent.CustodialContentError() });
    await expect(
      openHistoricalChat({ chatId, workspaceId, legacyContent: box("chat"), wants: { title: true, queue: false } }, []),
    ).rejects.toBeInstanceOf(legacyContent.CustodialContentError);
    expect(prepare).toHaveBeenCalledWith(chatId);
    prepare.mockRestore();
    opened({ chat: { messages: "nope" } });
    await expect(
      openHistoricalChat({ chatId, workspaceId, legacyContent: box("chat"), wants: { title: false, queue: false } }, []),
    ).rejects.toThrow();
    opened({ row: {} });
    await expect(
      openHistoricalChat({ chatId, workspaceId, wants: { title: false, queue: false } }, [
        { position: 0, recordId: "r", legacyContent: box("row") },
      ]),
    ).rejects.toThrow();
  });
});

describe("historical attachments", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const file = (size = 3) => ({
    filename: "a.txt", mediaType: "text/plain", size, fileBytes: toBase64Url(bytes),
  });

  test("restores bytes from the sidecar and checks their size; unknown URLs are not historical", async () => {
    historicalRows.set("https://files/a", { recordId: "f1", legacyContent: box("file") });
    opened({ file: file() });
    const restored = await openHistoricalFile(chatId, workspaceId, "https://files/a");
    expect(new Uint8Array(await restored!.blob.arrayBuffer())).toEqual(bytes);
    expect(restored).toMatchObject({ filename: "a.txt", mediaType: "text/plain" });
    expect(await openHistoricalFile(chatId, workspaceId, "https://files/none")).toBeNull();

    opened({ file: file(99) });
    await expect(openHistoricalFile(chatId, workspaceId, "https://files/a")).rejects.toThrow();
  });

  test("a historical attachment is re-uploaded once under the chat key and its message revision dropped", async () => {
    historicalRows.set("https://files/b", { recordId: "f2", legacyContent: box("file") });
    opened({ file: file() });
    const native: FileUIPart = { type: "file", url: "https://files/new#rf1.x", mediaType: "text/plain" };
    const upload = spyOn(chatContent, "uploadEncryptedFile").mockResolvedValue(native);
    const message = (id: string, url: string): UIMessage => ({
      id, role: "user", parts: [{ type: "file", url, mediaType: "text/plain" }],
    });
    const messages = [message("m1", "https://files/b"), message("m2", "data:text/plain;base64,AA==")];

    const result = await reencryptMessageFiles(messages, { chatId, workspaceId, key });
    expect(result.messages[0]!.parts[0]).toEqual(native);
    expect(result.messages[1]).toBe(messages[1]!);
    expect([...result.changed]).toEqual(["m1"]);

    // A later send of the same history reuses the native copy instead of uploading again.
    await reencryptMessageFiles(messages, { chatId, workspaceId, key });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(queries).not.toContain("data:text/plain;base64,AA==");
    upload.mockRestore();
  });

  test("without a chat key a historical attachment blocks instead of being dropped", async () => {
    historicalRows.set("https://files/c", { recordId: "f3", legacyContent: box("file") });
    opened({ file: file() });
    await expect(
      reencryptMessageFiles(
        [{ id: "m", role: "user", parts: [{ type: "file", url: "https://files/c", mediaType: "text/plain" }] }],
        { chatId, workspaceId },
      ),
    ).rejects.toBeInstanceOf(ChatKeysRequiredError);
  });
});

describe("keyless chats", () => {
  test("a write requires keys and never falls back when key setup is unavailable", async () => {
    const ensure = spyOn(chatKeys, "ensureChatKeys").mockResolvedValue(false);
    await expect(requireChatKeys(chatId)).rejects.toBeInstanceOf(ChatKeysRequiredError);
    ensure.mockResolvedValue(true);
    await expect(requireChatKeys(chatId)).resolves.toBeUndefined();
  });
});
