/// <reference types="vite/client" />

/**
 * Real-crypto regressions for releasing custody once a recipient key becomes AVAILABLE. Existence
 * of a public workspace or chat epoch is not availability: after an identity reset a keyed
 * workspace's grants still address the retired key, and a chat key that is unsigned or unbound is
 * read-only history. Each test drives the genuine setup mutations (`bootstrapWorkspaceKeys`,
 * `rotateWorkspaceEpoch`, `addGrants`, `signChatKey`), lets the scheduled release job run, and then
 * opens the released envelope exactly as the recipient would: grant seed -> (chat wrap ->) legacy
 * envelope. Auth is mocked as in the other backend E2EE suites; account bundle blobs of fixture
 * identities (`secrets`, `selfSignature`, `recoveryWrapper`) are never read by these paths.
 */

import { register as registerSecretStore } from "convex-secret-store/test";
import { convexTest, type TestConvex } from "convex-test";
import {
  chatKeyBindingStatement,
  chatKeyStatement,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  grantStatement,
  openBox,
  rosterStatement,
  sealBox,
  sign,
  toBase64Url,
  type EncryptionKeyPair,
  type SigningKeyPair,
} from "radium-crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { legacyAad } from "../src/e2ee/legacy-contract";
import type { EpochInput, GrantInput, RosterInput } from "../src/e2ee/workspace-contract";

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: async (ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> } }) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Not logged in");
      return { _id: identity.subject };
    },
  },
  createAuth: () => ({ options: {} }),
}));

const modules = import.meta.glob("./**/*.ts");
const previousSecretStoreKeys = process.env.SECRET_STORE_KEYS;

beforeAll(() => {
  process.env.SECRET_STORE_KEYS = `1:${Buffer.alloc(32, 1).toString("base64")}`;
});

afterAll(() => {
  if (previousSecretStoreKeys === undefined) delete process.env.SECRET_STORE_KEYS;
  else process.env.SECRET_STORE_KEYS = previousSecretStoreKeys;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const keyIdOf = (n: number) => toBase64Url(new Uint8Array(16).fill(n));
const buffer = (bytes: Uint8Array) => bytes.slice().buffer;
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

const SECRET = "/home/me/vault/plan.txt is missing";
const TITLE = "Quarterly layoffs";

/** One account identity: real signing and encryption keys under a distinct key ID. */
type Person = { userId: string; keyId: string; signing: SigningKeyPair; box: EncryptionKeyPair };

async function person(userId: string, n: number): Promise<Person> {
  return { userId, keyId: keyIdOf(n), signing: await generateSigningKeyPair(), box: await generateEncryptionKeyPair() };
}

function makeTest() {
  const t = convexTest({ schema, modules });
  registerSecretStore(t);
  return t;
}
type Harness = TestConvex<typeof schema>;

const drain = (t: Harness) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function addIdentity(t: Harness, who: Person) {
  await t.run((ctx) =>
    ctx.db.insert("e2ee_identities", {
      userId: who.userId,
      keyId: who.keyId,
      suite: 1,
      encryptionPublicKey: buffer(who.box.publicKey),
      signingPublicKey: buffer(who.signing.publicKey),
      secrets: new ArrayBuffer(1),
      selfSignature: new ArrayBuffer(64),
      recoveryWrapper: new ArrayBuffer(1),
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/** A reset without recovery: the old identity is retired and a fresh one becomes active. */
async function resetIdentity(t: Harness, old: Person, next: Person) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("e2ee_identities").withIndex("by_keyId", (q) => q.eq("keyId", old.keyId)).unique();
    await ctx.db.patch("e2ee_identities", row!._id, { status: "retired", retiredAt: Date.now() });
  });
  await addIdentity(t, next);
}

/** Public and private halves of one workspace epoch. */
type WorkspaceKeys = {
  epoch: number;
  member: EncryptionKeyPair;
  owner: EncryptionKeyPair;
  memberKeyId: string;
  ownerKeyId: string;
};

async function workspaceKeys(epoch: number): Promise<WorkspaceKeys> {
  return {
    epoch,
    member: await generateEncryptionKeyPair(),
    owner: await generateEncryptionKeyPair(),
    memberKeyId: keyIdOf(100 + epoch * 2),
    ownerKeyId: keyIdOf(101 + epoch * 2),
  };
}

const epochInput = (keys: WorkspaceKeys): EpochInput => ({
  epoch: keys.epoch,
  suite: 1,
  memberKeyId: keys.memberKeyId,
  memberPublicKey: buffer(keys.member.publicKey),
  ownerKeyId: keys.ownerKeyId,
  ownerPublicKey: buffer(keys.owner.publicKey),
});

const grantAad = (workspace: Id<"workspaces">, epoch: number, purpose: "member" | "owner", to: Person) => ({
  table: "e2ee_workspace_grants",
  workspace,
  parent: to.userId,
  record: `${epoch}:${purpose}`,
  field: to.keyId,
});

/** A workspace seed sealed to `to`'s real encryption key and signed by `from`'s real signing key. */
async function grant(
  workspace: Id<"workspaces">,
  keys: WorkspaceKeys,
  purpose: "member" | "owner",
  to: Person,
  from: Person,
): Promise<GrantInput> {
  const seed = purpose === "owner" ? keys.owner.seed : keys.member.seed;
  const sealed = await sealBox({
    recipientPublicKey: to.box.publicKey,
    plaintext: seed,
    aad: grantAad(workspace, keys.epoch, purpose, to),
    pad: "none",
  });
  return {
    epoch: keys.epoch,
    purpose,
    userId: to.userId,
    recipientKeyId: to.keyId,
    granterKeyId: from.keyId,
    sealed: buffer(sealed),
    signature: buffer(
      await sign(
        from.signing.seed,
        grantStatement({
          workspaceId: workspace,
          epoch: keys.epoch,
          purpose,
          recipientUserId: to.userId,
          recipientKeyId: to.keyId,
          sealed,
        }),
      ),
    ),
  };
}

async function roster(workspace: Id<"workspaces">, version: number, epoch: number, owner: Person): Promise<RosterInput> {
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      workspace,
      version,
      epoch,
      owner: { userId: owner.userId, keyId: owner.keyId, fingerprint: "owner" },
      epochs: [],
      members: [],
    }),
  );
  return {
    version,
    body: buffer(body),
    signature: buffer(await sign(owner.signing.seed, rosterStatement({ workspaceId: workspace, body }))),
    signerKeyId: owner.keyId,
  };
}

