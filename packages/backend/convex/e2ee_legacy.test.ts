import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import {
  chatKeyBindingStatement,
  chatKeyStatement,
  generateEncryptionKeyPair,
  grantStatement,
  openBox,
  sealBox,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  utf8,
} from "radium-crypto";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { legacyAad } from "contracts/e2ee/legacy-contract";
import { activeLegacyRecipient } from "../src/e2ee/legacy-crypto";
import { currentChatPublicKey } from "../src/e2ee/chat-keys";
import type { Doc, Id } from "./_generated/dataModel";

vi.mock("./auth", () => ({
  authComponent: { getAuthUser: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => {
    const identity = await ctx.auth.getUserIdentity();
    return identity ? { _id: identity.subject } : null;
  } },
  createAuth: () => ({ options: {} }),
}));
const modules = import.meta.glob("./**/*.ts");

async function fixture() {
  const t = convexTest({ schema, modules });
  const pair = await generateEncryptionKeyPair();
  const ids = await t.run(async ctx => {
    const workspace = await ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Before", keyEpoch: 1 });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    await ctx.db.insert("e2ee_workspace_epochs", {
      workspace, epoch: 1, suite: 1, memberKeyId: "member-key", memberPublicKey: pair.publicKey.slice().buffer,
      ownerKeyId: "owner-key", ownerPublicKey: pair.publicKey.slice().buffer, createdBy: "owner", createdAt: 1,
    });
    const project = await ctx.db.insert("projects", { workspace, userId: "member", name: "Project" });
    return { workspace, project };
  });
  const owner = t.withIdentity({ subject: "owner" });
  const member = t.withIdentity({ subject: "member" });
  const content = async (table: "workspaces" | "projects", record: string, value = { name: "Private name", icon: "folder" }) => ({
    kind: "workspace_member" as const, keyId: "member-key", epoch: 1,
    box: (await sealBox({ recipientPublicKey: pair.publicKey, plaintext: utf8(JSON.stringify(value)), aad: legacyAad(table, record, ids.workspace), pad: "content" })).slice().buffer,
  });
  return { t, pair, owner, member, content, ...ids };
}

const E2EE_ID = toBase64Url(new Uint8Array(16).fill(30));
const keyId = (fill: number) => toBase64Url(new Uint8Array(16).fill(fill));
const seeds = { owner: new Uint8Array(32).fill(1), member: new Uint8Array(32).fill(2) };
const identityKeyId = { owner: keyId(1), member: keyId(2) };
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Signer = keyof typeof seeds;
type Scope = "personal" | "shared" | "workspace";
type Policy = { chat: Id<"aisdk_chats">; scope: Scope; creatorId: string; members?: string[] };
type EpochRow = Omit<Doc<"e2ee_chat_keys">, "_id" | "_creationTime">;

/** Active identities with real signing keys for the owner and the member. */
async function addIdentities(f: Fixture) {
  await f.t.run(async ctx => {
    for (const userId of ["owner", "member"] as const) {
      await ctx.db.insert("e2ee_identities", {
        userId, keyId: identityKeyId[userId], suite: 1,
        encryptionPublicKey: f.pair.publicKey.slice().buffer,
        signingPublicKey: (await signingPublicKeyFromSeed(seeds[userId])).slice().buffer,
        secrets: new ArrayBuffer(1), selfSignature: new ArrayBuffer(64), recoveryWrapper: new ArrayBuffer(1),
        status: "active", createdAt: 1,
      });
    }
    for (const userId of ["owner", "member"] as const) {
      for (const purpose of (userId === "owner" ? ["member", "owner"] : ["member"]) as Array<"member" | "owner">) {
        const sealed = await sealBox({
          recipientPublicKey: f.pair.publicKey, plaintext: f.pair.seed, pad: "none",
          aad: { table: "e2ee_workspace_grants", workspace: f.workspace, parent: userId, record: `1:${purpose}`, field: identityKeyId[userId] },
        });
        await ctx.db.insert("e2ee_workspace_grants", {
          workspace: f.workspace, epoch: 1, purpose, userId, recipientKeyId: identityKeyId[userId],
          granterUserId: "owner", granterKeyId: identityKeyId.owner, sealed: sealed.slice().buffer,
          signature: (await sign(seeds.owner, grantStatement({
            workspaceId: f.workspace, epoch: 1, purpose, recipientUserId: userId,
            recipientKeyId: identityKeyId[userId], sealed,
          }))).slice().buffer, createdAt: 1,
        });
      }
    }
  });
}

