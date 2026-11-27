import { and, asc, count, eq } from "drizzle-orm";
import {
  CAPSULE_BYTES,
  chatKeyBindingStatement,
  chatKeyStatement,
  decodeCapsule,
  generateEncryptionKeyPair,
  openCapsule,
  openWithCapsule,
  randomBytes,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
} from "radium-crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addModel, addProvider, offer, upstreamHanging, upstreamStream } from "../../test/gateway";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { eventually, readNext, readOnce, readToEnd } from "../../test/streams";
import { classicUser } from "../../test/users";
import { chatKeyInput, rotateChatKey, wrapInput } from "../e2ee/chat-keys";
import { e2eeCapsules, e2eeChatKeys, e2eeChatKeyWraps, e2eeIdentities } from "../e2ee/schema";
import { appRouter } from "../trpc/router";
import { chatCompletions } from "../usage/schema";
import { projects, workspaceMembers, workspaces } from "../workspaces/schema";
import { openInteraction } from "./code-mode";
import { chatMessageHeads, saveSealedChatMessages } from "./messages";
import { admitRun, endRun, pruneChatRuns } from "./run";
import { runStreamPath } from "./run-streams";
import { chatMembers, chatMessages, chatRuns, chats } from "./schema";
import { sealChatMessages } from "./sealing";
import { detachWorkspaceMember } from "./workspace-chats";

// The chatroom slice through the real router and `/api/chat`: the one access function on every
// read and write path (owner, member, outsider, archived, personal-chat privacy, shared
// membership, removed member), sealed-write validation ported from Convex (`chat_sealing`,
// `chat_messages`, `chatroom`, `e2ee_workspaces` chat parts), and the invariants that relied on
// Convex serializing mutations.

type Role = "owner" | "member" | "other" | "outsider";
const ROLES = ["owner", "member", "other", "outsider"] as const;
const MODEL = "chat-model";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
let workspace = "";
let chatKey: Awaited<ReturnType<typeof generateEncryptionKeyPair>>;
let upstreamCalls = 0;

const db = () => test.runtime.drivers.db;
const call = (role: Role | Headers) =>
  appRouter.createCaller({
    runtime: test.runtime,
    headers: role instanceof Headers ? role : users[role].headers,
  });

const keyId = (fill: number) => toBase64Url(new Uint8Array(16).fill(fill));
const seeds: Record<Role, Uint8Array> = {
  owner: new Uint8Array(32).fill(1),
  member: new Uint8Array(32).fill(2),
  other: new Uint8Array(32).fill(3),
  outsider: new Uint8Array(32).fill(4),
};
const identityKey: Record<Role, string> = {
  owner: keyId(1),
  member: keyId(2),
  other: keyId(3),
  outsider: keyId(4),
};
let e2eeIds = 100;
const nextE2eeId = () => keyId(++e2eeIds % 250);
const box = () => toBase64Url(randomBytes(CAPSULE_BYTES + 40));

type Scope = "personal" | "shared" | "workspace";
type Binding = { chat: string; scope: Scope; creatorId: string; members?: string[] };

/** A chat key epoch in wire form, signed by `signer` (unsigned with `null`), bound when asked. */
async function epochInput(
  e2eeId: string,
  epoch: number,
  signer: Role | null,
  bind?: Binding,
  workspaceId = workspace,
) {
  const id = keyId(200 + epoch);
  const base = { epoch, keyId: id, suite: 1, publicKey: toBase64Url(chatKey.publicKey) };
  if (!signer) return base;
  const statement = { workspaceId, chatE2eeId: e2eeId, epoch, keyId: id, suite: 1, publicKey: chatKey.publicKey };
  const signed = {
    ...base,
    signerKeyId: identityKey[signer],
    signature: toBase64Url(await sign(seeds[signer], chatKeyStatement(statement))),
  };
  if (!bind) return signed;
  const members = bind.scope === "shared" ? [...new Set(bind.members ?? [])].sort() : [];
  return {
    ...signed,
    bindingSignature: toBase64Url(
      await sign(
        seeds[signer],
        chatKeyBindingStatement({
          ...statement,
          chatId: bind.chat,
          scope: bind.scope,
          creatorId: bind.creatorId,
          members,
        }),
      ),
    ),
    ...(bind.scope === "shared" ? { bindingMembers: members } : {}),
  };
}

const identityWrap = (role: Role, chatEpoch = 1) => ({
  chatEpoch,
  recipient: "identity" as const,
  userId: users[role].id,
  recipientKeyId: identityKey[role],
  sealed: toBase64Url(new Uint8Array(1200).fill(chatEpoch)),
});

/**
 * A keyed chat created through `chats.create`. Its epoch one is unsigned (a chat created on a
 * locked device), which only its creator may pin; `bound` adds a creator-signed epoch two bound to
 * the chat's audience, which every reader may pin.
 */
async function createChat(
  creator: Role,
  options: { scope?: Scope; members?: Role[]; bound?: boolean; inWorkspace?: string } = {},
) {
  const scope = options.scope ?? "personal";
  const members = options.members ?? [];
  const e2eeId = nextE2eeId();
  const chatId = await call(creator).chats.create({
    workspace: options.inWorkspace ?? workspace,
    scope,
    ...(scope === "shared" ? { members: members.map((role) => users[role].id) } : {}),
    e2ee: {
      keys: {
        e2eeId,
        epoch: await epochInput(e2eeId, 1, null),
        wraps: [creator, ...members].map((role) => identityWrap(role)),
      },
      sealedQueue: { epoch: 1, box: box() },
      fileUrls: [],
    },
  });
  let epoch = 1;
  if (options.bound) {
    epoch = 2;
    await rotate(creator, chatId, e2eeId, 2, {
      chat: chatId,
      scope,
      creatorId: users[creator].id,
      members: members.map((role) => users[role].id),
    }, [creator, ...members]);
  }
  return { chatId, e2eeId, epoch };
}