/** What a recipient does: open its own stored grant of an epoch and return the workspace private seed. */
async function openStoredGrant(
  t: Harness,
  workspace: Id<"workspaces">,
  epoch: number,
  purpose: "member" | "owner",
  who: Person,
): Promise<Uint8Array> {
  const row = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("e2ee_workspace_grants")
      .withIndex("by_workspace_and_userId_and_epoch", (q) =>
        q.eq("workspace", workspace).eq("userId", who.userId).eq("epoch", epoch),
      )
      .collect();
    return rows.find((entry) => entry.purpose === purpose && entry.recipientKeyId === who.keyId);
  });
  expect(row, `${who.userId} holds a ${purpose} grant for epoch ${epoch}`).toBeDefined();
  return openBox({
    seed: who.box.seed,
    box: new Uint8Array(row!.sealed),
    aad: grantAad(workspace, epoch, purpose, who),
    pad: "none",
  });
}

const releaseJobs = (t: Harness) =>
  t.run(async (ctx) => (await ctx.db.query("e2ee_migration_jobs").collect()).filter((job) => job.kind === "release"));

const custodyRows = (t: Harness) => t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect());

async function startCutover(t: Harness) {
  await t.action(internal.e2ee_migration_node.createCustody, {});
  await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
}

async function sealReal(t: Harness, tables: string[]) {
  await t.mutation(internal.e2ee_migration.startJobs, { kind: "seal", tables, dryRun: false });
  await drain(t);
}

/** An operator-started real release; it must honor the same availability as the setup hooks. */
async function releaseScope(t: Harness, scope: { workspace: Id<"workspaces"> } | { chat: Id<"aisdk_chats"> }) {
  await t.mutation(internal.e2ee_migration.startJobs, { kind: "release", dryRun: false, scope });
  await drain(t);
}