/**
 * A chat epoch row with real signatures: `v1` is the original signature (good, over another
 * epoch, or absent) and `bind` adds the V2 binding proof for that exact chat and audience.
 */
async function epochRow(f: Fixture, chat: Id<"aisdk_chats">, o: {
  signer: Signer; epoch?: number; v1?: "good" | "bad" | "none"; bind?: Policy; createdAt?: number;
}): Promise<EpochRow> {
  const epoch = o.epoch ?? 1;
  const id = keyId(40 + epoch);
  const publicKey = f.pair.publicKey;
  const original = (forEpoch: number) =>
    chatKeyStatement({ workspaceId: f.workspace, chatE2eeId: E2EE_ID, epoch: forEpoch, keyId: id, suite: 1, publicKey });
  const row: EpochRow = {
    chat, workspace: f.workspace, epoch, keyId: id, suite: 1,
    publicKey: publicKey.slice().buffer, createdAt: o.createdAt ?? 2,
  };
  if (o.v1 === "none") return row;
  row.signerUserId = o.signer;
  row.signerKeyId = identityKeyId[o.signer];
  row.signature = (await sign(seeds[o.signer], original(o.v1 === "bad" ? 99 : epoch))).slice().buffer;
  if (o.bind) {
    const members = o.bind.scope === "shared" ? [...new Set(o.bind.members ?? [])].sort() : [];
    row.bindingSignature = (await sign(seeds[o.signer], chatKeyBindingStatement({
      chatId: o.bind.chat, workspaceId: f.workspace, chatE2eeId: E2EE_ID, epoch, keyId: id, suite: 1, publicKey,
      scope: o.bind.scope, creatorId: o.bind.creatorId, members,
    }))).slice().buffer;
    if (o.bind.scope === "shared") row.bindingMembers = members;
  }
  return row;
}

/** Replaces the chat's epochs; the last row becomes the current epoch. */
function install(f: Fixture, chat: Id<"aisdk_chats">, rows: EpochRow[]) {
  return f.t.run(async ctx => {
    const old = await ctx.db.query("e2ee_chat_keys").withIndex("by_chat_and_epoch", q => q.eq("chat", chat)).collect();
    for (const row of old) await ctx.db.delete("e2ee_chat_keys", row._id);
    for (const row of rows) await ctx.db.insert("e2ee_chat_keys", row);
    await ctx.db.patch("aisdk_chats", chat, { e2eeId: E2EE_ID, keyEpoch: rows[rows.length - 1]!.epoch });
  });
}

const newChat = (f: Fixture, userId: Signer, scope: Scope = "personal") =>
  f.t.run(ctx => ctx.db.insert("aisdk_chats", { workspace: f.workspace, userId, scope }));

/** The native recipient for a chat; null means history stays in custody. */
const recipient = (f: Fixture, userId: string, chat: Id<"aisdk_chats">) =>
  f.t.run(ctx => activeLegacyRecipient(ctx, { userId, workspace: f.workspace, chat }));

test("encrypted names round-trip with no persisted name/icon plaintext and reject legacy overwrite", async () => {
  const f = await fixture();
  await addIdentities(f);
  const { t, pair, owner, content, workspace } = f;
  const sealed = await content("workspaces", workspace);
  await owner.mutation(api.e2ee_legacy.setName, { target: workspace, content: sealed, expected: null });
  await expect(owner.mutation(api.e2ee_legacy.setName, { target: workspace, content: await content("workspaces", workspace, { name: "Stale overwrite", icon: "folder" }), expected: null })).rejects.toThrow("changed");
  const snapshot = await owner.query(api.e2ee_legacy.getName, { target: workspace });
  expect(snapshot.legacyContent?.box).toEqual(sealed.box);
  const row = await t.run(ctx => ctx.db.get("workspaces", workspace));
  expect(row?.name).toBe("Workspace");
  expect(row?.icon).toBeUndefined();
  expect(row?.legacyContent?.box).toEqual(sealed.box);
  const opened = await openBox({ seed: pair.seed, box: new Uint8Array(row!.legacyContent!.box), aad: legacyAad("workspaces", workspace, workspace), pad: "content" });
  expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ name: "Private name", icon: "folder" });
  await expect(owner.mutation(api.workspaces.rename, { workspace, name: "Leak" })).rejects.toThrow("encryption-capable");
  await expect(openBox({ seed: pair.seed, box: new Uint8Array(sealed.box), aad: legacyAad("projects", workspace, workspace), pad: "content" })).rejects.toThrow();
});

