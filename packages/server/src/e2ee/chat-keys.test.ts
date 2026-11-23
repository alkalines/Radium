import { and, asc, eq } from "drizzle-orm";
import {
  chatKeyBindingStatement,
  chatKeyStatement,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
} from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { chatMembers, chats } from "../chatroom/schema";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { e2eeChatKeys, e2eeChatKeyWraps, e2eeIdentities, e2eeWorkspaceEpochs } from "./schema";

// Chat key procedures through the real router: the one chat access function on every procedure
// (outsider, archived, personal-chat privacy), then behavior ported from Convex
// `e2ee_workspaces.test.ts` (setup coverage and binding, wrap replacement rules, locked-device
// signing, owner rewrap of stale workspace wraps).

type Role = "owner" | "member" | "other" | "outsider";
type Scope = "personal" | "shared" | "workspace";
type Binding = { chat: string; scope: Scope; creatorId: string; members?: string[] };

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
const db = () => test.runtime.drivers.db;
const call = (role: Role) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });

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
/** Member key id of a workspace epoch. */
const memberKeyId = (epoch: number) => keyId(10 + epoch);
const chatPublicKey = new Uint8Array(1216).fill(9);
const invalid = { code: "BAD_REQUEST", message: "E2EE_KEYS_INVALID" };
const notFound = { code: "NOT_FOUND" };
let e2eeIds = 100;
const nextE2eeId = () => keyId(++e2eeIds);

/** A workspace of the owner with member and other, keyed up to `epochs` workspace epochs. */
async function newWorkspace(epochs = 1) {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Chats", keyEpoch: epochs || null })
    .returning();
  await db()
    .insert(workspaceMembers)
    .values(
      (["member", "other"] as const).map((role) => ({
        workspace: row!.id,
        userId: users[role].id,
        role: "member" as const,
      })),
    );
  for (let epoch = 1; epoch <= epochs; epoch++) {
    await db()
      .insert(e2eeWorkspaceEpochs)
      .values({
        workspace: row!.id,
        epoch,
        suite: 1,
        memberKeyId: memberKeyId(epoch),
        memberPublicKey: new Uint8Array(1216),
        ownerKeyId: keyId(20 + epoch),
        ownerPublicKey: new Uint8Array(1216),
        createdBy: users.owner.id,
        createdAt: new Date(Date.now() - 60_000 * (epochs - epoch + 1)),
      });
  }
  return row!.id;
}

async function insertChat(
  workspace: string,
  creator: Role,
  scope: Scope,
  options: { members?: Role[]; e2eeId?: string; keyEpoch?: number } = {},
) {
  const [chat] = await db()
    .insert(chats)
    .values({
      workspace,
      userId: users[creator].id,
      scope,
      e2eeId: options.e2eeId ?? null,
      keyEpoch: options.keyEpoch ?? null,
    })
    .returning();
  for (const role of options.members ?? []) {
    await db()
      .insert(chatMembers)
      .values({ chat: chat!.id, workspace, userId: users[role].id, lastInteractionAt: new Date() });
  }
  return chat!.id;
}

/** A chat key epoch as clients send it. */
type EpochWire = {
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: string;
  signerKeyId: string;
  signature: string;
  bindingSignature?: string;
  bindingMembers?: string[];
};

/** A chat key epoch in wire form, signed by `signer`, bound to `bind` when given. */
async function epochInput(
  workspace: string,
  e2eeId: string,
  epoch: number,
  signer: Role,
  bind?: Binding,
): Promise<EpochWire> {
  const id = keyId(200 + epoch);
  const statement = {
    workspaceId: workspace,
    chatE2eeId: e2eeId,
    epoch,
    keyId: id,
    suite: 1,
    publicKey: chatPublicKey,
  };
  const signed = {
    epoch,
    keyId: id,
    suite: 1,
    publicKey: toBase64Url(chatPublicKey),
    signerKeyId: identityKey[signer],
    signature: toBase64Url(await sign(seeds[signer], chatKeyStatement(statement))),
  };
  if (!bind) return signed;
  const members = bind.scope === "shared" ? [...new Set(bind.members ?? [])].sort() : [];
  const binding = chatKeyBindingStatement({
    ...statement,
    chatId: bind.chat,
    scope: bind.scope,
    creatorId: bind.creatorId,
    members,
  });
  return {
    ...signed,
    bindingSignature: toBase64Url(await sign(seeds[signer], binding)),
    ...(bind.scope === "shared" ? { bindingMembers: members } : {}),
  };
}