/** An owner of a personal workspace and one explicit member, both with real active identities. */
async function world() {
  const t = makeTest();
  const owner = await person("owner", 1);
  const member = await person("member", 2);
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Release" });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    return workspace;
  });
  await addIdentity(t, owner);
  await addIdentity(t, member);
  return {
    t,
    workspace,
    owner,
    member,
    asOwner: t.withIdentity({ subject: "owner" }),
    asMember: t.withIdentity({ subject: "member" }),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Epoch one created by the original owner identity, as the real bootstrap flow does. */
async function bootstrapped(w: World) {
  const keys = await workspaceKeys(1);
  await w.asOwner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: w.workspace,
    epoch: epochInput(keys),
    grants: [
      await grant(w.workspace, keys, "member", w.owner, w.owner),
      await grant(w.workspace, keys, "owner", w.owner, w.owner),
    ],
    roster: await roster(w.workspace, 1, 1, w.owner),
  });
  return keys;
}

const agentRow = (workspace: Id<"workspaces">, error: string) => ({
  workspace,
  worker: "worker-1",
  agentId: "agent-1",
  name: "Agent",
  version: "1",
  source: "custom" as const,
  status: "failed" as const,
  error,
  capabilities: {
    loadSession: false, list: false, resume: false, close: false, delete: false, fork: false, logout: false,
    image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false,
  },
  authMethods: [],
  checkedAt: 1,
});

describe("workspace owner-key relay rows", () => {
  test("an owner reset keeps owner-key history in custody until a rotation hands the new identity the new owner key", async () => {
    const w = await world();
    const keys1 = await bootstrapped(w);
    const owner2 = await person("owner", 11);
    await resetIdentity(w.t, w.owner, owner2);
    const agent = await w.t.run((ctx) => ctx.db.insert("worker_agents", agentRow(w.workspace, SECRET)));

    await startCutover(w.t);
    await sealReal(w.t, ["worker_agents"]);
    // Epoch one exists publicly but its only grants address the retired key: sealing to it would burn the plaintext.
    const held = await w.t.run((ctx) => ctx.db.get("worker_agents", agent));
    expect(held?.error).toBeUndefined();
    expect(held?.legacyContent?.kind).toBe("custody");
    expect(await custodyRows(w.t)).toMatchObject([{ table: "worker_agents", record: agent, workspace: w.workspace }]);
    expect(await releaseJobs(w.t)).toEqual([]);

    // An operator release in the meantime changes nothing.
    await releaseScope(w.t, { workspace: w.workspace });
    expect(await releaseJobs(w.t)).toMatchObject([{ status: "completed", pending: 1, changed: 0 }]);
    expect((await w.t.run((ctx) => ctx.db.get("worker_agents", agent)))?.legacyContent?.kind).toBe("custody");

    // The reset owner can only recover by rotating; the rotation itself asks for the scoped release.
    const keys2 = await workspaceKeys(2);
    await w.t.withIdentity({ subject: "owner" }).mutation(api.e2ee.rotateWorkspaceEpoch, {
      workspace: w.workspace,
      epoch: epochInput(keys2),
      grants: [
        await grant(w.workspace, keys2, "member", owner2, owner2),
        await grant(w.workspace, keys2, "owner", owner2, owner2),
      ],
      roster: await roster(w.workspace, 2, 2, owner2),
    });
    const scheduled = (await releaseJobs(w.t)).find((job) => job.status === "running");
    expect(scheduled).toMatchObject({ dryRun: false, scope: { workspace: w.workspace } });
    await drain(w.t);

    const released = await w.t.run((ctx) => ctx.db.get("worker_agents", agent));
    expect(released?.legacyContent).toMatchObject({ kind: "workspace_owner", keyId: keys2.ownerKeyId, epoch: 2 });
    expect(await custodyRows(w.t)).toEqual([]);
    expect(await w.t.run((ctx) => ctx.db.get("e2ee_migration_jobs", scheduled!._id))).toMatchObject({
      status: "completed", changed: 1, blocked: 0,
    });

    // The new owner identity reaches the plaintext through nothing but its own grant.
    const ownerSeed = await openStoredGrant(w.t, w.workspace, 2, "owner", owner2);
    const aad = legacyAad("worker_agents", agent, w.workspace);
    const box = new Uint8Array(released!.legacyContent!.box);
    expect(decode(await openBox({ seed: ownerSeed, box, aad, pad: "content" }))).toEqual({ error: SECRET });
    // Neither the lost epoch-one owner key nor the member key of the new epoch opens it.
    await expect(openBox({ seed: keys1.owner.seed, box, aad, pad: "content" })).rejects.toThrow();
    await expect(openBox({ seed: keys2.member.seed, box, aad, pad: "content" })).rejects.toThrow();
  });

  test("only an owner-purpose grant to the active owner identity makes the owner key available", async () => {
    const w = await world();
    const keys1 = await bootstrapped(w);
    const owner2 = await person("owner", 11);
    await resetIdentity(w.t, w.owner, owner2);
    const agent = await w.t.run((ctx) => ctx.db.insert("worker_agents", agentRow(w.workspace, SECRET)));
    await startCutover(w.t);
    await sealReal(w.t, ["worker_agents"]);
    expect((await w.t.run((ctx) => ctx.db.get("worker_agents", agent)))?.legacyContent?.kind).toBe("custody");

    // A member-purpose grant opens the workspace member key, never the owner key.
    const asOwner2 = w.t.withIdentity({ subject: "owner" });
    await asOwner2.mutation(api.e2ee.addGrants, {
      workspace: w.workspace,
      grants: [await grant(w.workspace, keys1, "member", owner2, owner2)],
    });
    await drain(w.t);
    expect(await releaseJobs(w.t)).toMatchObject([{ status: "completed", pending: 1, changed: 0 }]);
    expect((await w.t.run((ctx) => ctx.db.get("worker_agents", agent)))?.legacyContent?.kind).toBe("custody");

    await asOwner2.mutation(api.e2ee.addGrants, {
      workspace: w.workspace,
      grants: [await grant(w.workspace, keys1, "owner", owner2, owner2)],
    });
    await drain(w.t);
    const released = await w.t.run((ctx) => ctx.db.get("worker_agents", agent));
    expect(released?.legacyContent).toMatchObject({ kind: "workspace_owner", keyId: keys1.ownerKeyId, epoch: 1 });
    expect(await custodyRows(w.t)).toEqual([]);
    const ownerSeed = await openStoredGrant(w.t, w.workspace, 1, "owner", owner2);
    const opened = await openBox({
      seed: ownerSeed,
      box: new Uint8Array(released!.legacyContent!.box),
      aad: legacyAad("worker_agents", agent, w.workspace),
      pad: "content",
    });
    expect(decode(opened)).toEqual({ error: SECRET });
  });
});