test("name authorization and public recipient validation reject custody and stale epochs", async () => {
  const f = await fixture();
  await addIdentities(f);
  const { owner, member, content, workspace, project } = f;
  const sealed = await content("workspaces", workspace);
  await expect(member.mutation(api.e2ee_legacy.setName, { target: workspace, content: sealed, expected: null })).rejects.toThrow("Not authorized");
  await expect(owner.mutation(api.e2ee_legacy.setName, { target: workspace, content: { ...sealed, kind: "custody" }, expected: null })).rejects.toThrow("current workspace member key");
  await expect(owner.mutation(api.e2ee_legacy.setName, { target: workspace, content: { ...sealed, epoch: 2 }, expected: null })).rejects.toThrow("current workspace member key");
  await member.mutation(api.e2ee_legacy.setName, { target: project, content: await content("projects", project), expected: null });
});

test("external historical storage preserves private-chat authorization", async () => {
  const { t, owner, member, workspace } = await fixture();
  const records = await t.run(async ctx => {
    const storageId = await ctx.storage.store(new Blob(["ciphertext"]));
    const legacyContent = { kind: "chat" as const, keyId: "chat-key", epoch: 1, box: new ArrayBuffer(0), storageId };
    const chat = await ctx.db.insert("aisdk_chats", { workspace, userId: "member", scope: "personal", lastInteractionAt: 1 });
    const frame = await ctx.db.insert("chat_frames", { chat, stream: "s", seqFrom: 0, seqTo: 0, format: "acp", kind: "live", payload: "", legacyContent });
    return { frame };
  });
  await expect(owner.query(api.e2ee_legacy.storageUrl, { table: "chat_frames", record: records.frame })).rejects.toThrow("Not authorized");
  expect(await member.query(api.e2ee_legacy.storageUrl, { table: "chat_frames", record: records.frame })).toContain("http");
});

test("every keyless chat scope waits for a chat key so narrowing cannot retain workspace-key history", async () => {
  const f = await fixture();
  await addIdentities(f);
  const chat = await newChat(f, "owner");
  for (const scope of ["personal", "shared", "workspace"] as const) {
    await f.t.run(ctx => ctx.db.patch("aisdk_chats", chat, { scope }));
    expect(await recipient(f, "owner", chat)).toBeNull();
  }
  expect(await f.t.run(ctx => activeLegacyRecipient(ctx, { userId: "owner" }))).toMatchObject({ kind: "identity", keyId: identityKeyId.owner });
});

