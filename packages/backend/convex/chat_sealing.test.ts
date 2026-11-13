import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { generateEncryptionKeyPair, randomBytes, toBase64Url } from "radium-crypto";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { sealChatMessages } from "../src/chatroom/sealing";

type AuthContext = {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier?: string; subject?: string } | null> };
};
const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.tokenIdentifier ?? identity?.subject;
    return userId ? { _id: userId, email: `${userId}@example.invalid`, name: userId } : null;
  });
  return { getAuthUser, safeGetAuthUser: getAuthUser, getAnyUserById: vi.fn() };
});
vi.mock("./auth", () => ({ authComponent: authMock, createAuth: vi.fn() }));
const modules = import.meta.glob("./**/*.ts");
const makeTest = () => convexTest({ schema, modules });
const id = () => toBase64Url(randomBytes(16));
const queue = { text: "first", files: [], model: "model", webSearch: false };

async function fixture(t: ReturnType<typeof makeTest>) {
  const key = await generateEncryptionKeyPair();
  const e2eeId = id();
  const rows = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Workspace",
    });
    const chat = await ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "personal",
      e2eeId,
      keyEpoch: 1,
      activeStream: false,
      lastInteractionAt: 1,
    });
    return { workspace, chat };
  });
  return { ...rows, e2eeId, key };
}

test("sealed EditChat writes listed positions, bumps revisions, truncates and returns capsules", async () => {
  const t = makeTest();
  const f = await fixture(t);
  const target = { workspace: f.workspace, e2eeId: f.e2eeId, epoch: 1, publicKey: f.key.publicKey };
  const messages = [
    { id: "u", role: "user", parts: [] },
    { id: "a", role: "assistant", parts: [] },
    { id: "removed", role: "assistant", parts: [] },
  ];
  const first = await sealChatMessages({ ...target, messages, heads: [], fileUrls: [] });
  await t.mutation(internal.aisdk.EditChat, {
    chatId: f.chat,
    sealedWrites: first,
    activeStream: false,
  });
  const before = await t.run((ctx) =>
    ctx.db
      .query("chat_messages")
      .withIndex("by_chat_and_position", (q) => q.eq("chat", f.chat))
      .collect(),
  );
  const next = await sealChatMessages({
    ...target,
    messages: messages.slice(0, 2),
    heads: before,
    revisions: { u: 1, a: 1 },
    responseMessageId: "a",
    fileUrls: [],
  });
  expect(next.rows.map((row) => row.position)).toEqual([1]);
  await t.mutation(internal.aisdk.EditChat, { chatId: f.chat, sealedWrites: next });
  const after = await t.run((ctx) =>
    ctx.db
      .query("chat_messages")
      .withIndex("by_chat_and_position", (q) => q.eq("chat", f.chat))
      .collect(),
  );
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]!.revision).toBe(2);
  expect(after.every((row) => row.message === undefined && row.sealed !== undefined)).toBe(true);
  const loaded = await t
    .withIdentity({ tokenIdentifier: "owner", subject: "owner" })
    .query(api.aisdk.GetChatMessages, { chatId: f.chat });
  expect(loaded.entries).toHaveLength(2);
  expect(loaded.capsules).toHaveLength(2);
  await expect(
    t.mutation(internal.aisdk.EditChat, { chatId: f.chat, sealedWrites: next }),
  ).rejects.toThrow();
  await expect(
    t.mutation(internal.aisdk.EditChat, {
      chatId: f.chat,
      messages: [{ id: "leak", role: "user", parts: [] }],
    }),
  ).rejects.toThrow();
});

test("keyed users cannot downgrade creation; keyless accounts retain plaintext creation", async () => {
  const t = makeTest();
  const f = await fixture(t);
  const owner = t.withIdentity({ tokenIdentifier: "owner", subject: "owner" });
  const plaintext = await owner.mutation(api.aisdk.CreateChat, {
    workspace: f.workspace,
    messages_queue: queue,
  });
  expect((await t.run((ctx) => ctx.db.get("aisdk_chats", plaintext)))?.messages_queue).toEqual(
    queue,
  );
  await t.run((ctx) =>
    ctx.db.insert("e2ee_identities", {
      userId: "owner",
      keyId: id(),
      suite: 1,
      encryptionPublicKey: new ArrayBuffer(1216),
      signingPublicKey: new ArrayBuffer(32),
      secrets: new ArrayBuffer(111),
      selfSignature: new ArrayBuffer(64),
      recoveryWrapper: new ArrayBuffer(79),
      status: "active",
      createdAt: 1,
    }),
  );
  await expect(
    owner.mutation(api.aisdk.CreateChat, { workspace: f.workspace, messages_queue: queue }),
  ).rejects.toThrow("E2EE_KEYS_REQUIRED");
  await expect(
    owner.mutation(api.aisdk.CreateChat, {
      workspace: f.workspace,
      scope: "workspace",
      messages_queue: queue,
    }),
  ).resolves.toBeTruthy();
});