/** A workspace chat whose creator really signed and bound epoch one; its seed is wrapped to the workspace member key. */
async function workspaceChat(w: World, keys: WorkspaceKeys, creator: Person) {
  const e2eeId = keyIdOf(80);
  const chatKey = await generateEncryptionKeyPair();
  const chatKeyId = keyIdOf(81);
  const chat = await w.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace: w.workspace,
      userId: creator.userId,
      scope: "workspace",
      e2eeId,
      keyEpoch: 1,
      title: TITLE,
      lastInteractionAt: 1,
    }),
  );
  const common = {
    workspaceId: w.workspace, chatE2eeId: e2eeId, epoch: 1, keyId: chatKeyId, suite: 1, publicKey: chatKey.publicKey,
  };
  const wrapped = await sealBox({
    recipientPublicKey: keys.member.publicKey,
    plaintext: chatKey.seed,
    aad: { table: "e2ee_chat_key_wraps", workspace: w.workspace, parent: e2eeId, record: "1", field: keys.memberKeyId },
    pad: "none",
  });
  await w.t.run(async (ctx) => {
    await ctx.db.insert("e2ee_chat_keys", {
      chat,
      workspace: w.workspace,
      epoch: 1,
      keyId: chatKeyId,
      suite: 1,
      publicKey: buffer(chatKey.publicKey),
      signerKeyId: creator.keyId,
      signerUserId: creator.userId,
      signature: buffer(await sign(creator.signing.seed, chatKeyStatement(common))),
      bindingSignature: buffer(
        await sign(
          creator.signing.seed,
          chatKeyBindingStatement({ ...common, chatId: chat, scope: "workspace", creatorId: creator.userId, members: [] }),
        ),
      ),
      createdAt: Date.now(),
    });
    await ctx.db.insert("e2ee_chat_key_wraps", {
      chat,
      workspace: w.workspace,
      chatEpoch: 1,
      recipient: "workspace",
      workspaceEpoch: 1,
      recipientKeyId: keys.memberKeyId,
      sealed: buffer(wrapped),
    });
  });
  return { chat, e2eeId, chatKey, chatKeyId };
}