async function rotate(
  signer: Role,
  chatId: string,
  e2eeId: string,
  epoch: number,
  bind: Binding | undefined,
  recipients: Role[],
) {
  await rotateChatKey(db(), users[signer].id, {
    chatId,
    epoch: chatKeyInput.parse(await epochInput(e2eeId, epoch, signer, bind)),
    wraps: recipients.map((role) => wrapInput.parse(identityWrap(role, epoch))),
  });
}

/** A chat row inserted directly (visibility-only tests; no keys). */
async function insertChat(creator: Role, scope: Scope, values: Partial<typeof chats.$inferInsert> = {}) {
  const [row] = await db()
    .insert(chats)
    .values({ workspace, userId: users[creator].id, scope, ...values })
    .returning();
  return row!;
}

function send(role: Role | Headers, chatId: string, recipient?: { e2eeId: string; epoch: number }) {
  const headers = new Headers(role instanceof Headers ? role : users[role].headers);
  headers.set("content-type", "application/json");
  return test.app.request("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({
      chatId,
      model: MODEL,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi there" }] }],
      ...(recipient
        ? { recipientKey: { ...recipient, publicKey: toBase64Url(chatKey.publicKey) } }
        : {}),
    }),
  });
}

async function runsOf(chatId: string) {
  return await db().select().from(chatRuns).where(eq(chatRuns.chat, chatId));
}