test("native history seals only to an authenticated epoch bound to this chat and its current audience", async () => {
  const f = await fixture();
  await addIdentities(f);
  const chat = await newChat(f, "owner");
  const other = await newChat(f, "owner");
  const personal: Policy = { chat, scope: "personal", creatorId: "owner" };

  // Unsigned, mis-signed and pre-binding epochs stay in custody: no reader would accept them.
  await install(f, chat, [await epochRow(f, chat, { signer: "owner", v1: "none" })]);
  expect(await recipient(f, "owner", chat)).toBeNull();
  await install(f, chat, [await epochRow(f, chat, { signer: "owner", v1: "bad", bind: personal })]);
  expect(await recipient(f, "owner", chat)).toBeNull();
  await install(f, chat, [await epochRow(f, chat, { signer: "owner" })]);
  expect(await recipient(f, "owner", chat)).toBeNull();
  // A proof replayed from another chat, or by a signer without authority over a personal chat.
  await install(f, chat, [await epochRow(f, chat, { signer: "owner", bind: { ...personal, chat: other } })]);
  expect(await recipient(f, "owner", chat)).toBeNull();
  await install(f, chat, [await epochRow(f, chat, { signer: "member", bind: personal })]);
  expect(await recipient(f, "owner", chat)).toBeNull();

  await install(f, chat, [await epochRow(f, chat, { signer: "owner", bind: personal })]);
  expect(await recipient(f, "owner", chat)).toMatchObject({ kind: "chat", keyId: keyId(41), epoch: 1 });

  // A relabelled scope no longer matches the signed audience, whichever way the server moves it.
  for (const scope of ["shared", "workspace"] as const) {
    await f.t.run(ctx => ctx.db.patch("aisdk_chats", chat, { scope }));
    expect(await recipient(f, "owner", chat)).toBeNull();
  }
  await f.t.run(ctx => ctx.db.patch("aisdk_chats", chat, { scope: "personal" }));
  expect(await recipient(f, "owner", chat)).toMatchObject({ kind: "chat" });

  // A retired signer no longer vouches for the key.
  await f.t.run(async ctx => {
    const signer = await ctx.db.query("e2ee_identities").withIndex("by_keyId", q => q.eq("keyId", identityKeyId.owner)).unique();
    await ctx.db.patch("e2ee_identities", signer!._id, { status: "retired" });
  });
  expect(await recipient(f, "member", chat)).toBeNull();
});

test("a shared chat's key is bound to its exact raw picked members and a signer with authority", async () => {
  const f = await fixture();
  await addIdentities(f);
  const chat = await newChat(f, "owner", "shared");
  await f.t.run(ctx => ctx.db.insert("chat_members", { chat, workspace: f.workspace, userId: "member", lastInteractionAt: 1 }));
  const shared: Policy = { chat, scope: "shared", creatorId: "owner", members: ["member"] };

  // Bound to a different member list.
  await install(f, chat, [await epochRow(f, chat, { signer: "owner", bind: { ...shared, members: [] } })]);
  expect(await recipient(f, "owner", chat)).toBeNull();
  // A picked member may sign a bound epoch, but only the creator or owner's epoch receives history.
  await install(f, chat, [await epochRow(f, chat, { signer: "member", bind: shared })]);
  expect(await recipient(f, "owner", chat)).toBeNull();
  await install(f, chat, [await epochRow(f, chat, { signer: "owner", bind: shared })]);
  expect(await recipient(f, "owner", chat)).toMatchObject({ kind: "chat", epoch: 1 });

  // Any later difference in the raw list, even a user who already left, needs a fresh epoch.
  await f.t.run(ctx => ctx.db.insert("chat_members", { chat, workspace: f.workspace, userId: "departed", lastInteractionAt: 1 }));
  expect(await recipient(f, "owner", chat)).toBeNull();
});

test("a stale chat epoch holds history in custody until a fresh bound epoch exists", async () => {
  const f = await fixture();
  await addIdentities(f);
  const chat = await newChat(f, "member", "workspace");
  const bound = (epoch: number, createdAt: number) =>
    epochRow(f, chat, { signer: "member", epoch, createdAt, bind: { chat, scope: "workspace", creatorId: "member" } });
  await install(f, chat, [await bound(1, 2)]);
  expect(await recipient(f, "member", chat)).toMatchObject({ kind: "chat", keyId: keyId(41), epoch: 1 });

  // A revoked recipient still holds epoch one.
  await f.t.run(ctx => ctx.db.patch("aisdk_chats", chat, { rekey: true }));
  expect(await recipient(f, "member", chat)).toBeNull();
  await f.t.run(ctx => ctx.db.patch("aisdk_chats", chat, { rekey: false }));

  // The workspace key rotated after epoch one was made (a removed member held the old workspace key).
  await f.t.run(async ctx => {
    await ctx.db.insert("e2ee_workspace_epochs", {
      workspace: f.workspace, epoch: 2, suite: 1, memberKeyId: "member-key-2", memberPublicKey: f.pair.publicKey.slice().buffer,
      ownerKeyId: "owner-key-2", ownerPublicKey: f.pair.publicKey.slice().buffer, createdBy: "owner", createdAt: 3,
    });
    await ctx.db.patch("workspaces", f.workspace, { keyEpoch: 2 });
  });
  expect(await recipient(f, "member", chat)).toBeNull();

  await install(f, chat, [await bound(1, 2), await bound(2, 4)]);
  expect(await recipient(f, "member", chat)).toBeNull();
  const sealed = await sealBox({
    recipientPublicKey: f.pair.publicKey, plaintext: f.pair.seed, pad: "none",
    aad: { table: "e2ee_workspace_grants", workspace: f.workspace, parent: "member", record: "2:member", field: identityKeyId.member },
  });
  const signature = await sign(seeds.owner, grantStatement({
    workspaceId: f.workspace, epoch: 2, purpose: "member", recipientUserId: "member", recipientKeyId: identityKeyId.member, sealed,
  }));
  await f.t.run(ctx => ctx.db.insert("e2ee_workspace_grants", {
    workspace: f.workspace, epoch: 2, purpose: "member", userId: "member", recipientKeyId: identityKeyId.member,
    granterUserId: "owner", granterKeyId: identityKeyId.owner, sealed: sealed.slice().buffer,
    signature: signature.slice().buffer, createdAt: 4,
  }));
  expect(await recipient(f, "member", chat)).toMatchObject({ kind: "chat", keyId: keyId(42), epoch: 2 });
});