const identityWrap = (role: Role, chatEpoch = 1, size = 1200) => ({
  chatEpoch,
  recipient: "identity" as const,
  userId: users[role].id,
  recipientKeyId: identityKey[role],
  sealed: toBase64Url(new Uint8Array(size).fill(chatEpoch)),
});
const workspaceWrap = (chatEpoch: number, workspaceEpoch: number, size: number) => ({
  chatEpoch,
  recipient: "workspace" as const,
  workspaceEpoch,
  recipientKeyId: memberKeyId(workspaceEpoch),
  sealed: toBase64Url(new Uint8Array(size).fill(workspaceEpoch)),
});

/** A keyed chat whose epoch one is signed and bound by its creator (no wraps). */
async function keyedChat(workspace: string, creator: Role, scope: Scope = "workspace") {
  const e2eeId = nextE2eeId();
  const chat = await insertChat(workspace, creator, scope, { e2eeId, keyEpoch: 1 });
  const epoch = await epochInput(workspace, e2eeId, 1, creator, {
    chat,
    scope,
    creatorId: users[creator].id,
  });
  await db()
    .insert(e2eeChatKeys)
    .values({
      chat,
      epoch: 1,
      keyId: epoch.keyId,
      suite: 1,
      publicKey: chatPublicKey,
      signerUserId: users[creator].id,
      signerKeyId: epoch.signerKeyId,
      signature: Buffer.from(epoch.signature, "base64url"),
      bindingSignature: Buffer.from(epoch.bindingSignature!, "base64url"),
    });
  return { chat, e2eeId };
}

const wrapRows = (chat: string) =>
  db()
    .select()
    .from(e2eeChatKeyWraps)
    .where(eq(e2eeChatKeyWraps.chat, chat))
    .orderBy(asc(e2eeChatKeyWraps.workspaceEpoch), asc(e2eeChatKeyWraps.id));

beforeAll(async () => {
  test = await createTestRuntime();
  for (const role of ["owner", "member", "other", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `keys-${role}@example.test`);
    await db()
      .insert(e2eeIdentities)
      .values({
        userId: users[role].id,
        keyId: identityKey[role],
        suite: 1,
        encryptionPublicKey: new Uint8Array(1216),
        signingPublicKey: await signingPublicKeyFromSeed(seeds[role]),
        secrets: new Uint8Array(1),
        selfSignature: new Uint8Array(64),
        recoveryWrapper: new Uint8Array(1),
        status: "active",
      });
  }
});

afterAll(async () => {
  await test?.close();
});