test("encrypted upload size includes padding and never stores a filename", async () => {
  const t = makeTest();
  const f = await fixture(t);
  const writes = await sealChatMessages({
    workspace: f.workspace,
    e2eeId: f.e2eeId,
    epoch: 1,
    publicKey: f.key.publicKey,
    messages: [],
    heads: [],
    fileUrls: [],
  });
  const maxEncryptedBytes = 20 * 1024 * 1024 + 4096 + 47;
  const storageId = await t.run((ctx) =>
    ctx.storage.store(
      new Blob([new Uint8Array(maxEncryptedBytes)], { type: "application/octet-stream" }),
    ),
  );
  const owner = t.withIdentity({ tokenIdentifier: "owner", subject: "owner" });
  const e2ee = {
    fileId: id(),
    capsule: writes.capsule.capsule,
    chatEpoch: 1,
    e2eeParent: f.e2eeId,
  };
  await expect(
    owner.mutation(api.chat_files.register, {
      workspace: f.workspace,
      storageId,
      filename: "secret.txt",
      e2ee,
    }),
  ).rejects.toThrow("E2EE_CONTENT_INVALID");
  const registered = await owner.mutation(api.chat_files.register, {
    workspace: f.workspace,
    storageId,
    e2ee,
  });
  expect(registered?.mediaType).toBe("application/octet-stream");
  const row = await t.run((ctx) =>
    ctx.db
      .query("chat_files")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .unique(),
  );
  expect(row?.filename).toBeUndefined();
  expect(row?.size).toBe(maxEncryptedBytes);
});

test("keyed chats reject plaintext-registered files; encrypted uploads keep a validated media type", async () => {
  const t = makeTest();
  const f = await fixture(t);
  const owner = t.withIdentity({ tokenIdentifier: "owner", subject: "owner" });
  const target = { workspace: f.workspace, e2eeId: f.e2eeId, epoch: 1, publicKey: f.key.publicKey };
  const seal = (fileUrls: string[]) =>
    sealChatMessages({ ...target, messages: [], heads: [], fileUrls });

  const plainStorage = await t.run((ctx) =>
    ctx.storage.store(new Blob(["plain"], { type: "image/png" })),
  );
  const plain = await owner.mutation(api.chat_files.register, {
    workspace: f.workspace,
    storageId: plainStorage,
    filename: "a.png",
  });
  await expect(
    t.mutation(internal.aisdk.EditChat, {
      chatId: f.chat,
      sealedWrites: await seal([plain!.url]),
    }),
  ).rejects.toThrow("E2EE_CONTENT_INVALID");

  const encryptedStorage = await t.run((ctx) =>
    ctx.storage.store(new Blob(["sealed"], { type: "application/octet-stream" })),
  );
  const e2ee = {
    fileId: id(),
    capsule: (await seal([])).capsule.capsule,
    chatEpoch: 1,
    e2eeParent: f.e2eeId,
  };
  const register = (args: { mediaType?: string; e2ee?: typeof e2ee }) =>
    owner.mutation(api.chat_files.register, {
      workspace: f.workspace,
      storageId: encryptedStorage,
      ...args,
    });
  await expect(register({ mediaType: "not a media type", e2ee })).rejects.toThrow(
    "E2EE_CONTENT_INVALID",
  );
  await expect(register({ mediaType: "image/png" })).rejects.toThrow("E2EE_CONTENT_INVALID");
  const encrypted = await register({ mediaType: "image/png", e2ee });
  expect(encrypted?.mediaType).toBe("image/png");

  await t.mutation(internal.aisdk.EditChat, {
    chatId: f.chat,
    sealedWrites: await seal([encrypted!.url]),
  });
  const linked = await t.run((ctx) =>
    ctx.db
      .query("chat_files")
      .withIndex("by_chat", (q) => q.eq("chat", f.chat))
      .collect(),
  );
  expect(linked.map((row) => row.fileId)).toEqual([e2ee.fileId]);
});
