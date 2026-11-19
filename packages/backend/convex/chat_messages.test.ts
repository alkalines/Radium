/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import schema from "./schema";

type TestIdentity = { tokenIdentifier?: string; subject?: string };
type AuthContext = { auth: { getUserIdentity: () => Promise<TestIdentity | null> } };

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.tokenIdentifier ?? identity?.subject;
    if (!userId) return null;
    return { _id: userId, email: `${userId}@example.invalid`, name: userId };
  });
  return { getAuthUser, getAnyUserById: vi.fn(), safeGetAuthUser: getAuthUser };
});

vi.mock("./auth", () => ({ authComponent: authMock }));

afterEach(() => {
  vi.useRealTimers();
});

const modules = import.meta.glob("./**/*.ts");

function makeTest() {
  return convexTest({ schema, modules });
}

function asUser(t: ReturnType<typeof makeTest>, userId: string) {
  return t.withIdentity({ tokenIdentifier: userId, subject: userId });
}

function textMessage(id: string, role: "user" | "assistant", text: string) {
  return { id, role, parts: [{ type: "text" as const, text, state: "done" as const }] };
}

function fileMessage(id: string, url: string) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "file" as const, mediaType: "image/png", filename: "a.png", url }],
  };
}

async function workspaceFixture(t: ReturnType<typeof makeTest>) {
  return await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Shared workspace",
    });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    const chat = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      activeStream: false,
      lastInteractionAt: 1,
    });
    return { workspace, chat };
  });
}

async function uploadFile(t: ReturnType<typeof makeTest>, workspace: Id<"workspaces">) {
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
  );
  const part = await asUser(t, "member").mutation(api.chat_files.register, {
    workspace,
    storageId,
    filename: "a.png",
  });
  if (!part) throw new Error("upload was rejected");
  return { storageId, part };
}

test("history saves replace only the stored positions and stay private to the chat's viewers", async () => {
  const t = makeTest();
  const { chat } = await workspaceFixture(t);
  const member = asUser(t, "member");

  const first = [textMessage("u1", "user", "Hi"), textMessage("a1", "assistant", "Hello")];
  await t.mutation(internal.aisdk.EditChat, { chatId: chat, messages: first, activeStream: false });
  await expect(member.query(api.aisdk.GetChatMessages, { chatId: chat })).resolves.toEqual({
    entries: first.map((message, position) => ({ position, message })),
    capsules: [],
    activeStream: false,
  });
  // Metadata subscriptions never carry history.
  expect(await member.query(api.aisdk.GetChat, { chatId: chat })).not.toHaveProperty("messages");

  // A revert/regenerate shortens history: later positions are removed, not kept as stale rows.
  const reverted = [textMessage("u1", "user", "Hi again")];
  await t.mutation(internal.aisdk.EditChat, { chatId: chat, messages: reverted });
  await expect(member.query(api.aisdk.GetChatMessages, { chatId: chat })).resolves.toMatchObject({
    entries: reverted.map((message, position) => ({ position, message })),
  });
  const rows = await t.run((ctx) =>
    ctx.db
      .query("chat_messages")
      .withIndex("by_chat_and_position", (q) => q.eq("chat", chat))
      .collect(),
  );
  expect(rows.map((row) => row.position)).toEqual([0]);

  // Workspace ownership does not reveal a member's personal history.
  await expect(
    asUser(t, "owner").query(api.aisdk.GetChatMessages, { chatId: chat }),
  ).rejects.toThrow("Chat not found.");
});

test("an unmigrated chat serves its embedded history until a save moves it", async () => {
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const legacy = [textMessage("u1", "user", "Legacy prompt")];
  const chat = await t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      messages: legacy,
      chat_completions: [],
      lastInteractionAt: 1,
    }),
  );
  const member = asUser(t, "member");
  await expect(member.query(api.aisdk.GetChatMessages, { chatId: chat })).resolves.toMatchObject({
    entries: legacy.map((message, position) => ({ position, message, messageId: message.id })),
  });

  const next = [...legacy, textMessage("a1", "assistant", "Reply")];
  await t.mutation(internal.aisdk.EditChat, { chatId: chat, messages: next });
  const stored = await t.run((ctx) => ctx.db.get("aisdk_chats", chat));
  expect(stored?.messages).toBeUndefined();
  expect(stored?.chat_completions).toBeUndefined();
  await expect(member.query(api.aisdk.GetChatMessages, { chatId: chat })).resolves.toMatchObject({
    entries: next.map((message, position) => ({ position, message })),
  });
});