describe("chat access", () => {
  it("refuses outsiders, archived workspaces and other users' personal chats on every procedure", async () => {
    const workspace = await newWorkspace();
    const personal = await keyedChat(workspace, "member", "personal");
    const shared = await keyedChat(workspace, "owner");
    const procedures = {
      chatKeys: (role: Role, chatId: string) => call(role).e2ee.chatKeys({ chatId }),
      setupChatKeys: async (role: Role, chatId: string) =>
        call(role).e2ee.setupChatKeys({
          chatId,
          keys: {
            e2eeId: keyId(99),
            epoch: await epochInput(workspace, keyId(99), 1, role),
            wraps: [],
          },
        }),
      rotateChatKey: async (role: Role, chatId: string) =>
        call(role).e2ee.rotateChatKey({
          chatId,
          epoch: await epochInput(workspace, keyId(99), 2, role),
          wraps: [],
        }),
      addChatKeyWraps: (role: Role, chatId: string) =>
        call(role).e2ee.addChatKeyWraps({ chatId, wraps: [] }),
      signChatKey: (role: Role, chatId: string) =>
        call(role).e2ee.signChatKey({
          chatId,
          epoch: 1,
          signerKeyId: identityKey[role],
          signature: toBase64Url(new Uint8Array(64)),
        }),
    };
    for (const [name, run] of Object.entries(procedures)) {
      await expect(run("outsider", shared.chat), name).rejects.toMatchObject(notFound);
      // The workspace owner too: personal chats are their creator's only.
      await expect(run("owner", personal.chat), name).rejects.toMatchObject(notFound);
      await expect(run("other", personal.chat), name).rejects.toMatchObject(notFound);
    }
    await db()
      .update(workspaces)
      .set({ archivedAt: new Date() })
      .where(eq(workspaces.id, workspace));
    for (const [name, run] of Object.entries(procedures)) {
      await expect(run("member", personal.chat), name).rejects.toMatchObject(notFound);
      await expect(run("owner", shared.chat), name).rejects.toMatchObject(notFound);
    }
  });

  it("returns the newest epochs or exactly one, and only wraps the caller can use", async () => {
    const workspace = await newWorkspace();
    const { chat, e2eeId } = await keyedChat(workspace, "owner");
    await call("owner").e2ee.addChatKeyWraps({
      chatId: chat,
      wraps: [workspaceWrap(1, 1, 100), identityWrap("owner"), identityWrap("member")],
    });
    const owners = await call("owner").e2ee.chatKeys({ chatId: chat });
    expect(owners).toMatchObject({
      chat,
      workspace,
      e2eeId,
      keyEpoch: 1,
      scope: "workspace",
      creatorId: users.owner.id,
      rekey: false,
      workspaceKeyEpoch: 1,
      staleForWorkspace: false,
      members: [],
    });
    expect(owners.epochs).toMatchObject([
      {
        epoch: 1,
        signerUserId: users.owner.id,
        signerKeyId: identityKey.owner,
        bindingMembers: null,
      },
    ]);
    expect(owners.wraps.map((wrap) => [wrap.recipient, wrap.userId])).toEqual([
      ["workspace", null],
      ["identity", users.owner.id],
    ]);
    const members = await call("member").e2ee.chatKeys({ chatId: chat, epoch: 1 });
    expect(members.wraps.map((wrap) => wrap.userId)).toEqual([null, users.member.id]);
    const missing = await call("member").e2ee.chatKeys({ chatId: chat, epoch: 7 });
    expect([missing.epochs, missing.wraps]).toEqual([[], []]);
  });
});

