import { beforeEach, describe, expect, test, vi } from "vitest";
import type { QueryCtx } from "../../convex/_generated/server";

const recipient = { kind: "chat", keyId: "key", epoch: 2, publicKey: new ArrayBuffer(32) };
const activeLegacyRecipient = vi.hoisted(() => vi.fn());
vi.mock("../../convex/workspaces", () => ({
  resolveWorkspaceForChat: async () => ({ _id: "workspace" }),
}));
vi.mock("./legacy-crypto", () => ({ activeLegacyRecipient }));

import { domain } from "./migration-chat";

const parent = { _id: "chat", userId: "owner", workspace: "workspace" };
const ctx = {
  db: {
    get: async (table: string) => (table === "aisdk_chats" ? parent : { _id: "workspace" }),
  },
} as unknown as QueryCtx;

beforeEach(() => activeLegacyRecipient.mockReset().mockResolvedValue(recipient));

describe("chat legacy extraction", () => {
  test("extracts only plaintext and preserves native ciphertext, IDs and revisions", async () => {
    const sealed = { capsuleId: "capsule", envelope: new Uint8Array([1, 2]).buffer };
    const message = { id: "old", role: "user", parts: [] };
    const row = { _id: "row", chat: "chat", message, sealed, messageId: "old", revision: 4 };
    const result = await domain.inspect(ctx, "chat_messages", row);
    // A mixed row seals only its plaintext; readers prefer the untouched native envelope.
    expect(result?.value).toEqual({ message });
    expect(result?.patch).toEqual({ message: undefined });
    expect(result?.recipient).toBe(recipient);
    expect(row).toMatchObject({ sealed, messageId: "old", revision: 4 });
  });

  test("chat metadata, queue and embedded history are sealed together; a consumed queue is not content", async () => {
    const messages = [{ id: "m", role: "user", parts: [] }];
    const queue = { text: "hello", files: [], model: "m", webSearch: false };
    const result = await domain.inspect(ctx, "aisdk_chats", {
      ...parent, messages, messages_queue: queue, title: "Secret", emoji: "🔒",
    });
    expect(result?.value).toEqual({ messages, messages_queue: queue, title: "Secret", emoji: "🔒" });
    expect(Object.keys(result?.patch ?? {}).sort()).toEqual(["emoji", "messages", "messages_queue", "title"]);

    expect(await domain.inspect(ctx, "aisdk_chats", { ...parent, messages_queue: null })).toBeNull();
  });

  test("a failed request's error text is sealed; its kind and an empty marker stay for the UI", async () => {
    const result = await domain.inspect(ctx, "aisdk_chats", {
      ...parent,
      interruption: { kind: "failed", message: "Quota for acct_123 exceeded" },
    });
    expect(result?.value).toEqual({ interruptionMessage: "Quota for acct_123 exceeded" });
    expect(result?.patch).toEqual({ interruption: { kind: "failed", message: "" } });

    // The marker and message-free interruptions are not content, so a retry has nothing to seal.
    for (const interruption of [{ kind: "failed", message: "" }, { kind: "interrupted" }]) {
      expect(await domain.inspect(ctx, "aisdk_chats", { ...parent, interruption })).toBeNull();
    }
  });

  test("retries skip sealed rows and block plaintext appearing beside a sidecar", async () => {
    expect(await domain.inspect(ctx, "chat_messages", { chat: "chat", legacyContent: {} })).toBeNull();
    await expect(
      domain.inspect(ctx, "chat_messages", {
        chat: "chat", legacyContent: {}, message: { role: "user", parts: [] },
      }),
    ).rejects.toThrow();
    await expect(
      domain.inspect(ctx, "aisdk_chats", { ...parent, legacyContent: {}, title: "new" }),
    ).rejects.toThrow();
  });

  test("a row without an owning chat is blocked rather than skipped", async () => {
    const orphan = { db: { get: async () => null } } as unknown as QueryCtx;
    await expect(
      domain.inspect(orphan, "chat_messages", { chat: "gone", message: { role: "user", parts: [] } }),
    ).rejects.toThrow();
  });

  test("plaintext attachment requests byte encryption and keeps its URL mapping", async () => {
    const file = {
      _id: "file", chat: "chat", workspace: "workspace", userId: "owner", storageId: "blob",
      url: "https://files/old", filename: "secret.txt", mediaType: "text/plain", size: 5,
    };
    const result = await domain.inspect(ctx, "chat_files", file);
    expect(result?.storage).toEqual({ id: "blob", field: "fileBytes", encoding: "base64" });
    expect(result?.value).toEqual({ filename: "secret.txt", mediaType: "text/plain", size: 5 });
    expect(result?.patch).toMatchObject({ storageId: undefined, filename: undefined });
    expect(result?.patch).not.toHaveProperty("url");
  });


  test("native files stay untouched; partial native metadata or missing storage blocks", async () => {
    const native = { fileId: "id", capsule: new ArrayBuffer(1), chatEpoch: 1, e2eeParent: "parent" };
    expect(await domain.inspect(ctx, "chat_files", native)).toBeNull();
    await expect(domain.inspect(ctx, "chat_files", { fileId: "id" })).rejects.toThrow();
    await expect(
      domain.inspect(ctx, "chat_files", { chat: "chat", workspace: "workspace", userId: "owner" }),
    ).rejects.toThrow("missing storage");
    expect(await domain.inspect(ctx, "chat_files", { legacyContent: {} })).toBeNull();
    await expect(
      domain.inspect(ctx, "chat_files", { legacyContent: {}, storageId: "blob" }),
    ).rejects.toThrow();
  });


});