test("attachments are linked per chat and deleted with their last referencing chat", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const { workspace, chat } = await workspaceFixture(t);
  const member = asUser(t, "member");
  const { storageId, part } = await uploadFile(t, workspace);
  expect(part).toMatchObject({ type: "file", mediaType: "image/png", filename: "a.png" });

  // An upload can be registered only once.
  await expect(
    member.mutation(api.chat_files.register, { workspace, storageId }),
  ).resolves.toBeNull();

  await t.mutation(internal.aisdk.EditChat, {
    chatId: chat,
    messages: [fileMessage("u1", part.url)],
  });
  const fork = await member.mutation(api.aisdk.ForkChat, {
    workspace,
    messages: [fileMessage("u1", part.url)],
  });

  await member.mutation(api.aisdk.DeleteChat, { chatId: chat });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await isStored(t, storageId)).toBe(true);
  await expect(member.query(api.aisdk.GetChatMessages, { chatId: fork })).resolves.toMatchObject({
    entries: [{ position: 0, message: fileMessage("u1", part.url) }],
  });

  await member.mutation(api.aisdk.DeleteChat, { chatId: fork });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await isStored(t, storageId)).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("chat_messages").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("chat_files").collect())).toEqual([]);
});

test("a chat cannot claim another workspace's upload by URL", async () => {
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const { part } = await uploadFile(t, workspace);
  const foreign = await t.run(async (ctx) => {
    const other = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "outsider",
      name: "Other",
    });
    const chat = await ctx.db.insert("aisdk_chats", {
      userId: "outsider",
      workspace: other,
      scope: "personal",
      lastInteractionAt: 1,
    });
    return { other, chat };
  });

  await t.mutation(internal.aisdk.EditChat, {
    chatId: foreign.chat,
    messages: [fileMessage("u1", part.url)],
  });
  const references = await t.run((ctx) => ctx.db.query("chat_files").collect());
  expect(references.map((file) => [file.workspace, file.chat])).toEqual([[workspace, undefined]]);
  await expect(
    t.query(internal.chat_files.resolveStoredFiles, { workspace: foreign.other, urls: [part.url] }),
  ).resolves.toEqual([]);
});

async function isStored(t: ReturnType<typeof makeTest>, storageId: Id<"_storage">) {
  return await t.run(async (ctx) => (await ctx.db.system.get("_storage", storageId)) !== null);
}

test("uploads never sent in a message are pruned after a day", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const { storageId } = await uploadFile(t, workspace);

  await t.mutation(internal.chat_files.prunePendingUploads, {});
  expect(await isStored(t, storageId)).toBe(true);

  vi.advanceTimersByTime(25 * 60 * 60 * 1000);
  await t.mutation(internal.chat_files.prunePendingUploads, {});
  expect(await isStored(t, storageId)).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("chat_files").collect())).toEqual([]);
});

test("old stored files without a referencing row are pruned; referenced ones are kept", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const [unregistered, telemetry] = await t.run(async (ctx) => [
    await ctx.storage.store(new Blob([new Uint8Array([1])])),
    await ctx.storage.store(new Blob([new Uint8Array([2])])),
  ]);
  await t.run((ctx) =>
    ctx.db.insert("telemetry_blobs", {
      workspace,
      hash: "h",
      kind: "message",
      size: 1,
      storage: telemetry,
    }),
  );

  await t.mutation(internal.chat_files.prunePendingUploads, {});
  expect(await isStored(t, unregistered)).toBe(true);

  vi.advanceTimersByTime(25 * 60 * 60 * 1000);
  await t.mutation(internal.chat_files.prunePendingUploads, {});
  expect(await isStored(t, unregistered)).toBe(false);
  expect(await isStored(t, telemetry)).toBe(true);
});