describe("chat key setup", () => {
  it("any current reader bootstraps a keyless chat with their own signature and its exact audience", async () => {
    const workspace = await newWorkspace();
    const chatId = await insertChat(workspace, "owner", "shared", { members: ["member"] });
    const e2eeId = keyId(60);
    const audience = [identityWrap("owner"), identityWrap("member")];
    const policy: Binding = {
      chat: chatId,
      scope: "shared",
      creatorId: users.owner.id,
      members: [users.member.id],
    };
    const signed = await epochInput(workspace, e2eeId, 1, "member", policy);
    const setup = (role: Role, epoch: object, wraps = audience, id = e2eeId) =>
      call(role).e2ee.setupChatKeys({
        chatId,
        keys: { e2eeId: id, epoch: epoch as typeof signed, wraps },
      });

    // A workspace member outside the shared chat is not a reader.
    await expect(
      setup("other", await epochInput(workspace, e2eeId, 1, "other", policy)),
    ).rejects.toMatchObject(notFound);
    // Unsigned, or signed by an identity other than the caller's.
    const { signature: _signature, signerKeyId: _signerKeyId, ...unsigned } = signed;
    await expect(setup("member", unsigned)).rejects.toMatchObject(invalid);
    await expect(
      setup("member", await epochInput(workspace, e2eeId, 1, "owner", policy)),
    ).rejects.toMatchObject(invalid);
    // The creator must be covered, nobody may be added, and keys must be the active ones.
    await expect(setup("member", signed, [identityWrap("member")])).rejects.toMatchObject(invalid);
    await expect(
      setup("member", signed, [...audience, identityWrap("other")]),
    ).rejects.toMatchObject(invalid);
    await expect(
      setup("member", signed, [audience[0]!, { ...audience[1]!, recipientKeyId: keyId(99) }]),
    ).rejects.toMatchObject(invalid);
    // A binding proof is required, for this chat and exactly this audience.
    const { bindingSignature: _binding, bindingMembers: _bound, ...v1Only } = signed;
    await expect(setup("member", v1Only)).rejects.toMatchObject(invalid);
    const elsewhere = await insertChat(workspace, "owner", "shared", { members: ["member"] });
    for (const wrong of [
      { ...policy, chat: elsewhere },
      { ...policy, members: [] },
      { ...policy, scope: "workspace" as const },
    ]) {
      await expect(
        setup("member", await epochInput(workspace, e2eeId, 1, "member", wrong)),
      ).rejects.toMatchObject(invalid);
    }

    await setup("member", signed);
    const stored = await db().select().from(e2eeChatKeys).where(eq(e2eeChatKeys.chat, chatId));
    expect(stored).toMatchObject([
      {
        epoch: 1,
        keyId: signed.keyId,
        signerUserId: users.member.id,
        signerKeyId: identityKey.member,
        bindingMembers: [users.member.id],
      },
    ]);
    expect(await call("owner").e2ee.chatKeys({ chatId })).toMatchObject({
      e2eeId,
      keyEpoch: 1,
      creatorId: users.owner.id,
      members: [users.member.id],
    });

    // A later setup, even by the creator, never replaces the stored epoch.
    const loser = keyId(61);
    await expect(
      setup("owner", await epochInput(workspace, loser, 1, "owner", policy), audience, loser),
    ).rejects.toMatchObject(invalid);
    expect(await db().select().from(e2eeChatKeys).where(eq(e2eeChatKeys.chat, chatId))).toEqual(
      stored,
    );
    expect(await wrapRows(chatId)).toHaveLength(2);
  });

  it("non-creators rotate only a chat key that needs rotation; the creator always may", async () => {
    const workspace = await newWorkspace();
    const { chat, e2eeId } = await keyedChat(workspace, "owner");
    const policy: Binding = { chat, scope: "workspace", creatorId: users.owner.id };
    const rotate = async (role: Role, epoch: number) =>
      call(role).e2ee.rotateChatKey({
        chatId: chat,
        epoch: await epochInput(workspace, e2eeId, epoch, role, policy),
        wraps: [workspaceWrap(epoch, 1, 100)],
      });
    await expect(rotate("member", 2)).rejects.toMatchObject(invalid);
    await expect(rotate("owner", 3)).rejects.toMatchObject(invalid);
    await rotate("owner", 2);
    // A revocation marks the chat for rekeying: then any reader may rotate.
    await db().update(chats).set({ rekey: true }).where(eq(chats.id, chat));
    await rotate("member", 3);
    expect(await call("owner").e2ee.chatKeys({ chatId: chat })).toMatchObject({
      keyEpoch: 3,
      rekey: false,
    });
  });
});