describe("workspace chat history", () => {
  test("a member who lost their workspace grant keeps history in custody until a genuine grant restores it", async () => {
    const w = await world();
    const keys1 = await bootstrapped(w);
    // The member holds a real epoch grant while their first identity is active.
    await w.asOwner.mutation(api.e2ee.addGrants, {
      workspace: w.workspace,
      grants: [await grant(w.workspace, keys1, "member", w.member, w.owner)],
    });
    // Both accounts later reset without recovery: every stored grant addresses a retired key.
    const owner2 = await person("owner", 11);
    const member2 = await person("member", 12);
    await resetIdentity(w.t, w.owner, owner2);
    await resetIdentity(w.t, w.member, member2);
    const { chat, e2eeId, chatKey, chatKeyId } = await workspaceChat(w, keys1, member2);
    // The chat's own epoch is authentic; only the workspace layer above it is unreachable.
    await startCutover(w.t);
    await sealReal(w.t, ["aisdk_chats"]);
    const held = await w.t.run((ctx) => ctx.db.get("aisdk_chats", chat));
    expect(held?.title).toBeUndefined();
    expect(held?.legacyContent?.kind).toBe("custody");
    expect(await custodyRows(w.t)).toMatchObject([{ table: "aisdk_chats", record: chat, workspace: w.workspace, chat }]);

    // The owner's identity gets only an owner-purpose grant: the chat's wrap opens with the MEMBER key.
    const asOwner2 = w.t.withIdentity({ subject: "owner" });
    await asOwner2.mutation(api.e2ee.addGrants, {
      workspace: w.workspace,
      grants: [await grant(w.workspace, keys1, "owner", owner2, owner2)],
    });
    await drain(w.t);
    expect(await releaseJobs(w.t)).toMatchObject([{ status: "completed", pending: 1, changed: 0 }]);
    expect((await w.t.run((ctx) => ctx.db.get("aisdk_chats", chat)))?.legacyContent?.kind).toBe("custody");

    // A genuine member-purpose grant to the member's ACTIVE identity schedules the release.
    await asOwner2.mutation(api.e2ee.addGrants, {
      workspace: w.workspace,
      grants: [await grant(w.workspace, keys1, "member", member2, owner2)],
    });
    expect((await releaseJobs(w.t)).filter((job) => job.status === "running")).toMatchObject([
      { dryRun: false, scope: { workspace: w.workspace } },
    ]);
    await drain(w.t);

    const released = await w.t.run((ctx) => ctx.db.get("aisdk_chats", chat));
    expect(released?.legacyContent).toMatchObject({ kind: "chat", keyId: chatKeyId, epoch: 1 });
    expect(await custodyRows(w.t)).toEqual([]);

    // The member reads it through the chain they can really walk: grant -> workspace member seed -> chat wrap -> envelope.
    const memberSeed = await openStoredGrant(w.t, w.workspace, 1, "member", member2);
    const wrap = await w.t.run(async (ctx) =>
      (await ctx.db.query("e2ee_chat_key_wraps").withIndex("by_chat_and_chatEpoch_and_recipientKeyId", (q) => q.eq("chat", chat)).collect())[0],
    );
    const chatSeed = await openBox({
      seed: memberSeed,
      box: new Uint8Array(wrap.sealed),
      aad: { table: "e2ee_chat_key_wraps", workspace: w.workspace, parent: e2eeId, record: "1", field: keys1.memberKeyId },
      pad: "none",
    });
    expect(chatSeed).toEqual(chatKey.seed);
    const opened = await openBox({
      seed: chatSeed,
      box: new Uint8Array(released!.legacyContent!.box),
      aad: legacyAad("aisdk_chats", chat, w.workspace),
      pad: "content",
    });
    expect(decode(opened)).toEqual({ title: TITLE });
  });
});