test("an unbound keyed chat stays in custody until its creator rotates it; another reader's epoch serves new content only", async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture();
    await addIdentities(f);
    const chat = await newChat(f, "owner", "shared");
    await f.t.run(async ctx => {
      await ctx.db.insert("chat_members", { chat, workspace: f.workspace, userId: "member", lastInteractionAt: 1 });
      // Cutover with history of this chat held in custody: a chat epoch may request its release.
      await ctx.db.insert("e2ee_migration_state", { key: "global", frozen: true, generation: 0, custodyState: "active" });
      await ctx.db.insert("e2ee_legacy_custody", { table: "aisdk_chats", record: chat, chat });
    });
    const releaseJobs = async () =>
      (await f.t.run(ctx => ctx.db.query("e2ee_migration_jobs").collect())).filter(job => job.kind === "release");
    // An earlier PR state: a creator-signed epoch with no binding proof.
    await install(f, chat, [await epochRow(f, chat, { signer: "owner" })]);
    const original = await f.t.run(ctx => ctx.db.query("e2ee_chat_keys").collect());
    expect(await recipient(f, "owner", chat)).toBeNull();

    const shared: Policy = { chat, scope: "shared", creatorId: "owner", members: ["member"] };
    const rotate = async (as: Signer, epochNumber: number) => {
      const next = await epochRow(f, chat, { signer: as, epoch: epochNumber, bind: shared });
      const { chat: _chat, workspace: _workspace, createdAt: _createdAt, signerUserId: _signer, ...epoch } = next;
      const wraps = (["owner", "member"] as const).map(userId => ({
        chatEpoch: epochNumber, recipient: "identity" as const, userId, recipientKeyId: identityKeyId[userId], sealed: new ArrayBuffer(1200),
      }));
      await f.t.withIdentity({ subject: as }).mutation(api.e2ee.rotateChatKey, { chatId: chat, epoch, wraps });
    };

    // A picked member's bound epoch carries new content, but its wraps are unverifiable: no release.
    await rotate("member", 2);
    const sealing = await f.t.run(async ctx =>
      currentChatPublicKey(ctx, (await ctx.db.get("aisdk_chats", chat))!, (await ctx.db.get("workspaces", f.workspace))!));
    expect(sealing).toMatchObject({ epoch: 2, keyId: keyId(42) });
    expect(await recipient(f, "owner", chat)).toBeNull();
    expect(await releaseJobs()).toEqual([]);

    // The creator's epoch requests the release and receives the history.
    await rotate("owner", 3);
    expect(await releaseJobs()).toMatchObject([{ scope: { chat } }]);
    expect(await recipient(f, "owner", chat)).toMatchObject({ kind: "chat", keyId: keyId(43), epoch: 3 });
    // History of the old epoch is untouched.
    const rows = await f.t.run(ctx => ctx.db.query("e2ee_chat_keys").collect());
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.epoch === 1)).toEqual(original[0]);
  } finally {
    vi.useRealTimers();
  }
});