test("ListChats pages unpinned chats in order while ListPinnedChats keeps old pins", async () => {
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const pinned = await t.run(async (ctx) => {
    const old = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      pinnedAt: 5,
      lastInteractionAt: 2,
    });
    for (let index = 0; index < 40; index++) {
      await ctx.db.insert("aisdk_chats", {
        userId: index % 2 ? "member" : "owner",
        workspace,
        // Odd chats are the member's own, even ones shared by the owner: two merged streams.
        scope: index % 2 ? "personal" : "workspace",
        lastInteractionAt: 100 + index,
      });
    }
    return old;
  });
  const member = asUser(t, "member");

  await expect(member.query(api.aisdk.ListPinnedChats, { workspace })).resolves.toMatchObject([
    { id: pinned },
  ]);
  const first = await member.query(api.aisdk.ListChats, {
    workspace,
    paginationOpts: { cursor: null, numItems: 25 },
  });
  const second = await member.query(api.aisdk.ListChats, {
    workspace,
    paginationOpts: { cursor: first.continueCursor, numItems: 25 },
  });
  expect(first.isDone).toBe(false);
  expect(second.isDone).toBe(true);
  // The workspace fixture's own chat (the oldest) follows the 40; the pin never appears in pages.
  const paged = [...first.page, ...second.page];
  expect(paged.slice(0, 40).map((chat) => chat.lastInteractionAt)).toEqual(
    Array.from({ length: 40 }, (_, index) => 139 - index),
  );
  expect(paged.map((chat) => chat.id)).not.toContain(pinned);
});

const sidecar = () => ({ kind: "custody" as const, keyId: "custody", epoch: 1, box: new ArrayBuffer(8) });

/** A chat whose plaintext history moved into sidecars, one of them in external File Storage. */
async function sidecarFixture(t: ReturnType<typeof makeTest>) {
  const { workspace, chat } = await workspaceFixture(t);
  return await t.run(async (ctx) => {
    const chatEnvelope = await ctx.storage.store(new Blob([new Uint8Array([1])]));
    const rowEnvelope = await ctx.storage.store(new Blob([new Uint8Array([2])]));
    const fileEnvelope = await ctx.storage.store(new Blob([new Uint8Array([3])]));
    await ctx.db.patch("aisdk_chats", chat, {
      legacyContent: { ...sidecar(), box: new ArrayBuffer(0), storageId: chatEnvelope },
    });
    const row = await ctx.db.insert("chat_messages", {
      chat,
      position: 0,
      legacyContent: { ...sidecar(), box: new ArrayBuffer(0), storageId: rowEnvelope },
    });
    const file = await ctx.db.insert("chat_files", {
      workspace,
      userId: "member",
      chat,
      url: "https://files/old",
      mediaType: "application/octet-stream",
      size: 0,
      legacyContent: { ...sidecar(), box: new ArrayBuffer(0), storageId: fileEnvelope },
    });
    for (const [table, record, storageId] of [
      ["aisdk_chats", chat, chatEnvelope],
      ["chat_messages", row, rowEnvelope],
      ["chat_files", file, fileEnvelope],
    ] as const) {
      await ctx.db.insert("e2ee_legacy_storage", { storageId, table, record });
    }
    return { workspace, chat, row, file, envelopes: [chatEnvelope, rowEnvelope, fileEnvelope] };
  });
}

test("the orphan sweep keeps registered historical envelopes and still removes unreferenced files", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const { envelopes } = await sidecarFixture(t);
  const orphan = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([9])])));

  vi.advanceTimersByTime(25 * 60 * 60 * 1000);
  await t.mutation(internal.chat_files.prunePendingUploads, {});
  expect(await isStored(t, orphan)).toBe(false);
  for (const envelope of envelopes) expect(await isStored(t, envelope)).toBe(true);
});

test("deleting a chat deletes every external sidecar envelope and its registry row", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const { chat, envelopes } = await sidecarFixture(t);

  await asUser(t, "member").mutation(api.aisdk.DeleteChat, { chatId: chat });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  for (const envelope of envelopes) expect(await isStored(t, envelope)).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_storage").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("chat_messages").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("chat_files").collect())).toEqual([]);
});