describe("chat key wraps", () => {
  it("only the chat creator or workspace owner replace an existing chat key wrap", async () => {
    const workspace = await newWorkspace();
    const { chat } = await keyedChat(workspace, "member");
    const sizes = async () => (await wrapRows(chat)).map((row) => row.sealed.byteLength);
    const add = (role: Role, size: number) =>
      call(role).e2ee.addChatKeyWraps({ chatId: chat, wraps: [workspaceWrap(1, 1, size)] });

    await add("other", 100);
    await add("other", 200);
    expect(await sizes()).toEqual([100]);
    await add("member", 300);
    expect(await sizes()).toEqual([300]);
    await add("other", 150);
    expect(await sizes()).toEqual([300]);
    await add("owner", 400);
    expect(await sizes()).toEqual([400]);
    // Wraps hold one 32-byte seed; anything larger than a capsule plus a short envelope is junk.
    await expect(add("member", 5000)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Wraps target existing epochs and the current workspace key only.
    await expect(
      call("member").e2ee.addChatKeyWraps({ chatId: chat, wraps: [workspaceWrap(2, 1, 100)] }),
    ).rejects.toMatchObject(invalid);
    await expect(
      call("member").e2ee.addChatKeyWraps({
        chatId: chat,
        wraps: [{ ...workspaceWrap(1, 1, 100), recipientKeyId: keyId(99) }],
      }),
    ).rejects.toMatchObject(invalid);
  });

  it("the creator signs an epoch made on a locked device once, binding only the current epoch", async () => {
    const workspace = await newWorkspace();
    const e2eeId = nextE2eeId();
    const chat = await insertChat(workspace, "member", "workspace", { e2eeId, keyEpoch: 2 });
    for (const epoch of [1, 2]) {
      await db()
        .insert(e2eeChatKeys)
        .values({ chat, epoch, keyId: keyId(200 + epoch), suite: 1, publicKey: chatPublicKey });
    }
    const policy: Binding = { chat, scope: "workspace", creatorId: users.member.id };
    const signature = async (role: Role, epoch: number, bind = true) => {
      const { signerKeyId, signature, bindingSignature } = await epochInput(
        workspace,
        e2eeId,
        epoch,
        role,
        bind ? policy : undefined,
      );
      return { chatId: chat, epoch, signerKeyId, signature, bindingSignature };
    };
    await expect(call("owner").e2ee.signChatKey(await signature("owner", 2))).rejects.toMatchObject(
      invalid,
    );
    await expect(
      call("member").e2ee.signChatKey(await signature("member", 1)),
    ).rejects.toMatchObject(invalid);
    // A signature over another epoch's key is refused.
    await expect(
      call("member").e2ee.signChatKey({ ...(await signature("member", 1, false)), epoch: 2 }),
    ).rejects.toMatchObject(invalid);
    await call("member").e2ee.signChatKey(await signature("member", 1, false));
    await call("member").e2ee.signChatKey(await signature("member", 2));
    await expect(
      call("member").e2ee.signChatKey(await signature("member", 2)),
    ).rejects.toMatchObject(invalid);
    const rows = await db()
      .select()
      .from(e2eeChatKeys)
      .where(eq(e2eeChatKeys.chat, chat))
      .orderBy(asc(e2eeChatKeys.epoch));
    expect(rows.map((row) => [row.signerUserId, row.bindingSignature !== null])).toEqual([
      [users.member.id, false],
      [users.member.id, true],
    ]);
  });

  it("owner rewrap replaces junk at the current epoch and drops wraps of narrowed chats", async () => {
    const workspace = await newWorkspace(2);
    const { chat } = await keyedChat(workspace, "member");
    const narrowed = (await keyedChat(workspace, "member", "personal")).chat;
    for (const [target, workspaceEpoch, size] of [
      [chat, 1, 100],
      [chat, 2, 10],
      [narrowed, 1, 100],
    ] as const) {
      await db()
        .insert(e2eeChatKeyWraps)
        .values({
          chat: target,
          workspace,
          chatEpoch: 1,
          recipient: "workspace",
          workspaceEpoch,
          recipientKeyId: memberKeyId(workspaceEpoch),
          sealed: new Uint8Array(size),
        });
    }
    const first = await call("owner").e2ee.staleWorkspaceWraps({ workspace, limit: 1 });
    expect(first.page).toHaveLength(1);
    expect(first.cursor).not.toBeNull();
    const second = await call("owner").e2ee.staleWorkspaceWraps({
      workspace,
      cursor: first.cursor,
      limit: 1,
    });
    expect(second.page).toHaveLength(1);
    expect(second.cursor).toBeNull();
    const stale = [...first.page, ...second.page];
    expect(new Set(stale.map((wrap) => wrap.chat))).toEqual(new Set([chat, narrowed]));

    // Only a current-epoch wrap of the same chat epoch replaces a stale one.
    await expect(
      call("owner").e2ee.replaceWorkspaceWraps({
        workspace,
        replacements: [{ oldWrap: stale[0]!.id, wrap: workspaceWrap(1, 1, 64) }],
      }),
    ).rejects.toMatchObject(invalid);
    await call("owner").e2ee.replaceWorkspaceWraps({
      workspace,
      replacements: stale.map((old) => ({ oldWrap: old.id, wrap: workspaceWrap(1, 2, 64) })),
    });
    expect(
      (await wrapRows(chat)).map((row) => [row.workspaceEpoch, row.sealed.byteLength]),
    ).toEqual([[2, 64]]);
    expect(await wrapRows(narrowed)).toEqual([]);
    expect((await call("owner").e2ee.staleWorkspaceWraps({ workspace })).page).toEqual([]);
    expect(
      await db()
        .select()
        .from(e2eeChatKeyWraps)
        .where(
          and(eq(e2eeChatKeyWraps.workspace, workspace), eq(e2eeChatKeyWraps.workspaceEpoch, 1)),
        ),
    ).toEqual([]);
  });
});