test("certifying the current epoch with its binding makes it sealable; replayed, wrong or old proofs are refused", async () => {
  const f = await fixture();
  await addIdentities(f);
  const chat = await newChat(f, "member");
  const other = await newChat(f, "member");
  const personal: Policy = { chat, scope: "personal", creatorId: "member" };
  await install(f, chat, [await epochRow(f, chat, { signer: "member", v1: "none" })]);
  const certify = (epoch: number, row: EpochRow) =>
    f.member.mutation(api.e2ee.signChatKey, {
      chatId: chat, epoch, signerKeyId: row.signerKeyId!, signature: row.signature!,
      bindingSignature: row.bindingSignature, bindingMembers: row.bindingMembers,
    });
  expect(await recipient(f, "member", chat)).toBeNull();

  await expect(certify(1, await epochRow(f, chat, { signer: "member", bind: { ...personal, chat: other } }))).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(certify(1, await epochRow(f, chat, { signer: "member", bind: { ...personal, scope: "workspace" } }))).rejects.toThrow("E2EE_KEYS_INVALID");
  expect(await recipient(f, "member", chat)).toBeNull();

  await certify(1, await epochRow(f, chat, { signer: "member", bind: personal }));
  expect(await recipient(f, "member", chat)).toMatchObject({ kind: "chat", keyId: keyId(41), epoch: 1 });
  // An existing signature is never replaced.
  await expect(certify(1, await epochRow(f, chat, { signer: "member", bind: personal }))).rejects.toThrow("E2EE_KEYS_INVALID");

  // Signing without a binding proof certifies the original statement only: custody still waits.
  const plain = await newChat(f, "member");
  await install(f, plain, [await epochRow(f, plain, { signer: "member", v1: "none" })]);
  await f.member.mutation(api.e2ee.signChatKey, {
    chatId: plain, epoch: 1, signerKeyId: identityKeyId.member,
    signature: (await epochRow(f, plain, { signer: "member" })).signature!,
  });
  expect(await recipient(f, "member", plain)).toBeNull();

  // A binding is never accepted for an epoch that is not the current one.
  const history = await newChat(f, "member");
  await install(f, history, [
    await epochRow(f, history, { signer: "member", epoch: 1, v1: "none" }),
    await epochRow(f, history, { signer: "member", epoch: 2, bind: { chat: history, scope: "personal", creatorId: "member" } }),
  ]);
  const oldEpoch = await epochRow(f, history, { signer: "member", epoch: 1, bind: { chat: history, scope: "personal", creatorId: "member" } });
  await expect(f.member.mutation(api.e2ee.signChatKey, {
    chatId: history, epoch: 1, signerKeyId: oldEpoch.signerKeyId!, signature: oldEpoch.signature!, bindingSignature: oldEpoch.bindingSignature,
  })).rejects.toThrow("E2EE_KEYS_INVALID");
});

test("a native telemetry capture never upgrades or re-encrypts historical ciphertext", async () => {
  const { t, pair, workspace } = await fixture();
  const blob = await t.run(ctx => ctx.db.insert("telemetry_blobs", { workspace, hash: "same-keyed-hash", kind: "message", size: 1 }));
  const box = await sealBox({
    recipientPublicKey: pair.publicKey, plaintext: utf8(JSON.stringify({ content: "Preserved content" })),
    aad: legacyAad("telemetry_blobs", blob, workspace), pad: "content",
  });
  const historical = { kind: "workspace_owner" as const, keyId: "owner-key", epoch: 1, box: box.slice().buffer };
  await t.run(ctx => ctx.db.patch("telemetry_blobs", blob, { legacyContent: historical, legacyHashVersion: 1 }));
  expect(await t.query(internal.observability.telemetryIngest.existingBlobs, { workspace, hashes: ["same-keyed-hash"] }))
    .toEqual([{ hash: "same-keyed-hash", id: blob, recorded: true }]);
  await t.mutation(internal.observability.telemetryIngest.ingestBlobs, {
    workspace, blobs: [{ hash: "same-keyed-hash", kind: "message", size: 1,
      sealed: { epoch: 1, requestId: "later", capsule: new ArrayBuffer(1), envelope: new ArrayBuffer(1) } }],
  });
  const after = await t.run(ctx => ctx.db.get("telemetry_blobs", blob));
  expect(after?.legacyContent).toEqual(historical);
  expect(after?.sealed).toBeUndefined();
  expect(after?.hash).toBe("same-keyed-hash");
});