test("only the sidecar rows expose their identity and box to history readers", async () => {
  const t = makeTest();
  const { chat, row } = await sidecarFixture(t);
  await t.run((ctx) =>
    ctx.db.insert("chat_messages", { chat, position: 1, message: textMessage("p", "user", "plain") }),
  );
  const { entries } = await asUser(t, "member").query(api.aisdk.GetChatMessages, { chatId: chat });
  expect(entries[0]).toMatchObject({ position: 0, recordId: row, legacyContent: { kind: "custody" } });
  expect(entries[1]).not.toHaveProperty("recordId");
  expect(entries[1]).not.toHaveProperty("legacyContent");
});

test("a chat with a sidecar refuses new plaintext but can end a request and records the queue as consumed", async () => {
  const t = makeTest();
  const { chat } = await sidecarFixture(t);

  await expect(
    t.mutation(internal.aisdk.EditChat, { chatId: chat, activeStream: true, messages_queue: null }),
  ).rejects.toThrow();
  await expect(
    t.mutation(internal.aisdk.EditChat, { chatId: chat, messages: [textMessage("u", "user", "x")] }),
  ).rejects.toThrow();
  await expect(
    asUser(t, "member").mutation(api.aisdk.RenameChat, { chatId: chat, title: "New" }),
  ).rejects.toThrow();

  await t.mutation(internal.aisdk.EditChat, { chatId: chat, activeStream: false });
  const stored = await t.run((ctx) => ctx.db.get("aisdk_chats", chat));
  // The sidecar may hold the original queue, so consumption is recorded outside it.
  expect(stored?.messages_queue).toBeNull();
  expect(stored?.title).toBeUndefined();
});

test("frozen cutover rejects every plaintext chat writer", async () => {
  const t = makeTest();
  const { workspace, chat } = await workspaceFixture(t);
  const member = asUser(t, "member");
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([1])])));
  await t.run((ctx) =>
    ctx.db.insert("e2ee_migration_state", {
      key: "global", frozen: true, generation: 1, custodyState: "active",
    }),
  );

  await expect(
    t.mutation(internal.aisdk.EditChat, { chatId: chat, messages: [textMessage("u", "user", "x")] }),
  ).rejects.toThrow();
  await expect(member.mutation(api.aisdk.ForkChat, { workspace, messages: [] })).rejects.toThrow();
  await expect(member.mutation(api.aisdk.RenameChat, { chatId: chat, title: "T" })).rejects.toThrow();
  await expect(member.mutation(api.chat_files.register, { workspace, storageId })).rejects.toThrow();
});

test("a historical attachment is resolved only for chat viewers and is never sent to a model by URL", async () => {
  const t = makeTest();
  const { workspace, chat, file } = await sidecarFixture(t);
  const args = { chatId: chat, url: "https://files/old#ignored" };

  await expect(asUser(t, "member").query(api.chat_files.historicalFile, args)).resolves.toMatchObject({
    recordId: file,
    legacyContent: { kind: "custody" },
  });
  // Workspace ownership never reveals a member's personal chat.
  await expect(asUser(t, "owner").query(api.chat_files.historicalFile, args)).rejects.toThrow();
  await expect(
    t.query(internal.chat_files.resolveStoredFiles, { workspace, urls: ["https://files/old"] }),
  ).resolves.toEqual([{ url: "https://files/old", historical: true }]);
});

test("an aborted cutover cannot attach an identity-sealed pending upload through plaintext save", async () => {
  const t = makeTest();
  const { workspace, chat } = await workspaceFixture(t);
  const url = "https://files/pending-historical";
  const pending = await t.run(async ctx => {
    await ctx.db.insert("e2ee_migration_state", {
      key: "global", frozen: false, cutoverComplete: false, generation: 2, custodyState: "active",
    });
    return ctx.db.insert("chat_files", {
      workspace, userId: "member", url, mediaType: "application/octet-stream", size: 0,
      legacyContent: { kind: "identity", keyId: "member-key", epoch: 1, box: new ArrayBuffer(8) },
    });
  });
  const before = await t.run(ctx => ctx.db.get("chat_files", pending));
  await expect(t.mutation(internal.aisdk.EditChat, {
    chatId: chat, messages: [fileMessage("f", url)],
  })).rejects.toThrow();
  expect(await t.run(ctx => ctx.db.get("chat_files", pending))).toEqual(before);
  expect((await t.run(ctx => ctx.db.get("chat_files", pending)))?.chat).toBeUndefined();
});