beforeAll(async () => {
  test = await createTestRuntime();
  chatKey = await generateEncryptionKeyPair();
  for (const role of ROLES) {
    users[role] = await classicUser(test.runtime, `chat-${role}@example.test`);
    await db()
      .insert(e2eeIdentities)
      .values({
        userId: users[role].id,
        keyId: identityKey[role],
        suite: 1,
        encryptionPublicKey: chatKey.publicKey,
        signingPublicKey: await signingPublicKeyFromSeed(seeds[role]),
        secrets: new Uint8Array(1),
        selfSignature: new Uint8Array(64),
        recoveryWrapper: new Uint8Array(1),
        status: "active",
      });
  }
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Chats" })
    .returning();
  workspace = row!.id;
  await db()
    .insert(workspaceMembers)
    .values([
      { workspace, userId: users.member.id, role: "member" },
      { workspace, userId: users.other.id, role: "member" },
    ]);
  await addModel(test.runtime, MODEL);
  await addProvider(test.runtime, workspace, { slug: "upstream", models: [offer(MODEL)] });
  test.runtime.fetch = (async () => {
    upstreamCalls += 1;
    return upstreamStream(["Hello", " world"]);
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  upstreamCalls = 0;
});

afterAll(async () => {
  await test?.close();
});

describe("chat access", () => {
  it("keeps a personal chat private to its creator, the workspace owner included, on every read path", async () => {
    const { chatId, e2eeId } = await createChat("member");
    expect(await call("member").chats.get({ chatId })).toMatchObject({
      id: chatId,
      scope: "personal",
      canManage: true,
      canManageScope: true,
      e2eeId,
      keyEpoch: 1,
    });
    for (const role of ["owner", "other", "outsider"] as const) {
      const caller = call(role);
      for (const read of [
        () => caller.chats.get({ chatId }),
        () => caller.chats.messages({ chatId }),
        () => caller.chatroom.getChatTools({ chatId }),
        () => caller.chatFiles.historicalFile({ chatId, url: "https://example.test/f" }),
        () => caller.chats.rename({ chatId, sealedTitle: { epoch: 1, box: box() } }),
        () => caller.chats.setPinned({ chatId, pinned: true }),
        () => caller.chats.delete({ chatId }),
      ]) {
        await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      // `/api/chat` answers an invisible chat exactly like an unknown one, before any model call.
      const response = await send(role, chatId, { e2eeId, epoch: 1 });
      expect(response.status).toBe(404);
    }
    expect(upstreamCalls).toBe(0);
    for (const role of ["owner", "other"] as const) {
      const page = await call(role).chats.list({ workspace });
      expect(page.page.map((row) => row.id)).not.toContain(chatId);
    }
    expect((await call("member").chats.list({ workspace })).page.map((row) => row.id)).toContain(
      chatId,
    );
    await expect(call("outsider").chats.list({ workspace })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(call(new Headers()).chats.get({ chatId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect((await send(new Headers(), chatId, { e2eeId, epoch: 1 })).status).toBe(401);
  });

  it("shows a shared chat to its creator and listed members only, and stops at removal", async () => {
    const { chatId } = await createChat("owner", { scope: "shared", members: ["member"] });
    expect(await call("member").chats.get({ chatId })).toMatchObject({
      scope: "shared",
      canManage: false,
      canManageScope: false,
    });
    expect((await call("member").chats.list({ workspace })).page).toContainEqual(
      expect.objectContaining({ id: chatId, canManage: false, canAct: false }),
    );
    // A workspace member who is not listed sees nothing.
    await expect(call("other").chats.get({ chatId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await call("other").chats.list({ workspace })).page.map((row) => row.id)).not.toContain(
      chatId,
    );
    // Members read but do not manage: rename, pin and delete are the creator's.
    await expect(
      call("member").chats.rename({ chatId, sealedTitle: { epoch: 1, box: box() } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call("member").chats.delete({ chatId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Removed from the workspace: membership goes and the chat is flagged for a new key epoch.
    await db().transaction(async (tx) => {
      await detachWorkspaceMember(tx, workspace, users.member.id);
      await tx
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspace, workspace), eq(workspaceMembers.userId, users.member.id)),
        );
    });
    try {
      await expect(call("member").chats.get({ chatId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect((await call("owner").chats.get({ chatId })).rekey).toBe(true);
    } finally {
      await db().insert(workspaceMembers).values({ workspace, userId: users.member.id, role: "member" });
    }
  });

  it("shows workspace chats to every workspace user; the owner manages them, members do not", async () => {
    const chat = await insertChat("member", "workspace");
    expect(await call("owner").chats.get({ chatId: chat.id })).toMatchObject({ canManage: true });
    expect(await call("other").chats.get({ chatId: chat.id })).toMatchObject({ canManage: false });
    await expect(call("outsider").chats.get({ chatId: chat.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses every chat of an archived workspace", async () => {
    const chat = await insertChat("owner", "workspace");
    await db().update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, workspace));
    try {
      await expect(call("owner").chats.get({ chatId: chat.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await db().update(workspaces).set({ archivedAt: null }).where(eq(workspaces.id, workspace));
    }
  });
});

describe("Home lists", () => {
  it("pages unpinned chats by (last interaction, id) without gaps or repeats; pins come apart", async () => {
    const [own] = await db()
      .insert(workspaces)
      .values({ ownerId: users.owner.id, name: "Paging" })
      .returning();
    await db().insert(workspaceMembers).values({ workspace: own!.id, userId: users.member.id, role: "member" });
    const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
    const inserted = [];
    // Two chats share one timestamp: the id breaks the tie.
    for (const [creator, scope, seconds] of [
      ["owner", "personal", 1],
      ["owner", "personal", 2],
      ["member", "workspace", 3],
      ["owner", "personal", 4],
      ["owner", "personal", 4],
      ["member", "workspace", 5],
      ["owner", "personal", 6],
    ] as const) {
      const [row] = await db()
        .insert(chats)
        .values({ workspace: own!.id, userId: users[creator].id, scope, lastInteractionAt: at(seconds) })
        .returning();
      inserted.push(row!);
    }
    const [hidden] = await db()
      .insert(chats)
      .values({ workspace: own!.id, userId: users.member.id, scope: "personal", lastInteractionAt: at(7) })
      .returning();
    const [pinned] = await db()
      .insert(chats)
      .values({ workspace: own!.id, userId: users.owner.id, scope: "personal", pinnedAt: at(0), lastInteractionAt: at(0) })
      .returning();

    const seen: string[] = [];
    let cursor: { at: number; id: string } | null = null;
    do {
      const page: Awaited<ReturnType<ReturnType<typeof call>["chats"]["list"]>> = await call(
        "owner",
      ).chats.list({ workspace: own!.id, cursor, limit: 3 });
      seen.push(...page.page.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);
    const expected = [...inserted]
      .sort(
        (a, b) =>
          b.lastInteractionAt.getTime() - a.lastInteractionAt.getTime() || (a.id < b.id ? 1 : -1),
      )
      .map((row) => row.id);
    expect(seen).toEqual(expected);
    expect(seen).not.toContain(hidden!.id);
    expect(seen).not.toContain(pinned!.id);
    expect((await call("owner").chats.listPinned({ workspace: own!.id })).map((row) => row.id)).toEqual([
      pinned!.id,
    ]);
    // Filtering by a Project of another workspace is refused; a deleted one lists nothing.
    const [foreign] = await db()
      .insert(projects)
      .values({ workspace, userId: users.owner.id, name: "Elsewhere" })
      .returning();
    await expect(
      call("owner").chats.list({ workspace: own!.id, project: foreign!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await call("owner").chats.list({ workspace: own!.id, project: "gone" })).page).toEqual([]);
  });
});

describe("sealed writes", () => {
  it("creates keyed chats only with complete, valid key material and a sealed queue", async () => {
    const e2eeId = nextE2eeId();
    const base = async () => ({
      workspace,
      scope: "shared" as const,
      members: [users.member.id],
      e2ee: {
        keys: {
          e2eeId,
          epoch: await epochInput(e2eeId, 1, "owner"),
          wraps: [identityWrap("owner"), identityWrap("member")],
        },
        sealedQueue: { epoch: 1, box: box() },
        fileUrls: [],
      },
    });
    const refused = async (input: Awaited<ReturnType<typeof base>>, message: string) =>
      await expect(call("owner").chats.create(input)).rejects.toMatchObject({ message });

    // No plaintext creation at all.
    await expect(
      call("owner").chats.create({ workspace, scope: "personal" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const valid = await base();
    await refused({ ...valid, scope: "personal" as never }, "E2EE_CONTENT_INVALID");
    await refused(
      { ...valid, e2ee: { ...valid.e2ee, sealedQueue: { epoch: 2, box: box() } } },
      "E2EE_CONTENT_INVALID",
    );
    // Every listed member needs a wrap to their active identity.
    await refused(
      { ...valid, e2ee: { ...valid.e2ee, keys: { ...valid.e2ee.keys, wraps: [identityWrap("owner")] } } },
      "E2EE_KEYS_INVALID",
    );
    await refused(
      {
        ...valid,
        e2ee: {
          ...valid.e2ee,
          keys: {
            ...valid.e2ee.keys,
            wraps: [identityWrap("owner"), { ...identityWrap("member"), recipientKeyId: keyId(99) }],
          },
        },
      },
      "E2EE_KEYS_INVALID",
    );
    // Only the caller's own active identity signs; outsiders are never members; epoch one only.
    await refused(
      {
        ...valid,
        e2ee: { ...valid.e2ee, keys: { ...valid.e2ee.keys, epoch: await epochInput(e2eeId, 1, "member") } },
      },
      "E2EE_KEYS_INVALID",
    );
    await refused(
      {
        ...valid,
        members: [users.outsider.id],
        e2ee: {
          ...valid.e2ee,
          keys: { ...valid.e2ee.keys, wraps: [identityWrap("owner"), identityWrap("outsider")] },
        },
      },
      "E2EE_KEYS_INVALID",
    );
    await refused(
      {
        ...valid,
        e2ee: { ...valid.e2ee, keys: { ...valid.e2ee.keys, epoch: await epochInput(e2eeId, 2, "owner") } },
      },
      "E2EE_KEYS_INVALID",
    );
    // A workspace wrap needs a workspace chat in a keyed workspace.
    await refused(
      {
        ...valid,
        scope: "workspace" as never,
        members: undefined as never,
        e2ee: {
          ...valid.e2ee,
          keys: {
            ...valid.e2ee.keys,
            wraps: [
              {
                chatEpoch: 1,
                recipient: "workspace",
                workspaceEpoch: 1,
                recipientKeyId: keyId(11),
                sealed: box(),
              } as never,
            ],
          },
        },
      },
      "E2EE_KEYS_INVALID",
    );
    const chatId = await call("owner").chats.create(valid);
    const created = await call("member").chats.get({ chatId });
    expect(created).toMatchObject({ e2eeId, keyEpoch: 1, sealedQueue: { epoch: 1 } });
    // A second chat cannot reuse the AAD parent.
    await expect(call("owner").chats.create(await base())).rejects.toThrow();
  });

  it("forks sealed history bound to epoch-one capsules only", async () => {
    const e2eeId = nextE2eeId();
    const writes = await sealChatMessages({
      workspace,
      e2eeId,
      epoch: 1,
      publicKey: chatKey.publicKey,
      messages: [
        { id: "a", role: "user", parts: [] },
        { id: "b", role: "assistant", parts: [] },
      ] as never,
      heads: [],
      fileUrls: [],
    });
    const capsule = {
      capsuleId: writes.capsule.capsuleId,
      chatEpoch: 1,
      capsule: toBase64Url(writes.capsule.capsule),
    };
    const messages = writes.rows.map((row) => ({
      messageId: row.messageId,
      capsuleId: writes.capsule.capsuleId,
      envelope: toBase64Url(row.envelope),
    }));
    const fork = async (change: object) => ({
      workspace,
      e2ee: {
        keys: {
          e2eeId,
          epoch: await epochInput(e2eeId, 1, "owner"),
          wraps: [identityWrap("owner")],
        },
        capsules: [capsule],
        messages,
        fileUrls: [],
        ...change,
      },
    });
    for (const change of [
      { capsules: [{ ...capsule, chatEpoch: 2 }] },
      { capsules: [capsule, capsule] },
      { messages: [...messages, messages[0]!] },
      { messages: [{ ...messages[0]!, capsuleId: keyId(77) }] },
      { capsules: [] },
    ]) {
      await expect(call("owner").chats.fork(await fork(change))).rejects.toMatchObject({
        message: "E2EE_CONTENT_INVALID",
      });
    }
    const chatId = await call("owner").chats.fork(await fork({}));
    const history = await call("owner").chats.messages({ chatId });
    expect(history.entries.map((entry) => [entry.position, entry.messageId, entry.revision])).toEqual([
      [0, "a", 1],
      [1, "b", 1],
    ]);
    expect(history.entries.every((entry) => entry.message === null && entry.sealed)).toBe(true);
    expect(history.capsules).toEqual([capsule]);
    expect(history.activeStream).toBe(false);
  });

  it("writes listed positions, bumps revisions, truncates, and refuses replays, stale epochs and custody", async () => {
    const { chatId, e2eeId } = await createChat("owner");
    const target = { workspace, e2eeId, epoch: 1, publicKey: chatKey.publicKey };
    const messages = [
      { id: "u", role: "user", parts: [] },
      { id: "a", role: "assistant", parts: [] },
      { id: "removed", role: "assistant", parts: [] },
    ];
    const save = (writes: Awaited<ReturnType<typeof sealChatMessages>>) =>
      saveSealedChatMessages(db(), test.runtime.config, chatId, writes);
    await save(await sealChatMessages({ ...target, messages, heads: [], fileUrls: [] }));
    const before = await db().select().from(chatMessages).where(eq(chatMessages.chat, chatId)).orderBy(asc(chatMessages.position));
    const next = await sealChatMessages({
      ...target,
      messages: messages.slice(0, 2),
      heads: await chatMessageHeads(db(), chatId),
      revisions: { u: 1, a: 1 },
      responseMessageId: "a",
      fileUrls: [],
    });
    expect(next.rows.map((row) => row.position)).toEqual([1]);
    await save(next);
    const after = await db().select().from(chatMessages).where(eq(chatMessages.chat, chatId)).orderBy(asc(chatMessages.position));
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.revision).toBe(2);
    expect(after.every((row) => row.message === null && row.sealedEnvelope !== null)).toBe(true);
    expect((await call("owner").chats.messages({ chatId })).capsules).toHaveLength(2);
    // The same batch again (stale revisions, reused capsule) is refused.
    await expect(save(next)).rejects.toMatchObject({ message: "E2EE_CONTENT_INVALID" });
    // Sealed to another epoch, or while the chat waits for a rekey: refused.
    const wrongEpoch = await sealChatMessages({ ...target, epoch: 2, messages: [], heads: [], fileUrls: [] });
    await expect(save(wrongEpoch)).rejects.toMatchObject({ message: "E2EE_CONTENT_INVALID" });
    await db().update(chats).set({ rekey: true }).where(eq(chats.id, chatId));
    await expect(
      save(await sealChatMessages({ ...target, messages: [], heads: [], fileUrls: [] })),
    ).rejects.toMatchObject({ message: "E2EE_CONTENT_INVALID" });
    await db().update(chats).set({ rekey: false }).where(eq(chats.id, chatId));

    // History still in custody is neither replaced nor truncated.
    const custody = { kind: "custody" as const, keyId: "custody", epoch: 1, box: "AAAA" };
    await db().update(chatMessages).set({ legacyContent: custody }).where(eq(chatMessages.id, after[1]!.id));
    await expect(
      save(await sealChatMessages({ ...target, messages: [messages[0]!], heads: [], fileUrls: [] })),
    ).rejects.toMatchObject({ message: "E2EE_CONTENT_INVALID" });
    const [held] = await db().select().from(chatMessages).where(eq(chatMessages.id, after[1]!.id));
    expect(held!.legacyContent).toEqual(custody);
  });

  it("serializes concurrent saves of one chat: one lands, the stale snapshot is refused", async () => {
    const { chatId, e2eeId } = await createChat("owner");
    const target = { workspace, e2eeId, epoch: 1, publicKey: chatKey.publicKey };
    const user = { id: "u", role: "user", parts: [] };
    await saveSealedChatMessages(
      db(),
      test.runtime.config,
      chatId,
      await sealChatMessages({ ...target, messages: [user], heads: [], fileUrls: [] }),
    );
    const heads = await chatMessageHeads(db(), chatId);
    // Two turns sealed from the same snapshot, each appending its own reply.
    const turns = await Promise.all(
      ["first", "second"].map((id) =>
        sealChatMessages({
          ...target,
          messages: [user, { id, role: "assistant", parts: [] }],
          heads,
          revisions: { u: 1 },
          responseMessageId: id,
          fileUrls: [],
        }),
      ),
    );
    const results = await Promise.allSettled(
      turns.map((writes) => saveSealedChatMessages(db(), test.runtime.config, chatId, writes)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ message: "E2EE_CONTENT_INVALID" });
    const rows = await db().select().from(chatMessages).where(eq(chatMessages.chat, chatId));
    expect(rows.map((row) => row.position).sort()).toEqual([0, 1]);
  });

  it("renames through a sealed box at the current epoch only", async () => {
    const { chatId } = await createChat("owner");
    for (const sealedTitle of [
      { epoch: 2, box: box() },
      { epoch: 1, box: toBase64Url(randomBytes(CAPSULE_BYTES)) },
      { epoch: 1, box: toBase64Url(randomBytes(4096)) },
    ]) {
      await expect(call("owner").chats.rename({ chatId, sealedTitle })).rejects.toMatchObject({
        message: "E2EE_CONTENT_INVALID",
      });
    }
    const title = box();
    await call("owner").chats.rename({ chatId, sealedTitle: { epoch: 1, box: title } });
    expect((await call("owner").chats.get({ chatId })).sealedTitle).toEqual({ epoch: 1, box: title });
    await db().update(chats).set({ rekey: true }).where(eq(chats.id, chatId));
    await expect(
      call("owner").chats.rename({ chatId, sealedTitle: { epoch: 1, box: box() } }),
    ).rejects.toMatchObject({ message: "E2EE_CONTENT_INVALID" });
  });
});

describe("chat keys and scope", () => {
  it("narrowing a keyed chat needs a rotation; only the creator changes scope", async () => {
    const { chatId } = await createChat("owner", { scope: "shared", members: ["member"] });
    await expect(
      call("owner").chats.setScope({ chatId, scope: "personal" }),
    ).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });
    await expect(
      call("member").chats.setScope({ chatId, scope: "personal" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await call("owner").chats.get({ chatId })).scope).toBe("shared");
  });

  it("every scope change needs a fresh epoch bound to the next audience; widening rewraps history", async () => {
    const { chatId, e2eeId } = await createChat("owner", { bound: true });
    const next = (bind: Binding) => epochInput(e2eeId, 3, "owner", bind);
    const asShared = { chat: chatId, scope: "shared" as const, creatorId: users.owner.id, members: [users.member.id] };
    const widen = async (rotateTo?: Awaited<ReturnType<typeof next>>) =>
      call("owner").chats.setScope({
        chatId,
        scope: "shared",
        members: [users.member.id],
        keys: {
          ...(rotateTo ? { rotate: rotateTo } : {}),
          wraps: [identityWrap("member", 1), identityWrap("member", 2), identityWrap("owner", 3), identityWrap("member", 3)],
        },
      });
    await expect(widen()).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });
    await expect(widen(await next({ ...asShared, scope: "personal" }))).rejects.toMatchObject({
      message: "E2EE_KEYS_INVALID",
    });
    const elsewhere = (await createChat("owner")).chatId;
    await expect(widen(await next({ ...asShared, chat: elsewhere }))).rejects.toMatchObject({
      message: "E2EE_KEYS_INVALID",
    });
    await expect(widen(await next({ ...asShared, members: [] }))).rejects.toMatchObject({
      message: "E2EE_KEYS_INVALID",
    });
    expect((await call("owner").chats.get({ chatId })).scope).toBe("personal");

    await widen(await next(asShared));
    expect(await call("member").chats.get({ chatId })).toMatchObject({ scope: "shared", keyEpoch: 3 });
    const epochs = await db().select().from(e2eeChatKeys).where(eq(e2eeChatKeys.chat, chatId)).orderBy(asc(e2eeChatKeys.epoch));
    expect(epochs.map((row) => [row.epoch, row.bindingMembers])).toEqual([
      [1, null],
      [2, null],
      [3, [users.member.id]],
    ]);
    const wraps = await db().select().from(e2eeChatKeyWraps).where(eq(e2eeChatKeyWraps.chat, chatId));
    expect(
      wraps
        .filter((wrap) => wrap.userId === users.member.id)
        .map((wrap) => wrap.chatEpoch)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  it("readers replace an unbound epoch with a fresh bound one; replayed or unbound rotations are refused", async () => {
    const { chatId, e2eeId } = await createChat("owner", { scope: "shared", members: ["member"] });
    const policy = { chat: chatId, scope: "shared" as const, creatorId: users.owner.id, members: [users.member.id] };
    const byMember = (epoch: number, bind?: Binding) =>
      rotate("member", chatId, e2eeId, epoch, bind, ["owner", "member"]);
    await expect(byMember(2)).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });
    const elsewhere = (await createChat("owner", { scope: "shared", members: ["member"] })).chatId;
    await expect(byMember(2, { ...policy, chat: elsewhere })).rejects.toMatchObject({
      message: "E2EE_KEYS_INVALID",
    });
    await expect(byMember(2, { ...policy, members: [] })).rejects.toMatchObject({
      message: "E2EE_KEYS_INVALID",
    });
    // Skipping an epoch is refused too.
    await expect(byMember(3, policy)).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });
    await byMember(2, policy);
    const [second] = await db()
      .select()
      .from(e2eeChatKeys)
      .where(and(eq(e2eeChatKeys.chat, chatId), eq(e2eeChatKeys.epoch, 2)));
    expect(second).toMatchObject({ signerUserId: users.member.id, bindingMembers: [users.member.id] });
    // Now bound: another reader cannot rotate it away; the creator still can.
    await expect(byMember(3, policy)).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });
    await rotate("owner", chatId, e2eeId, 3, policy, ["owner", "member"]);
  });

  it("two concurrent rotations to the same epoch: exactly one lands", async () => {
    const { chatId, e2eeId } = await createChat("owner");
    const policy = { chat: chatId, scope: "personal" as const, creatorId: users.owner.id };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => rotate("owner", chatId, e2eeId, 2, policy, ["owner"])),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [row] = await db().select({ n: count() }).from(e2eeChatKeys).where(eq(e2eeChatKeys.chat, chatId));
    expect(row!.n).toBe(2);
  });
});

describe("chat changes", () => {
  it("files chats under Projects of their own workspace only", async () => {
    const { chatId } = await createChat("owner");
    const [project] = await db().insert(projects).values({ workspace, userId: users.owner.id, name: "P" }).returning();
    const [otherSpace] = await db().insert(workspaces).values({ ownerId: users.owner.id, name: "Other" }).returning();
    const [foreign] = await db().insert(projects).values({ workspace: otherSpace!.id, userId: users.owner.id, name: "F" }).returning();
    await expect(call("owner").chats.setProject({ chatId, project: foreign!.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await call("owner").chats.setProject({ chatId, project: project!.id });
    expect((await call("owner").chats.get({ chatId })).project).toBe(project!.id);
    expect((await call("owner").chats.list({ workspace, project: project!.id })).page.map((row) => row.id)).toEqual([chatId]);
    await call("owner").chats.setProject({ chatId, project: null });
  });

  it("pins, and lets only the workspace owner configure a Worker", async () => {
    const { chatId } = await createChat("member");
    await call("member").chats.setPinned({ chatId, pinned: true });
    expect((await call("member").chats.listPinned({ workspace })).map((row) => row.id)).toContain(chatId);
    await expect(
      call("member").chats.setWorker({ chatId, selection: { tools: ["read"] } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deletes a chat with everything it owns in one transaction", async () => {
    const { chatId, e2eeId } = await createChat("owner", { scope: "shared", members: ["member"] });
    await saveSealedChatMessages(
      db(),
      test.runtime.config,
      chatId,
      await sealChatMessages({
        workspace,
        e2eeId,
        epoch: 1,
        publicKey: chatKey.publicKey,
        messages: [{ id: "x" }],
        heads: [],
        fileUrls: [],
      }),
    );
    await admitRun(db(), chatId, users.owner.id);
    await call("owner").chats.delete({ chatId });
    await expect(call("owner").chats.get({ chatId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const [table, column] of [
      [chatMessages, chatMessages.chat],
      [chatMembers, chatMembers.chat],
      [chatRuns, chatRuns.chat],
      [e2eeChatKeys, e2eeChatKeys.chat],
      [e2eeChatKeyWraps, e2eeChatKeyWraps.chat],
      [e2eeCapsules, e2eeCapsules.chat],
    ] as const) {
      const [row] = await db().select({ n: count() }).from(table).where(eq(column, chatId));
      expect(row!.n).toBe(0);
    }
  });
});

describe("Code Mode answers", () => {
  it("only the requesting user answers, once, with the matching kind, while they can see the chat", async () => {
    const { chatId } = await createChat("owner", { scope: "shared", members: ["member"] });
    const kv = test.runtime.drivers.kv;
    const approval = { kind: "approval" as const, approved: true };
    const open = () => openInteraction(kv, { chatId, userId: users.member.id, kind: "approval" });

    const interaction = await open();
    await expect(
      call("owner").chats.answerInteraction({ interaction, response: approval }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call("member").chats.answerInteraction({ interaction, response: { kind: "question", dismissed: true } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call("member").chats.answerInteraction({
        interaction,
        response: { ...approval, signature: { signature: "short", signerKeyId: "k", approvedAt: 1 } },
      }),
    ).rejects.toMatchObject({ message: "Invalid approval signature." });
    await call("member").chats.answerInteraction({ interaction, response: approval });
    await expect(
      call("member").chats.answerInteraction({ interaction, response: { ...approval, approved: false } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      call("member").chats.answerInteraction({ interaction: crypto.randomUUID(), response: approval }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Losing access to the chat ends the right to answer.
    const later = await open();
    await db().delete(chatMembers).where(eq(chatMembers.chat, chatId));
    await expect(
      call("member").chats.answerInteraction({ interaction: later, response: approval }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("first answer wins when several arrive at once", async () => {
    const { chatId } = await createChat("owner");
    const interaction = await openInteraction(test.runtime.drivers.kv, {
      chatId,
      userId: users.owner.id,
      kind: "approval",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        call("owner").chats.answerInteraction({
          interaction,
          response: { kind: "approval", approved: index % 2 === 0 },
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
});

describe("/api/chat", () => {
  it("admits one active run per chat", async () => {
    const { chatId } = await createChat("owner");
    const runs = await Promise.all(Array.from({ length: 6 }, () => admitRun(db(), chatId, users.owner.id)));
    const admitted = runs.filter((run) => run !== null);
    expect(admitted).toHaveLength(1);
    await endRun(db(), admitted[0]!, "finished");
    expect(await admitRun(db(), chatId, users.owner.id)).not.toBeNull();
  });

  it("refuses a turn without the exact current key, and a second sender while a run is active", async () => {
    const { chatId, e2eeId } = await createChat("owner");
    expect((await send("owner", chatId)).status).toBe(409);
    expect((await send("owner", chatId, { e2eeId, epoch: 2 })).status).toBe(409);
    expect((await send("owner", chatId, { e2eeId: keyId(250), epoch: 1 })).status).toBe(409);
    // An unbound (locked-device) epoch one is pinnable by its creator only.
    const shared = await createChat("owner", { scope: "shared", members: ["member"] });
    expect((await send("member", shared.chatId, { e2eeId: shared.e2eeId, epoch: 1 })).status).toBe(409);

    const run = await admitRun(db(), chatId, users.owner.id);
    expect((await send("owner", chatId, { e2eeId, epoch: 1 })).status).toBe(409);
    await endRun(db(), run!, "finished");
    // A recipient that lost access flags the chat; no new turn is sealed to the old key.
    await db().update(chats).set({ rekey: true }).where(eq(chats.id, chatId));
    expect((await send("owner", chatId, { e2eeId, epoch: 1 })).status).toBe(409);
    expect(upstreamCalls).toBe(0);
  });

  it("writes the reply to a run stream every viewer reads, and saves the turn sealed to the chat key", async () => {
    const { chatId, e2eeId, epoch } = await createChat("owner", {
      scope: "shared",
      members: ["member"],
      bound: true,
    });
    const response = await send("member", chatId, { e2eeId, epoch });
    expect(response.status).toBe(201);
    const { streamUrl } = (await response.json()) as { streamUrl: string };
    expect(response.headers.get("location")).toBe(streamUrl);
    const path = streamUrl.slice("/api/streams/".length);

    // The sender and the chat's other reader see the same reply; nobody else can read it.
    const [sender, creator] = await Promise.all([
      readToEnd(test.app, users.member.headers, path),
      readToEnd(test.app, users.owner.headers, path),
    ]);
    expect(creator).toEqual(sender);
    expect(JSON.stringify(sender)).toContain("Hello");
    expect(sender.at(-1)).toMatchObject({ type: "finish" });
    // A viewer that attaches late sees the prompt too (transient, not part of the reply).
    expect(sender[0]).toMatchObject({ type: "data-radium-prompt", transient: true, data: { message: { id: "u1", role: "user" } } });
    for (const role of ["other", "outsider"] as const) {
      expect((await readOnce(test.app, users[role].headers, path, "-1")).status).toBe(404);
    }
    expect(upstreamCalls).toBeGreaterThan(0);

    const [run] = await eventually(async () => {
      const runs = await runsOf(chatId);
      return runs[0]?.status === "finished" ? runs : null;
    });
    expect(run).toMatchObject({ status: "finished", userId: users.member.id });
    const rows = await db().select().from(chatMessages).where(eq(chatMessages.chat, chatId)).orderBy(asc(chatMessages.position));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.message === null && row.sealedEnvelope !== null)).toBe(true);

    // The stored reply opens with the chat key under the Convex AAD.
    const [capsuleRow] = await db().select().from(e2eeCapsules).where(eq(e2eeCapsules.chat, chatId));
    const capsuleKey = await openCapsule({
      seed: chatKey.seed,
      capsule: decodeCapsule(capsuleRow!.capsule),
      aad: { workspace, table: "e2ee_capsules", parent: e2eeId, record: String(epoch), field: "capsule" },
    });
    const reply = JSON.parse(
      new TextDecoder().decode(
        await openWithCapsule({
          capsuleKey,
          envelope: rows[1]!.sealedEnvelope!,
          pad: "content",
          aad: { workspace, table: "chat_messages", parent: e2eeId, record: rows[1]!.messageId!, field: "message" },
        }),
      ),
    );
    expect(reply).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(reply.parts)).toContain("Hello world");

    // The completion is attributed to the chat and its sender; Home moved the chat up.
    const completions = await db().select().from(chatCompletions).where(eq(chatCompletions.chat, chatId));
    expect(completions.length).toBeGreaterThan(0);
    expect(completions.every((row) => row.userId === users.member.id)).toBe(true);
    expect((await call("member").chats.get({ chatId })).activeStream).toBe(false);
    const resume = await test.app.request(`/api/chat/${chatId}/stream`, { headers: users.member.headers });
    expect(resume.status).toBe(204);

    // Retention deletes the ended run together with its stream.
    expect(await test.runtime.streams.tail(path)).not.toBeNull();
    await pruneChatRuns(test.runtime, Date.now() + 11 * 60_000, 100);
    expect(await runsOf(chatId)).toHaveLength(0);
    expect(await test.runtime.streams.tail(path)).toBeNull();
  });

  it("keeps running without its sender, resumes on reload and stops from another device", async () => {
    test.runtime.fetch = (async (_url: unknown, init?: RequestInit) => {
      upstreamCalls += 1;
      return upstreamHanging("Thinking", init?.signal);
    }) as unknown as typeof fetch;
    try {
      const { chatId, e2eeId, epoch } = await createChat("owner", {
        scope: "shared",
        members: ["member", "other"],
        bound: true,
      });
      const controller = new AbortController();
      const headers = new Headers(users.member.headers);
      headers.set("content-type", "application/json");
      const response = await test.app.request("/api/chat", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          chatId,
          model: MODEL,
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi there" }] }],
          recipientKey: { e2eeId, epoch, publicKey: toBase64Url(chatKey.publicKey) },
        }),
      });
      const { streamUrl } = (await response.json()) as { streamUrl: string };
      const path = streamUrl.slice("/api/streams/".length);
      // The sender goes away; the run does not.
      controller.abort();
      await readNext(test.app, users.owner.headers, path, "-1");
      expect((await call("owner").chats.get({ chatId })).activeStream).toBe(true);

      // A reloaded Tab finds the same stream.
      const resume = await test.app.request(`/api/chat/${chatId}/stream`, { headers: users.owner.headers });
      expect(resume.status).toBe(200);
      expect(resume.headers.get("location")).toBe(streamUrl);

      // Neither the sender nor a manager: refused. The creator (a manager) stops it.
      await expect(call("other").chats.stop({ chatId })).rejects.toThrow(/sender or a manager/);
      expect(await call("owner").chats.stop({ chatId })).toBe(true);
      const messages = await readToEnd(test.app, users.owner.headers, path);
      expect(JSON.stringify(messages)).toContain("Thinking");
      const [run] = await eventually(async () => {
        const runs = await runsOf(chatId);
        return runs[0]?.status !== "active" ? runs : null;
      });
      expect(run!.status).toBe("finished");
      expect(await call("owner").chats.stop({ chatId })).toBe(false);
    } finally {
      test.runtime.fetch = (async () => {
        upstreamCalls += 1;
        return upstreamStream(["Hello", " world"]);
      }) as unknown as typeof fetch;
    }
  });

  it("deletes a deleted chat's run streams, and ends a lost run's stream", async () => {
    const { chatId, e2eeId, epoch } = await createChat("owner");
    const response = await send("owner", chatId, { e2eeId, epoch });
    const path = ((await response.json()) as { streamUrl: string }).streamUrl.slice("/api/streams/".length);
    await readToEnd(test.app, users.owner.headers, path);
    await eventually(async () => (await runsOf(chatId))[0]?.status === "finished");
    await call("owner").chats.delete({ chatId });
    await eventually(async () => (await test.runtime.streams.tail(path)) === null);

    // A run whose generator died (no lease renewal) is failed and its readers are released.
    const lost = await createChat("owner");
    const runId = (await admitRun(db(), lost.chatId, users.owner.id))!;
    const lostPath = runStreamPath(lost.chatId, runId);
    await test.runtime.streams.create(lostPath);
    await pruneChatRuns(test.runtime, Date.now() + 2 * 60_000, 100);
    expect((await runsOf(lost.chatId))[0]!.status).toBe("failed");
    expect((await readToEnd(test.app, users.owner.headers, lostPath)).at(-1)).toMatchObject({ type: "error" });
  });

  it("refuses unknown chats and malformed bodies", async () => {
    expect((await send("owner", "no-such-chat", { e2eeId: keyId(5), epoch: 1 })).status).toBe(404);
    const headers = new Headers(users.owner.headers);
    headers.set("content-type", "application/json");
    const malformed = await test.app.request("/api/chat", { method: "POST", headers, body: "{" });
    expect(malformed.status).toBe(400);
  });
});