test("reset identities cannot authorize workspace migration through retired grants", async () => {
  const f = await fixture();
  await addIdentities(f);
  const selected = (purpose: "member" | "owner") => f.t.run(ctx =>
    activeLegacyRecipient(ctx, { workspace: f.workspace, purpose }));
  expect(await selected("owner")).toMatchObject({ kind: "workspace_owner" });
  const nextIds = { owner: keyId(61), member: keyId(62) };
  const nextPairs = { owner: await generateEncryptionKeyPair(), member: await generateEncryptionKeyPair() };
  const nextSigning = { owner: new Uint8Array(32).fill(91), member: new Uint8Array(32).fill(92) };
  await f.t.run(async ctx => {
    for (const userId of ["owner", "member"] as const) {
      const old = await ctx.db.query("e2ee_identities")
        .withIndex("by_userId_and_status", q => q.eq("userId", userId).eq("status", "active")).unique();
      await ctx.db.patch("e2ee_identities", old!._id, { status: "retired" });
      const { _id, _creationTime, ...fields } = old!;
      await ctx.db.insert("e2ee_identities", {
        ...fields, keyId: nextIds[userId], status: "active",
        encryptionPublicKey: nextPairs[userId].publicKey.slice().buffer,
        signingPublicKey: (await signingPublicKeyFromSeed(nextSigning[userId])).slice().buffer,
      });
    }
  });
  expect(await selected("owner")).toBeNull();
  expect(await selected("member")).toBeNull();
  // Restoring availability needs a new authenticated grant, never relabelling an old envelope.
  const regrant = async (userId: Signer, purpose: "member" | "owner") => {
    const sealed = await sealBox({
      recipientPublicKey: nextPairs[userId].publicKey, plaintext: f.pair.seed, pad: "none",
      aad: { table: "e2ee_workspace_grants", workspace: f.workspace, parent: userId, record: `1:${purpose}`, field: nextIds[userId] },
    });
    const signature = await sign(nextSigning.owner, grantStatement({
      workspaceId: f.workspace, epoch: 1, purpose, recipientUserId: userId, recipientKeyId: nextIds[userId], sealed,
    }));
    await f.t.run(ctx => ctx.db.insert("e2ee_workspace_grants", {
      workspace: f.workspace, epoch: 1, purpose, userId, recipientKeyId: nextIds[userId],
      granterUserId: "owner", granterKeyId: nextIds.owner, sealed: sealed.slice().buffer,
      signature: signature.slice().buffer, createdAt: 2,
    }));
  };
  await regrant("member", "member");
  expect(await selected("member")).toMatchObject({ kind: "workspace_member" });
  expect(await selected("owner")).toBeNull();
  await regrant("owner", "owner");
  expect(await selected("owner")).toMatchObject({ kind: "workspace_owner" });
});

test("only an owner-issued member grant makes the member key available for release", async () => {
  const f = await fixture();
  await addIdentities(f);
  const memberGrant = await f.t.run(async ctx => {
    const grants = await ctx.db.query("e2ee_workspace_grants").collect();
    // Leave the member's grant as the only route to the member key.
    await ctx.db.delete("e2ee_workspace_grants", grants.find(g => g.userId === "owner" && g.purpose === "member")!._id);
    return grants.find(g => g.userId === "member")!._id;
  });
  const selected = () => f.t.run(ctx => activeLegacyRecipient(ctx, { workspace: f.workspace, purpose: "member" }));
  expect(await selected()).toMatchObject({ kind: "workspace_member" });
  // A join self-grant or another member's re-grant is not owner-endorsed.
  await f.t.run(ctx => ctx.db.patch("e2ee_workspace_grants", memberGrant, { granterUserId: "member", granterKeyId: identityKeyId.member }));
  expect(await selected()).toBeNull();
});