/** A personal chat whose current epoch was created while locked: a real public key, no signature, no binding. */
async function lockedChat(w: World, n: number) {
  const e2eeId = keyIdOf(90 + n);
  const chatKey = await generateEncryptionKeyPair();
  const chatKeyId = keyIdOf(95 + n);
  const chat = await w.t.run(async (ctx) => {
    const chat = await ctx.db.insert("aisdk_chats", {
      workspace: w.workspace,
      userId: "owner",
      scope: "personal",
      e2eeId,
      keyEpoch: 1,
      title: `${TITLE} ${n}`,
      lastInteractionAt: 1,
    });
    await ctx.db.insert("e2ee_chat_keys", {
      chat,
      workspace: w.workspace,
      epoch: 1,
      keyId: chatKeyId,
      suite: 1,
      publicKey: buffer(chatKey.publicKey),
      createdAt: Date.now(),
    });
    return chat;
  });
  const common = {
    workspaceId: w.workspace, chatE2eeId: e2eeId, epoch: 1, keyId: chatKeyId, suite: 1, publicKey: chatKey.publicKey,
  };
  const signature = buffer(await sign(w.owner.signing.seed, chatKeyStatement(common)));
  const bindingSignature = buffer(
    await sign(
      w.owner.signing.seed,
      chatKeyBindingStatement({ ...common, chatId: chat, scope: "personal", creatorId: "owner", members: [] }),
    ),
  );
  return { chat, chatKey, chatKeyId, signature, bindingSignature };
}

describe("signing a locked chat's current epoch", () => {
  test("a bound signature releases the chat's history to its key, an unbound one keeps custody", async () => {
    const w = await world();
    const bound = await lockedChat(w, 1);
    const unbound = await lockedChat(w, 2);
    await startCutover(w.t);
    await sealReal(w.t, ["aisdk_chats"]);
    for (const { chat } of [bound, unbound]) {
      const row = await w.t.run((ctx) => ctx.db.get("aisdk_chats", chat));
      expect(row?.title).toBeUndefined();
      expect(row?.legacyContent?.kind).toBe("custody");
    }
    expect(await custodyRows(w.t)).toHaveLength(2);

    // A binding proof made for another chat is refused, so a replayed proof never certifies (or releases) this one.
    await expect(
      w.asOwner.mutation(api.e2ee.signChatKey, {
        chatId: unbound.chat,
        epoch: 1,
        signerKeyId: w.owner.keyId,
        signature: unbound.signature,
        bindingSignature: bound.bindingSignature,
      }),
    ).rejects.toThrow("E2EE_KEYS_INVALID");
    expect(await releaseJobs(w.t)).toEqual([]);

    // Certifying without a binding proof still leaves a read-only epoch: the scoped release finds nothing it may open.
    await w.asOwner.mutation(api.e2ee.signChatKey, {
      chatId: unbound.chat, epoch: 1, signerKeyId: w.owner.keyId, signature: unbound.signature,
    });
    await drain(w.t);
    expect(await releaseJobs(w.t)).toMatchObject([{ scope: { chat: unbound.chat }, status: "completed", pending: 1, changed: 0 }]);
    expect((await w.t.run((ctx) => ctx.db.get("aisdk_chats", unbound.chat)))?.legacyContent?.kind).toBe("custody");

    // The same call with the binding proof over this chat, scope and creator releases it to the chat key.
    await w.asOwner.mutation(api.e2ee.signChatKey, {
      chatId: bound.chat,
      epoch: 1,
      signerKeyId: w.owner.keyId,
      signature: bound.signature,
      bindingSignature: bound.bindingSignature,
    });
    expect((await releaseJobs(w.t)).filter((job) => job.status === "running")).toMatchObject([
      { dryRun: false, scope: { chat: bound.chat } },
    ]);
    await drain(w.t);

    const released = await w.t.run((ctx) => ctx.db.get("aisdk_chats", bound.chat));
    expect(released?.legacyContent).toMatchObject({ kind: "chat", keyId: bound.chatKeyId, epoch: 1 });
    const opened = await openBox({
      seed: bound.chatKey.seed,
      box: new Uint8Array(released!.legacyContent!.box),
      aad: legacyAad("aisdk_chats", bound.chat, w.workspace),
      pad: "content",
    });
    expect(decode(opened)).toEqual({ title: `${TITLE} 1` });
    // Only the bound chat's custody entry went away; the other chat still waits for a bound epoch.
    expect(await custodyRows(w.t)).toMatchObject([{ record: unbound.chat, chat: unbound.chat }]);
  });
});
