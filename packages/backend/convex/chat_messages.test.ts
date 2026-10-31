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
    messages: first,
    activeStream: false,
  });
  // Metadata subscriptions never carry history.
  expect(await member.query(api.aisdk.GetChat, { chatId: chat })).not.toHaveProperty("messages");

  // A revert/regenerate shortens history: later positions are removed, not kept as stale rows.
  const reverted = [textMessage("u1", "user", "Hi again")];
  await t.mutation(internal.aisdk.EditChat, { chatId: chat, messages: reverted });
  await expect(member.query(api.aisdk.GetChatMessages, { chatId: chat })).resolves.toMatchObject({
    messages: reverted,
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
    messages: legacy,
  });

  const next = [...legacy, textMessage("a1", "assistant", "Reply")];
  await t.mutation(internal.aisdk.EditChat, { chatId: chat, messages: next });
  const stored = await t.run((ctx) => ctx.db.get("aisdk_chats", chat));
  expect(stored?.messages).toBeUndefined();
  expect(stored?.chat_completions).toBeUndefined();
  await expect(member.query(api.aisdk.GetChatMessages, { chatId: chat })).resolves.toMatchObject({
    messages: next,
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
    messages: [fileMessage("u1", part.url)],
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

test("ListChats keeps old pinned chats outside the recency window", async () => {
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
        userId: "member",
        workspace,
        scope: "personal",
        lastInteractionAt: 100 + index,
      });
    }
    return old;
  });

  const chats = await asUser(t, "member").query(api.aisdk.ListChats, { workspace });
  expect(chats).toHaveLength(30);
  expect(chats[0]?.id).toBe(pinned);
  expect(chats.slice(1).map((chat) => chat.lastInteractionAt)).toEqual(
    Array.from({ length: 29 }, (_, index) => 139 - index),
  );
});
