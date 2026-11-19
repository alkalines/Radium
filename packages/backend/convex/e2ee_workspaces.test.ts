import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import {
  grantStatement,
  ROSTER_EPOCH_WINDOW,
  rosterStatement,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  chatKeyBindingStatement,
  chatKeyStatement,
} from "radium-crypto";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { ChatKeyInput, GrantInput, WrapInput } from "../src/e2ee/workspace-contract";

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
    }) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Not logged in");
      return { _id: identity.subject };
    },
    adapter: () => () => ({
      findOne: async () => ({ id: "member", email: "member@example.invalid" }),
    }),
  },
  createAuth: () => ({ options: {} }),
}));
const modules = import.meta.glob("./**/*.ts");
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill).buffer;
const keyId = (fill: number) => toBase64Url(new Uint8Array(16).fill(fill));
const seeds = {
  owner: new Uint8Array(32).fill(1),
  member: new Uint8Array(32).fill(2),
  other: new Uint8Array(32).fill(3),
};

async function fixture() {
  const t = convexTest({ schema, modules });
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Test",
    });
    for (const userId of ["member", "other"]) {
      await ctx.db.insert("workspace_members", { workspace, userId, role: "member" });
    }
    for (const [index, userId] of ["owner", "member", "other"].entries()) {
      await ctx.db.insert("e2ee_identities", {
        userId,
        keyId: keyId(index + 1),
        suite: 1,
        encryptionPublicKey: bytes(1216),
        signingPublicKey: (
          await signingPublicKeyFromSeed(seeds[userId as keyof typeof seeds])
        ).slice().buffer,
        secrets: bytes(1),
        selfSignature: bytes(64),
        recoveryWrapper: bytes(1),
        status: "active",
        createdAt: Date.now(),
      });
    }
    return workspace;
  });
  return {
    t,
    workspace,
    owner: t.withIdentity({ subject: "owner" }),
    member: t.withIdentity({ subject: "member" }),
    other: t.withIdentity({ subject: "other" }),
  };
}
async function grant(
  workspace: Id<"workspaces">,
  userId: keyof typeof seeds,
  epoch = 1,
  signer: keyof typeof seeds = "owner",
  purpose: "member" | "owner" = "member",
  recipientKeyId = keyId(userId === "owner" ? 1 : userId === "member" ? 2 : 3),
): Promise<GrantInput> {
  const sealed = bytes(1200);
  return {
    epoch,
    purpose,
    userId,
    recipientKeyId,
    granterKeyId: keyId(signer === "owner" ? 1 : signer === "member" ? 2 : 3),
    sealed,
    signature: (
      await sign(
        seeds[signer],
        grantStatement({
          workspaceId: workspace,
          epoch,
          purpose,
          recipientUserId: userId,
          recipientKeyId,
          sealed: new Uint8Array(sealed),
        }),
      )
    ).slice().buffer,
  };
}
async function rotation(workspace: Id<"workspaces">, epoch = 1) {
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      workspace,
      version: epoch,
      epoch,
      owner: { userId: "owner", keyId: keyId(1), fingerprint: "owner" },
      epochs: [],
      members: [],
    }),
  );
  return {
    epoch: {
      epoch,
      suite: 1,
      memberKeyId: keyId(10 + epoch),
      memberPublicKey: bytes(1216),
      ownerKeyId: keyId(20 + epoch),
      ownerPublicKey: bytes(1216),
    },
    grants: [
      await grant(workspace, "owner", epoch),
      await grant(workspace, "owner", epoch, "owner", "owner"),
    ],
    roster: {
      version: epoch,
      body: body.buffer,
      signature: (
        await sign(seeds.owner, rosterStatement({ workspaceId: workspace, body }))
      ).slice().buffer,
      signerKeyId: keyId(1),
    },
  };
}
/** Stand-in roster archive chain value after `through`; the server stores it, readers verify it. */
const archiveHash = (through: number) =>
  toBase64Url(new Uint8Array(32).fill(through === 0 ? 0 : (through % 255) + 1));
/** `rotation` with a version-3 roster body: an epoch window plus the archive commitment. */
async function windowedRotation(workspace: Id<"workspaces">, epoch: number) {
  const through = Math.max(0, epoch - ROSTER_EPOCH_WINDOW);
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: 3,
      workspace,
      version: epoch,
      epoch,
      owner: { userId: "owner", keyId: keyId(1), fingerprint: "owner" },
      epochs: [],
      archive: { through, hash: archiveHash(through) },
      members: [],
      workers: [],
    }),
  );
  return {
    ...(await rotation(workspace, epoch)),
    roster: {
      version: epoch,
      body: body.buffer,
      signature: (
        await sign(seeds.owner, rosterStatement({ workspaceId: workspace, body }))
      ).slice().buffer,
      signerKeyId: keyId(1),
    },
  };
}

test("personal and shared chats reject unlisted workspace members through queries and HTTP authorization", async () => {
  const { t, workspace, owner, member } = await fixture();
  const ids = await t.run(async (ctx) => {
    const personal = await ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "personal",
      lastInteractionAt: 1,
    });
    const shared = await ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "shared",
      lastInteractionAt: 2,
    });
    await ctx.db.insert("chat_members", {
      workspace,
      chat: shared,
      userId: "other",
      lastInteractionAt: 2,
    });
    return [personal, shared];
  });
  for (const chatId of ids) {
    await expect(member.query(api.e2ee.chatKeys, { chatId })).rejects.toThrow("Chat not found");
    expect(
      await t.query(internal.workspaces.authorizeChatForUser, { chatId, userId: "member" }),
    ).toBeNull();
    expect(await owner.query(api.e2ee.chatKeys, { chatId })).not.toBeNull();
  }
  expect(
    (
      await member.query(api.aisdk.ListChats, {
        workspace,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page,
  ).toEqual([]);
});

test("owner-only operations and roster signatures fail closed", async () => {
  const { workspace, owner, member } = await fixture();
  const keys = await rotation(workspace);
  await expect(
    member.mutation(api.e2ee.bootstrapWorkspaceKeys, { workspace, ...keys }),
  ).rejects.toThrow();
  await owner.mutation(api.e2ee.bootstrapWorkspaceKeys, { workspace, ...keys });
  await expect(
    member.mutation(api.e2ee.rotateWorkspaceEpoch, {
      workspace,
      ...(await rotation(workspace, 2)),
    }),
  ).rejects.toThrow();
  await expect(
    member.mutation(api.e2ee.publishRoster, { workspace, roster: keys.roster }),
  ).rejects.toThrow();
  await expect(
    member.mutation(api.e2ee.createInvite, {
      workspace,
      inviteId: keyId(30),
      invitedUserId: "other",
      epoch: 1,
      sealed: bytes(10),
      ownerSecret: bytes(10),
    }),
  ).rejects.toThrow();
  await expect(
    owner.mutation(api.e2ee.publishRoster, {
      workspace,
      roster: { ...keys.roster, version: 2, signature: bytes(64) },
    }),
  ).rejects.toThrow();
});

test("invite consumption is intended-account-only, single-use and expiring", async () => {
  const { t, workspace, owner, member, other } = await fixture();
  await owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace,
    ...(await rotation(workspace)),
  });
  const inviteId = keyId(31);
  await owner.mutation(api.e2ee.createInvite, {
    workspace,
    inviteId,
    invitedUserId: "member",
    epoch: 1,
    sealed: bytes(10),
    ownerSecret: bytes(10),
  });
  const args = {
    inviteId,
    keyId: keyId(2),
    mac: bytes(32),
    selfGrant: await grant(workspace, "member", 1, "member"),
  };
  expect(await other.query(api.e2ee.getInvite, { inviteId })).toBeNull();
  await expect(other.mutation(api.e2ee.acceptInvite, args)).rejects.toThrow();
  await member.mutation(api.e2ee.acceptInvite, args);
  await expect(member.mutation(api.e2ee.acceptInvite, args)).rejects.toThrow();
  const state = await owner.query(api.e2ee.workspaceKeyState, { workspace });
  expect(state.joinRequests[0]?.sourceId).toBe(inviteId);
  await owner.mutation(api.e2ee.createInvite, {
    workspace,
    inviteId: keyId(32),
    invitedUserId: "member",
    epoch: 1,
    sealed: bytes(10),
    ownerSecret: bytes(10),
  });
  await t.run(async (ctx) => {
    const invite = await ctx.db.query("e2ee_invites").first();
    await ctx.db.patch("e2ee_invites", invite!._id, { expiresAt: Date.now() - 1 });
  });
  await expect(
    member.mutation(api.e2ee.acceptInvite, { ...args, inviteId: keyId(32) }),
  ).rejects.toThrow();
});

test("grants require active recipients, reject plain self-grants and owner grants replace join proofs", async () => {
  const { workspace, owner, member } = await fixture();
  await owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace,
    ...(await rotation(workspace)),
  });
  await expect(
    owner.mutation(api.e2ee.addGrants, {
      workspace,
      grants: [{ ...(await grant(workspace, "member")), recipientKeyId: keyId(99) }],
    }),
  ).rejects.toThrow();
  await expect(
    member.mutation(api.e2ee.addGrants, {
      workspace,
      grants: [await grant(workspace, "member", 1, "member")],
    }),
  ).rejects.toThrow();
  await member.mutation(api.e2ee.requestKeys, { workspace, keyId: keyId(2) });
  await owner.mutation(api.e2ee.addGrants, {
    workspace,
    grants: [await grant(workspace, "member")],
  });
  expect((await owner.query(api.e2ee.workspaceKeyState, { workspace })).joinRequests).toEqual([]);
});

test("trust store CAS rejects stale writers", async () => {
  const { owner } = await fixture();
  await owner.mutation(api.e2ee.saveTrustStore, {
    expectedVersion: null,
    version: 1,
    envelope: bytes(20),
  });
  await expect(
    owner.mutation(api.e2ee.saveTrustStore, {
      expectedVersion: null,
      version: 1,
      envelope: bytes(20),
    }),
  ).rejects.toThrow("TRUST_STORE_CONFLICT");
  await owner.mutation(api.e2ee.saveTrustStore, {
    expectedVersion: 1,
    version: 2,
    envelope: bytes(20),
  });
  expect((await owner.query(api.e2ee.getTrustStore, {}))?.version).toBe(2);
});

test("keyed scope narrowing requires rotation", async () => {
  const { t, workspace, owner } = await fixture();
  const chatId = await t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "workspace",
      e2eeId: keyId(40),
      keyEpoch: 1,
      lastInteractionAt: 1,
    }),
  );
  await expect(
    owner.mutation(api.aisdk.SetChatScope, { chatId, scope: "personal" }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
});

test("member removal requires atomic rotation and revokes shared-chat membership", async () => {
  const { t, workspace, owner } = await fixture();
  await owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace,
    ...(await rotation(workspace)),
  });
  const chatId = await t.run(async (ctx) => {
    const chat = await ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "shared",
      e2eeId: keyId(41),
      keyEpoch: 1,
      lastInteractionAt: 1,
    });
    await ctx.db.insert("chat_members", {
      chat,
      workspace,
      userId: "member",
      lastInteractionAt: 1,
    });
    return chat;
  });
  await expect(
    owner.mutation(api.workspaces.removeMember, { workspace, email: "member@example.invalid" }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
  await owner.mutation(api.workspaces.removeMember, {
    workspace,
    email: "member@example.invalid",
    rotation: await rotation(workspace, 2),
  });
  await t.run(async (ctx) => {
    expect(await ctx.db.query("chat_members").first()).toBeNull();
    expect((await ctx.db.get("aisdk_chats", chatId))?.rekey).toBe(true);
    expect((await ctx.db.get("workspaces", workspace))?.keyEpoch).toBe(2);
  });
});

test("workspace keys rotate past the roster window and the former 200-epoch cap", async () => {
  const { t, workspace, owner, member } = await fixture();
  await owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace,
    ...(await windowedRotation(workspace, 1)),
  });
  const last = ROSTER_EPOCH_WINDOW + 3;
  for (let epoch = 2; epoch <= last; epoch++) {
    await owner.mutation(api.e2ee.rotateWorkspaceEpoch, {
      workspace,
      ...(await windowedRotation(workspace, epoch)),
    });
  }

  // Key state is the window only: the newest epochs and the grants of those epochs.
  const state = await owner.query(api.e2ee.workspaceKeyState, { workspace });
  const window = Array.from({ length: ROSTER_EPOCH_WINDOW }, (_, index) => index + 4);
  expect(state.epochs.map((row) => row.epoch)).toEqual(window);
  expect([...new Set(state.myGrants.map((row) => row.epoch))].sort((a, b) => a - b)).toEqual(window);

  // Archived rows come with the caller's grants and the chain value the roster archived them at.
  const page = await owner.query(api.e2ee.workspaceArchivedEpochs, {
    workspace,
    fromEpoch: 3,
    toEpoch: 3,
  });
  expect(page.prefixHash).toBe(archiveHash(2));
  expect(page.epochs.map((row) => row.epoch)).toEqual([3]);
  expect(page.myGrants.map((row) => row.epoch)).toEqual([3, 3]);
  const first = await member.query(api.e2ee.workspaceArchivedEpochs, {
    workspace,
    fromEpoch: 1,
    toEpoch: 3,
  });
  expect(first.prefixHash).toBeNull();
  expect(first.epochs.map((row) => row.epoch)).toEqual([1, 2, 3]);
  expect(first.myGrants).toEqual([]);
  await expect(
    owner.query(api.e2ee.workspaceArchivedEpochs, { workspace, fromEpoch: last, toEpoch: last + 1 }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");

  // Rotation and member removal continue beyond the former cap.
  await t.run((ctx) => ctx.db.patch("workspaces", workspace, { keyEpoch: 200 }));
  await owner.mutation(api.e2ee.rotateWorkspaceEpoch, {
    workspace,
    ...(await windowedRotation(workspace, 201)),
  });
  await owner.mutation(api.workspaces.removeMember, {
    workspace,
    email: "member@example.invalid",
    rotation: await windowedRotation(workspace, 202),
  });
  await t.run(async (ctx) => {
    expect((await ctx.db.get("workspaces", workspace))?.keyEpoch).toBe(202);
  });
  await expect(
    owner.query(api.e2ee.workspaceArchivedEpochs, { workspace, fromEpoch: 1, toEpoch: 65 }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
});

test("shared Home rows include only listed members and expose their encrypted title wrap", async () => {
  const { t, workspace, owner, member, other } = await fixture();
  const chatId = await t.run(async (ctx) => {
    const chat = await ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "shared",
      e2eeId: keyId(50),
      keyEpoch: 1,
      lastInteractionAt: 5,
      sealedTitle: { epoch: 1, box: bytes(20) },
    });
    await ctx.db.insert("chat_members", {
      chat,
      workspace,
      userId: "member",
      lastInteractionAt: 5,
    });
    await ctx.db.insert("e2ee_chat_key_wraps", {
      chat,
      workspace,
      chatEpoch: 1,
      recipient: "identity",
      userId: "member",
      recipientKeyId: keyId(2),
      sealed: bytes(20),
    });
    return chat;
  });
  const args = { workspace, paginationOpts: { numItems: 10, cursor: null } };
  const rows = (await member.query(api.aisdk.ListChats, args)).page;
  expect(rows.map((row) => row.id)).toEqual([chatId]);
  expect(rows[0]?.e2ee?.wrap?.userId).toBe("member");
  expect((await other.query(api.aisdk.ListChats, args)).page).toEqual([]);
  expect((await owner.query(api.aisdk.ListChats, args)).page.map((row) => row.id)).toEqual([
    chatId,
  ]);
});

test("historical directory returns retired identities but hides pending and unrelated keys", async () => {
  const { t, owner } = await fixture();
  await t.run(async (ctx) => {
    const member = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_keyId", (q) => q.eq("keyId", keyId(2)))
      .unique();
    await ctx.db.patch("e2ee_identities", member!._id, { status: "retired" });
    const other = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_keyId", (q) => q.eq("keyId", keyId(3)))
      .unique();
    await ctx.db.patch("e2ee_identities", other!._id, { status: "pending" });
  });
  const rows = await owner.query(api.e2ee.identityKeysByKeyId, { keyIds: [keyId(2), keyId(3)] });
  expect(rows[0]?.status).toBe("retired");
  expect(rows[1]).toBeNull();
  const outsider = t.withIdentity({ subject: "outsider" });
  await expect(
    outsider.query(api.e2ee.identityKeysByKeyId, { keyIds: [keyId(2)] }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
});

test("chat key setup requires complete active-identity recipient coverage", async () => {
  const { t, workspace, owner } = await fixture();
  const chatId = await t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "shared",
      lastInteractionAt: 1,
    }),
  );
  await owner.mutation(api.aisdk.SetChatScope, { chatId, scope: "shared", members: ["member"] });
  const keys = {
    e2eeId: keyId(60),
    epoch: await chatEpochInput(workspace, keyId(60), 1, "owner", {
      chat: chatId,
      scope: "shared",
      creatorId: "owner",
      members: ["member"],
    }),
    wraps: [identityWrap("owner")],
  };
  await expect(owner.mutation(api.e2ee.setupChatKeys, { chatId, keys })).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  keys.wraps.push({ ...identityWrap("member"), recipientKeyId: keyId(99) });
  await expect(owner.mutation(api.e2ee.setupChatKeys, { chatId, keys })).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  keys.wraps[1]!.recipientKeyId = keyId(2);
  await owner.mutation(api.e2ee.setupChatKeys, { chatId, keys });
  expect((await owner.query(api.e2ee.chatKeys, { chatId })).keyEpoch).toBe(1);
});

/** An identity wrap of epoch one for a fixture user (key IDs 1, 2 and 3). */
const identityWrap = (userId: keyof typeof seeds) => ({
  chatEpoch: 1,
  recipient: "identity" as const,
  userId,
  recipientKeyId: keyId(userId === "owner" ? 1 : userId === "member" ? 2 : 3),
  sealed: bytes(1200),
});

async function keylessChat(
  f: Awaited<ReturnType<typeof fixture>>,
  creator: keyof typeof seeds,
  scope: "personal" | "shared" | "workspace",
  members?: string[],
) {
  const chatId = await f.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", { workspace: f.workspace, userId: creator, scope, lastInteractionAt: 1 }),
  );
  if (members) {
    await f[creator].mutation(api.aisdk.SetChatScope, { chatId, scope: "shared", members });
  }
  return chatId;
}

const chatEpochRows = (f: Awaited<ReturnType<typeof fixture>>, chat: Id<"aisdk_chats">) =>
  f.t.run((ctx) =>
    ctx.db
      .query("e2ee_chat_keys")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat))
      .collect(),
  );

test("any current reader bootstraps a keyless chat with their own signature and its exact audience", async () => {
  const f = await fixture();
  const chatId = await keylessChat(f, "owner", "shared", ["member"]);
  const e2eeId = keyId(60);
  const audience = [identityWrap("owner"), identityWrap("member")];
  const policy = {
    chat: chatId,
    scope: "shared" as const,
    creatorId: "owner",
    members: ["member"],
  };
  const signed = await chatEpochInput(f.workspace, e2eeId, 1, "member", policy);
  const setup = (user: "owner" | "member" | "other", epoch: typeof signed, wraps = audience, id = e2eeId) =>
    f[user].mutation(api.e2ee.setupChatKeys, { chatId, keys: { e2eeId: id, epoch, wraps } });

  // A workspace member outside the shared chat is not a reader.
  await expect(setup("other", await chatEpochInput(f.workspace, e2eeId, 1, "other", policy))).rejects.toThrow(
    "Chat not found",
  );
  // Unsigned, or signed by an identity other than the caller's.
  const { signature: _signature, signerKeyId: _signerKeyId, ...unsigned } = signed;
  await expect(setup("member", unsigned as typeof signed)).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(setup("member", await chatEpochInput(f.workspace, e2eeId, 1, "owner", policy))).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  // The creator must be covered and nobody may be added.
  await expect(setup("member", signed, [identityWrap("member")])).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(setup("member", signed, [...audience, identityWrap("other")])).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  // A binding proof is required, and it must be for this chat and exactly this audience.
  const { bindingSignature: _binding, bindingMembers: _bound, ...v1Only } = signed;
  await expect(setup("member", v1Only as typeof signed)).rejects.toThrow("E2EE_KEYS_INVALID");
  const elsewhere = await keylessChat(f, "owner", "shared", ["member"]);
  await expect(
    setup("member", await chatEpochInput(f.workspace, e2eeId, 1, "member", { ...policy, chat: elsewhere })),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(
    setup("member", await chatEpochInput(f.workspace, e2eeId, 1, "member", { ...policy, members: [] })),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(
    setup("member", await chatEpochInput(f.workspace, e2eeId, 1, "member", { ...policy, scope: "workspace" })),
  ).rejects.toThrow("E2EE_KEYS_INVALID");

  await setup("member", signed);
  const stored = await chatEpochRows(f, chatId);
  expect(stored).toMatchObject([
    {
      epoch: 1,
      keyId: signed.keyId,
      signerUserId: "member",
      signerKeyId: keyId(2),
      bindingMembers: ["member"],
    },
  ]);
  expect(stored[0]?.bindingSignature?.byteLength).toBe(64);
  expect(await f.owner.query(api.e2ee.chatKeys, { chatId })).toMatchObject({
    e2eeId,
    keyEpoch: 1,
    creatorId: "owner",
    members: ["member"],
  });

  // A concurrent or later setup, even by the creator, never replaces the stored epoch.
  const loser = keyId(61);
  await expect(
    setup("owner", await chatEpochInput(f.workspace, loser, 1, "owner", policy), audience, loser),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
  expect(await chatEpochRows(f, chatId)).toEqual(stored);
  expect(await wrapRows(f, chatId)).toHaveLength(2);
});

test("a removed creator is neither a reader nor a recipient, and personal chats stay creator-only", async () => {
  const f = await fixture();
  const shared = await keylessChat(f, "other", "shared", ["member"]);
  await f.t.run(async (ctx) => {
    const membership = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_userId", (q) => q.eq("workspace", f.workspace).eq("userId", "other"))
      .unique();
    await ctx.db.delete("workspace_members", membership!._id);
  });
  const e2eeId = keyId(62);
  const sharedPolicy = {
    chat: shared,
    scope: "shared" as const,
    creatorId: "other",
    members: ["member"],
  };
  const keys = async (signer: keyof typeof seeds, wraps: WrapInput[], policy = sharedPolicy) => ({
    e2eeId,
    epoch: await chatEpochInput(f.workspace, e2eeId, 1, signer, policy),
    wraps,
  });
  await expect(
    f.other.mutation(api.e2ee.setupChatKeys, { chatId: shared, keys: await keys("other", [identityWrap("member")]) }),
  ).rejects.toThrow("Chat not found");
  await expect(
    f.member.mutation(api.e2ee.setupChatKeys, {
      chatId: shared,
      keys: await keys("member", [identityWrap("member"), identityWrap("other")]),
    }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
  await f.member.mutation(api.e2ee.setupChatKeys, {
    chatId: shared,
    keys: await keys("member", [identityWrap("member")]),
  });
  expect(await chatEpochRows(f, shared)).toMatchObject([{ signerUserId: "member" }]);

  const personal = await keylessChat(f, "member", "personal");
  const personalPolicy = {
    chat: personal,
    scope: "personal" as const,
    creatorId: "member",
  };
  await expect(
    f.owner.mutation(api.e2ee.setupChatKeys, {
      chatId: personal,
      keys: await keys("owner", [identityWrap("member")], personalPolicy),
    }),
  ).rejects.toThrow("Chat not found");
  await f.member.mutation(api.e2ee.setupChatKeys, {
    chatId: personal,
    keys: await keys("member", [identityWrap("member")], personalPolicy),
  });
});

test("a removed picked member left behind by an unfinished removal batch is excluded, not required", async () => {
  const f = await fixture();
  const chatId = await keylessChat(f, "owner", "shared", ["member", "other"]);
  // `removeMember` deleted the membership; the batch that deletes `chat_members` has not run yet.
  await f.t.run(async (ctx) => {
    const membership = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_userId", (q) => q.eq("workspace", f.workspace).eq("userId", "other"))
      .unique();
    await ctx.db.delete("workspace_members", membership!._id);
  });
  const e2eeId = keyId(64);
  const policy = {
    chat: chatId,
    scope: "shared" as const,
    creatorId: "owner",
    members: ["member", "other"],
  };
  const epoch = await chatEpochInput(f.workspace, e2eeId, 1, "member", policy);
  const current = [identityWrap("owner"), identityWrap("member")];
  const setup = (user: "member" | "other", wraps: WrapInput[], signed = epoch) =>
    f[user].mutation(api.e2ee.setupChatKeys, { chatId, keys: { e2eeId, epoch: signed, wraps } });

  // The leaver can neither act nor receive the new key.
  await expect(setup("other", [...current, identityWrap("other")], await chatEpochInput(f.workspace, e2eeId, 1, "other", policy)))
    .rejects.toThrow("Chat not found");
  await expect(setup("member", [...current, identityWrap("other")])).rejects.toThrow("E2EE_KEYS_INVALID");
  await setup("member", current);
  // The raw membership is kept, so scope changes and rekey still see the removal.
  expect((await f.member.query(api.e2ee.chatKeys, { chatId })).members).toEqual(["member", "other"]);

  // A revocation rotation covers the same current audience.
  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chatId, { rekey: true }));
  const next = current.map((wrap) => ({ ...wrap, chatEpoch: 2 }));
  const rotate = async (wraps: WrapInput[]) =>
    f.member.mutation(api.e2ee.rotateChatKey, {
      chatId,
      epoch: await chatEpochInput(f.workspace, e2eeId, 2, "member", policy),
      wraps,
    });
  await expect(rotate([...next, { ...identityWrap("other"), chatEpoch: 2 }])).rejects.toThrow("E2EE_KEYS_INVALID");
  await rotate(next);
  expect(await f.member.query(api.e2ee.chatKeys, { chatId })).toMatchObject({ keyEpoch: 2, rekey: false });
});

test("missing recipient or workspace keys keep a keyless chat waiting", async () => {
  const f = await fixture();
  const shared = await keylessChat(f, "owner", "shared", ["member"]);
  await f.t.run(async (ctx) => {
    const identity = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", "member").eq("status", "active"))
      .unique();
    await ctx.db.patch("e2ee_identities", identity!._id, { status: "retired", retiredAt: 1 });
  });
  const e2eeId = keyId(63);
  const epoch = await chatEpochInput(f.workspace, e2eeId, 1, "owner", {
    chat: shared,
    scope: "shared",
    creatorId: "owner",
    members: ["member"],
  });
  for (const wraps of [[identityWrap("owner")], [identityWrap("owner"), identityWrap("member")]]) {
    await expect(
      f.owner.mutation(api.e2ee.setupChatKeys, { chatId: shared, keys: { e2eeId, epoch, wraps } }),
    ).rejects.toThrow("E2EE_KEYS_INVALID");
  }

  const workspaceChat = await keylessChat(f, "owner", "workspace");
  const workspaceKeys = async () => ({
    e2eeId,
    epoch: await chatEpochInput(f.workspace, e2eeId, 1, "other", {
      chat: workspaceChat,
      scope: "workspace",
      creatorId: "owner",
    }),
    wraps: [workspaceWrap(1, 1, 100)],
  });
  await expect(
    f.other.mutation(api.e2ee.setupChatKeys, { chatId: workspaceChat, keys: await workspaceKeys() }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  await f.other.mutation(api.e2ee.setupChatKeys, { chatId: workspaceChat, keys: await workspaceKeys() });
  expect(await chatEpochRows(f, workspaceChat)).toMatchObject([{ signerUserId: "other" }]);
});

async function roster(
  workspace: Id<"workspaces">,
  version: number,
  epoch: number,
  members: Array<{ userId: string; keyId: string }>,
) {
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      workspace,
      version,
      epoch,
      owner: { userId: "owner", keyId: keyId(1), fingerprint: "owner" },
      epochs: [],
      members: members.map((member) => ({ ...member, fingerprint: member.userId })),
    }),
  );
  return {
    version,
    body: body.buffer,
    signature: (await sign(seeds.owner, rosterStatement({ workspaceId: workspace, body }))).slice()
      .buffer,
    signerKeyId: keyId(1),
  };
}

/** The declared audience a chat key binding signs: raw picked members matter only when shared. */
type BindingPolicy = {
  chat: Id<"aisdk_chats">;
  scope: "personal" | "shared" | "workspace";
  creatorId: string;
  members?: string[];
};

/** A real chat epoch signed by a fixture user, with a binding proof when `bind` is given. */
async function chatEpochInput(
  workspace: Id<"workspaces">,
  e2eeId: string,
  epoch: number,
  signer: keyof typeof seeds,
  bind?: BindingPolicy,
): Promise<ChatKeyInput> {
  const publicKey = bytes(1216, 9);
  const id = keyId(70 + epoch);
  const input: ChatKeyInput = {
    epoch,
    keyId: id,
    suite: 1,
    publicKey,
    signerKeyId: keyId(signer === "owner" ? 1 : signer === "member" ? 2 : 3),
    signature: (
      await sign(
        seeds[signer],
        chatKeyStatement({
          workspaceId: workspace,
          chatE2eeId: e2eeId,
          epoch,
          keyId: id,
          suite: 1,
          publicKey: new Uint8Array(publicKey),
        }),
      )
    ).slice().buffer,
  };
  if (!bind) {
    return input;
  }
  const members = bind.scope === "shared" ? [...new Set(bind.members ?? [])].sort() : [];
  return {
    ...input,
    bindingSignature: (
      await sign(
        seeds[signer],
        chatKeyBindingStatement({
          chatId: bind.chat,
          workspaceId: workspace,
          chatE2eeId: e2eeId,
          epoch,
          keyId: id,
          suite: 1,
          publicKey: new Uint8Array(publicKey),
          scope: bind.scope,
          creatorId: bind.creatorId,
          members,
        }),
      )
    ).slice().buffer,
    bindingMembers: bind.scope === "shared" ? members : undefined,
  };
}

/** A workspace wrap input sealed to the member key of `workspaceEpoch` (fixture key IDs `10 + n`). */
const workspaceWrap = (chatEpoch: number, workspaceEpoch: number, sealedBytes: number) => ({
  chatEpoch,
  recipient: "workspace" as const,
  workspaceEpoch,
  recipientKeyId: keyId(10 + workspaceEpoch),
  sealed: bytes(sealedBytes),
});

/** A keyed chat whose epoch one is really signed and bound by its creator (not stale, no wraps). */
async function keyedWorkspaceChat(
  f: Awaited<ReturnType<typeof fixture>>,
  creator: "owner" | "member",
  scope: "workspace" | "personal" = "workspace",
) {
  const e2eeId = keyId(80);
  const chat = await f.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace: f.workspace,
      userId: creator,
      scope,
      e2eeId,
      keyEpoch: 1,
      lastInteractionAt: 1,
    }),
  );
  const epoch = await chatEpochInput(f.workspace, e2eeId, 1, creator, {
    chat,
    scope,
    creatorId: creator,
  });
  await f.t.run((ctx) =>
    ctx.db.insert("e2ee_chat_keys", {
      ...epoch,
      chat,
      workspace: f.workspace,
      signerUserId: creator,
      // After the workspace keys of these fixtures, so a freshly keyed chat is not stale.
      createdAt: Date.now() + 60_000,
    }),
  );
  return { chat, e2eeId };
}

const wrapRows = (f: Awaited<ReturnType<typeof fixture>>, chat: Id<"aisdk_chats">) =>
  f.t.run((ctx) =>
    ctx.db
      .query("e2ee_chat_key_wraps")
      .withIndex("by_chat_and_chatEpoch_and_recipientKeyId", (q) => q.eq("chat", chat))
      .collect(),
  );

test("removing a member with more than one batch of chats finishes through continuations", async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture();
    const count = 1100;
    const personal = await f.t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        const chat = await ctx.db.insert("aisdk_chats", {
          workspace: f.workspace,
          userId: "owner",
          scope: "shared",
          lastInteractionAt: i,
        });
        await ctx.db.insert("chat_members", {
          chat,
          workspace: f.workspace,
          userId: "member",
          lastInteractionAt: i,
        });
        await ctx.db.insert("aisdk_chats", {
          workspace: f.workspace,
          userId: "member",
          scope: "shared",
          lastInteractionAt: i,
        });
      }
      return await ctx.db.insert("aisdk_chats", {
        workspace: f.workspace,
        userId: "member",
        scope: "personal",
        lastInteractionAt: 1,
      });
    });
    await f.owner.mutation(api.workspaces.removeMember, {
      workspace: f.workspace,
      email: "member@example.invalid",
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("chat_members").collect()).toEqual([]);
      const chats = await ctx.db.query("aisdk_chats").collect();
      const shared = chats.filter((chat) => chat.scope === "shared");
      expect(shared).toHaveLength(2 * count);
      expect(shared.every((chat) => chat.rekey === true)).toBe(true);
      expect((await ctx.db.get("aisdk_chats", personal))?.rekey).toBeUndefined();
    });
  } finally {
    vi.useRealTimers();
  }
});

test("only the chat creator or workspace owner replace an existing chat key wrap", async () => {
  const f = await fixture();
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  const { chat } = await keyedWorkspaceChat(f, "member");
  const sizes = async () => (await wrapRows(f, chat)).map((row) => row.sealed.byteLength);
  const add = (user: "owner" | "member" | "other", size: number) =>
    f[user].mutation(api.e2ee.addChatKeyWraps, {
      chatId: chat,
      wraps: [workspaceWrap(1, 1, size)],
    });

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
  await expect(add("member", 5000)).rejects.toThrow("E2EE_KEYS_INVALID");
});

test("owner rewrap replaces junk at the current epoch and drops wraps of narrowed chats", async () => {
  const f = await fixture();
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  await f.owner.mutation(api.e2ee.rotateWorkspaceEpoch, {
    workspace: f.workspace,
    ...(await rotation(f.workspace, 2)),
  });
  const { chat } = await keyedWorkspaceChat(f, "member");
  const narrowed = (await keyedWorkspaceChat(f, "member", "personal")).chat;
  await f.t.run(async (ctx) => {
    for (const [target, workspaceEpoch, size] of [
      [chat, 1, 100],
      [chat, 2, 10],
      [narrowed, 1, 100],
    ] as const) {
      await ctx.db.insert("e2ee_chat_key_wraps", {
        ...workspaceWrap(1, workspaceEpoch, size),
        chat: target,
        workspace: f.workspace,
      });
    }
  });
  const stale = await f.owner.query(api.e2ee.staleWorkspaceWraps, {
    workspace: f.workspace,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(stale.page).toHaveLength(2);
  await f.owner.mutation(api.e2ee.replaceWorkspaceWraps, {
    workspace: f.workspace,
    replacements: stale.page.map((old) => ({ oldWrap: old._id, wrap: workspaceWrap(1, 2, 64) })),
  });
  const rows = await wrapRows(f, chat);
  expect(rows.map((row) => [row.workspaceEpoch, row.sealed.byteLength])).toEqual([[2, 64]]);
  expect(await wrapRows(f, narrowed)).toEqual([]);
});

test("narrowing a chat away from workspace scope deletes its workspace wraps", async () => {
  const f = await fixture();
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  const { chat, e2eeId } = await keyedWorkspaceChat(f, "owner");
  await f.t.run((ctx) =>
    ctx.db.insert("e2ee_chat_key_wraps", {
      ...workspaceWrap(1, 1, 100),
      chat,
      workspace: f.workspace,
    }),
  );
  await f.owner.mutation(api.aisdk.SetChatScope, {
    chatId: chat,
    scope: "personal",
    keys: {
      rotate: await chatEpochInput(f.workspace, e2eeId, 2, "owner", {
        chat,
        scope: "personal",
        creatorId: "owner",
      }),
      wraps: [
        {
          chatEpoch: 2,
          recipient: "identity",
          userId: "owner",
          recipientKeyId: keyId(1),
          sealed: bytes(1200),
        },
      ],
    },
  });
  expect((await wrapRows(f, chat)).map((row) => row.recipient)).toEqual(["identity"]);
});

test("owner grants replace member re-grants, which never count as granted or suppress requests", async () => {
  const f = await fixture();
  const { workspace } = f;
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace,
    ...(await rotation(workspace)),
  });
  await f.owner.mutation(api.e2ee.publishRoster, {
    workspace,
    roster: await roster(workspace, 2, 1, [
      { userId: "member", keyId: keyId(2) },
      { userId: "other", keyId: keyId(3) },
    ]),
  });
  await f.owner.mutation(api.e2ee.addGrants, {
    workspace,
    grants: [await grant(workspace, "member")],
  });
  // A member's re-grant (possibly junk) must not hide the missing owner-signed grant.
  await f.member.mutation(api.e2ee.addGrants, {
    workspace,
    grants: [await grant(workspace, "other", 1, "member")],
  });
  const grantedEpoch = async () =>
    (await f.owner.query(api.e2ee.workspaceKeyState, { workspace })).members.find(
      (member) => member.userId === "other",
    )?.grantedEpoch;
  expect(await grantedEpoch()).toBeNull();
  await f.other.mutation(api.e2ee.requestKeys, { workspace, keyId: keyId(3) });
  expect(
    (await f.owner.query(api.e2ee.workspaceKeyState, { workspace })).joinRequests.map(
      (request) => request.userId,
    ),
  ).toEqual(["other"]);

  await f.owner.mutation(api.e2ee.addGrants, {
    workspace,
    grants: [await grant(workspace, "other")],
  });
  const rows = await f.t.run((ctx) =>
    ctx.db
      .query("e2ee_workspace_grants")
      .withIndex("by_workspace_and_userId_and_epoch", (q) =>
        q.eq("workspace", workspace).eq("userId", "other"),
      )
      .collect(),
  );
  expect(rows.map((row) => row.granterUserId)).toEqual(["owner"]);
  expect(await grantedEpoch()).toBe(1);
  expect((await f.owner.query(api.e2ee.workspaceKeyState, { workspace })).joinRequests).toEqual([]);
});

test("member re-grants must target the identity pinned in the signed roster", async () => {
  const f = await fixture();
  const { workspace } = f;
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace,
    ...(await rotation(workspace)),
  });
  await f.owner.mutation(api.e2ee.publishRoster, {
    workspace,
    roster: await roster(workspace, 2, 1, [{ userId: "other", keyId: keyId(3) }]),
  });
  await f.owner.mutation(api.e2ee.addGrants, {
    workspace,
    grants: [await grant(workspace, "member")],
  });
  await f.t.run(async (ctx) => {
    const old = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_keyId", (q) => q.eq("keyId", keyId(3)))
      .unique();
    await ctx.db.patch("e2ee_identities", old!._id, { status: "retired" });
    const { _id, _creationTime, ...identity } = old!;
    await ctx.db.insert("e2ee_identities", { ...identity, keyId: keyId(7), status: "active" });
  });
  await expect(
    f.member.mutation(api.e2ee.addGrants, {
      workspace,
      grants: [await grant(workspace, "other", 1, "member", "member", keyId(7))],
    }),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
});

test("non-creators rotate a chat key only when it needs rotation, and epochs are not capped", async () => {
  const f = await fixture();
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  const { chat, e2eeId } = await keyedWorkspaceChat(f, "member");
  await f.t.run((ctx) =>
    ctx.db.insert("e2ee_chat_key_wraps", {
      ...workspaceWrap(1, 1, 100),
      chat,
      workspace: f.workspace,
    }),
  );
  const rotate = async (user: "member" | "other", epoch: number) => ({
    chatId: chat,
    epoch: await chatEpochInput(f.workspace, e2eeId, epoch, user, {
      chat,
      scope: "workspace",
      creatorId: "member",
    }),
    wraps: [workspaceWrap(epoch, 1, 100)],
  });
  await expect(f.other.mutation(api.e2ee.rotateChatKey, await rotate("other", 2))).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );

  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { rekey: true }));
  await f.other.mutation(api.e2ee.rotateChatKey, await rotate("other", 2));
  await expect(f.other.mutation(api.e2ee.rotateChatKey, await rotate("other", 3))).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  await f.member.mutation(api.e2ee.rotateChatKey, await rotate("member", 3));

  // Past the former 200-epoch cap: rotation continues and `chatKeys` serves a bounded window, or
  // exactly the epoch asked for.
  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { keyEpoch: 250 }));
  await f.member.mutation(api.e2ee.rotateChatKey, await rotate("member", 251));
  const window = await f.member.query(api.e2ee.chatKeys, { chatId: chat });
  expect(window.keyEpoch).toBe(251);
  expect(window.epochs.map((row) => row.epoch)).toEqual([1, 2, 3, 251]);
  const single = await f.member.query(api.e2ee.chatKeys, { chatId: chat, epoch: 2 });
  expect(single.epochs.map((row) => row.epoch)).toEqual([2]);
  expect(single.wraps.every((wrap) => wrap.chatEpoch === 2)).toBe(true);
});

test("sealing info is withheld while a chat key predates the workspace key or awaits rekey", async () => {
  const f = await fixture();
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  const { chat } = await keyedWorkspaceChat(f, "member");
  const info = () => f.t.query(internal.aisdk.chatSealingInfo, { chatId: chat });
  const stale = async () =>
    (await f.member.query(api.e2ee.chatKeys, { chatId: chat })).staleForWorkspace;
  expect(await info()).not.toBeNull();
  expect(await stale()).toBe(false);

  // The workspace rotates after the chat's current epoch was made (its row predates it).
  await f.owner.mutation(api.e2ee.rotateWorkspaceEpoch, {
    workspace: f.workspace,
    ...(await rotation(f.workspace, 2)),
  });
  await f.t.run(async (ctx) => {
    const key = await ctx.db.query("e2ee_chat_keys").first();
    await ctx.db.patch("e2ee_chat_keys", key!._id, { createdAt: 1 });
  });
  expect(await info()).toBeNull();
  expect(await stale()).toBe(true);
  // Rewrapping the old epoch to the new workspace key does not make it safe to write.
  await f.t.run((ctx) =>
    ctx.db.insert("e2ee_chat_key_wraps", {
      ...workspaceWrap(1, 2, 100),
      chat,
      workspace: f.workspace,
    }),
  );
  expect(await info()).toBeNull();

  const refreshed = await chatEpochInput(f.workspace, keyId(80), 2, "member", {
    chat,
    scope: "workspace",
    creatorId: "member",
  });
  await f.t.run(async (ctx) => {
    await ctx.db.insert("e2ee_chat_keys", {
      ...refreshed,
      chat,
      workspace: f.workspace,
      signerUserId: "member",
      createdAt: Date.now() + 60_000,
    });
    await ctx.db.patch("aisdk_chats", chat, { keyEpoch: 2 });
  });
  // An unbound current epoch is never a sealing target, even when it is fresh.
  await f.t.run(async (ctx) => {
    const key = await ctx.db.query("e2ee_chat_keys").withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat).eq("epoch", 2)).unique();
    await ctx.db.patch("e2ee_chat_keys", key!._id, { bindingSignature: undefined });
  });
  expect(await info()).toBeNull();
  await f.t.run(async (ctx) => {
    const key = await ctx.db.query("e2ee_chat_keys").withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat).eq("epoch", 2)).unique();
    await ctx.db.patch("e2ee_chat_keys", key!._id, { bindingSignature: refreshed.bindingSignature });
  });
  expect(await info()).not.toBeNull();
  expect(await stale()).toBe(false);
  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { rekey: true }));
  expect(await info()).toBeNull();
});

/** A chat whose epoch one is its creator's unsigned locked-device root (no signer fields). */
async function unsignedRootChat(
  f: Awaited<ReturnType<typeof fixture>>,
  creator: string,
  scope: "workspace" | "personal",
) {
  const e2eeId = keyId(80);
  const chat = await f.t.run(async (ctx) => {
    const chat = await ctx.db.insert("aisdk_chats", {
      workspace: f.workspace,
      userId: creator,
      scope,
      e2eeId,
      keyEpoch: 1,
      lastInteractionAt: 1,
    });
    await ctx.db.insert("e2ee_chat_keys", {
      chat,
      workspace: f.workspace,
      epoch: 1,
      keyId: keyId(71),
      suite: 1,
      publicKey: bytes(1216, 9),
      createdAt: Date.now() + 60_000,
    });
    return chat;
  });
  const pin = { userId: creator, e2eeId, epoch: 1, publicKey: bytes(1216, 9) };
  const info = (recipient?: typeof pin) =>
    f.t.query(internal.aisdk.chatSealingInfo, { chatId: chat, ...(recipient ? { recipient } : {}) });
  const patchKey = (patch: Record<string, unknown>) =>
    f.t.run(async (ctx) => {
      const key = await ctx.db.query("e2ee_chat_keys").withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat).eq("epoch", 1)).unique();
      await ctx.db.patch("e2ee_chat_keys", key!._id, patch);
    });
  return { chat, e2eeId, pin, info, patchKey };
}

test("only the creator's exact pin seals to its own unsigned recoverable personal root", async () => {
  const f = await fixture();
  const { chat, pin, info, patchKey } = await unsignedRootChat(f, "member", "personal");
  await f.t.run((ctx) =>
    ctx.db.insert("e2ee_chat_key_wraps", {
      chat,
      workspace: f.workspace,
      chatEpoch: 1,
      recipient: "identity",
      userId: "member",
      recipientKeyId: keyId(2),
      sealed: bytes(100),
    }),
  );
  expect(await info(pin)).toMatchObject({ epoch: 1, keyId: keyId(71) });
  // Unbound keys never seal without the sender's pin (Node/background writers).
  expect(await info()).toBeNull();
  // Same public key under another epoch or chat identity, or a swapped key, is not this pin.
  expect(await info({ ...pin, epoch: 2 })).toBeNull();
  expect(await info({ ...pin, e2eeId: keyId(81) })).toBeNull();
  expect(await info({ ...pin, publicKey: bytes(1216, 8) })).toBeNull();
  // Another actor's exact pin never uses the creator's exception.
  expect(await info({ ...pin, userId: "owner" })).toBeNull();
  // Partial signer fields mean it is not the creator's untouched unsigned root.
  await patchKey({ signerKeyId: keyId(2) });
  expect(await info(pin)).toBeNull();
  await patchKey({ signerKeyId: undefined });
  expect(await info(pin)).not.toBeNull();
  // A revocation race leaves the key stale.
  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { rekey: true }));
  expect(await info(pin)).toBeNull();
  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { rekey: undefined }));
  expect(await info(pin)).not.toBeNull();
  // A reset retires the identity the only wrap targets: nothing current could open new content.
  await f.t.run(async (ctx) => {
    const old = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", "member").eq("status", "active"))
      .unique();
    await ctx.db.patch("e2ee_identities", old!._id, { status: "retired" });
    const { _id, _creationTime, ...identity } = old!;
    await ctx.db.insert("e2ee_identities", { ...identity, keyId: keyId(9), status: "active" });
  });
  expect(await info(pin)).toBeNull();
});

test("an unsigned workspace root needs a current workspace wrap and member key availability", async () => {
  const f = await fixture();
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  const { chat, pin, info } = await unsignedRootChat(f, "member", "workspace");
  expect(await info(pin)).toBeNull();
  const wrap = await f.t.run((ctx) =>
    ctx.db.insert("e2ee_chat_key_wraps", {
      ...workspaceWrap(1, 1, 100),
      chat,
      workspace: f.workspace,
    }),
  );
  expect(await info(pin)).not.toBeNull();
  expect(await info()).toBeNull();
  // `other` reads this workspace chat, but is not its creator.
  expect(await info({ ...pin, userId: "other" })).toBeNull();
  await f.t.run((ctx) => ctx.db.delete("e2ee_chat_key_wraps", wrap));
  expect(await info(pin)).toBeNull();
  await f.t.run((ctx) =>
    ctx.db.insert("e2ee_chat_key_wraps", {
      ...workspaceWrap(1, 1, 100),
      chat,
      workspace: f.workspace,
    }),
  );
  expect(await info(pin)).not.toBeNull();
  // The owner's reset leaves no active identity holding the current member key.
  await f.t.run(async (ctx) => {
    const owner = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", "owner").eq("status", "active"))
      .unique();
    await ctx.db.patch("e2ee_identities", owner!._id, { status: "retired" });
  });
  expect(await info(pin)).toBeNull();
});

test("a bound epoch seals to any reader's exact pin, and a rotation in between rejects the old pin", async () => {
  const f = await fixture();
  await f.owner.mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: f.workspace,
    ...(await rotation(f.workspace)),
  });
  const { chat, e2eeId } = await keyedWorkspaceChat(f, "member");
  const pin = { userId: "other", e2eeId, epoch: 1, publicKey: bytes(1216, 9) };
  const info = (recipient?: typeof pin) =>
    f.t.query(internal.aisdk.chatSealingInfo, { chatId: chat, ...(recipient ? { recipient } : {}) });
  expect(await info(pin)).toMatchObject({ epoch: 1 });
  expect(await info()).toMatchObject({ epoch: 1 });
  expect(await info({ ...pin, publicKey: bytes(1216, 8) })).toBeNull();
  // Epoch two reuses the fixture public key: the pin's epoch still has to match.
  const next = await chatEpochInput(f.workspace, e2eeId, 2, "member", {
    chat,
    scope: "workspace",
    creatorId: "member",
  });
  await f.t.run(async (ctx) => {
    await ctx.db.insert("e2ee_chat_keys", {
      ...next,
      chat,
      workspace: f.workspace,
      signerUserId: "member",
      createdAt: Date.now() + 60_000,
    });
    await ctx.db.patch("aisdk_chats", chat, { keyEpoch: 2 });
  });
  expect(await info(pin)).toBeNull();
  expect(await info({ ...pin, epoch: 2 })).toMatchObject({ epoch: 2 });
  // A stale bound epoch withholds even an exact pin.
  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { rekey: true }));
  expect(await info({ ...pin, epoch: 2 })).toBeNull();
});

test("every scope or member change needs a fresh epoch bound to the NEXT audience, and widening still rewraps history", async () => {
  const f = await fixture();
  const { chat, e2eeId } = await keyedWorkspaceChat(f, "owner", "personal");
  const before = await chatEpochRows(f, chat);
  const next = (bind: BindingPolicy) => chatEpochInput(f.workspace, e2eeId, 2, "owner", bind);
  const widen = async (rotate?: ChatKeyInput) =>
    f.owner.mutation(api.aisdk.SetChatScope, {
      chatId: chat,
      scope: "shared",
      members: ["member"],
      keys: {
        rotate,
        wraps: [
          identityWrap("member"),
          { ...identityWrap("owner"), chatEpoch: 2 },
          { ...identityWrap("member"), chatEpoch: 2 },
        ],
      },
    });
  const asShared = { chat, scope: "shared" as const, creatorId: "owner", members: ["member"] };

  // No fresh epoch, or one bound to the old scope, another chat or other members: nothing changes.
  await expect(widen()).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(widen(await next({ chat, scope: "personal", creatorId: "owner" }))).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  const elsewhere = (await keyedWorkspaceChat(f, "owner", "personal")).chat;
  await expect(widen(await next({ ...asShared, chat: elsewhere }))).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(widen(await next({ ...asShared, members: [] }))).rejects.toThrow("E2EE_KEYS_INVALID");
  expect((await f.owner.query(api.e2ee.chatKeys, { chatId: chat })).scope).toBe("personal");

  await widen(await next(asShared));
  const state = await f.owner.query(api.e2ee.chatKeys, { chatId: chat });
  expect(state).toMatchObject({ scope: "shared", keyEpoch: 2, members: ["member"] });
  const rows = await chatEpochRows(f, chat);
  // The old epoch and its signature are untouched; the new one carries the next audience.
  expect(rows[0]).toEqual(before[0]);
  expect(rows[1]).toMatchObject({ epoch: 2, bindingMembers: ["member"] });
  expect((await wrapRows(f, chat)).map((wrap) => [wrap.chatEpoch, wrap.userId]).sort()).toEqual([
    [1, "member"],
    [2, "member"],
    [2, "owner"],
  ]);
});

test("readers upgrade a pre-binding epoch with a fresh bound epoch; replayed or unbound rotations are refused", async () => {
  const f = await fixture();
  const chat = await keylessChat(f, "owner", "shared", ["member"]);
  const e2eeId = keyId(81);
  // Every earlier PR state: a creator-signed epoch without any binding proof.
  const legacy = await chatEpochInput(f.workspace, e2eeId, 1, "owner");
  await f.t.run(async (ctx) => {
    await ctx.db.insert("e2ee_chat_keys", {
      ...legacy,
      chat,
      workspace: f.workspace,
      signerUserId: "owner",
      createdAt: Date.now() + 60_000,
    });
    await ctx.db.patch("aisdk_chats", chat, { e2eeId, keyEpoch: 1 });
  });
  const stored = await chatEpochRows(f, chat);
  const policy = { chat, scope: "shared" as const, creatorId: "owner", members: ["member"] };
  const rotate = async (epoch: number, bind?: BindingPolicy) =>
    f.member.mutation(api.e2ee.rotateChatKey, {
      chatId: chat,
      epoch: await chatEpochInput(f.workspace, e2eeId, epoch, "member", bind),
      wraps: [
        { ...identityWrap("owner"), chatEpoch: epoch },
        { ...identityWrap("member"), chatEpoch: epoch },
      ],
    });

  await expect(rotate(2)).rejects.toThrow("E2EE_KEYS_INVALID");
  const elsewhere = await keylessChat(f, "owner", "shared", ["member"]);
  await expect(rotate(2, { ...policy, chat: elsewhere })).rejects.toThrow("E2EE_KEYS_INVALID");
  await expect(rotate(2, { ...policy, members: [] })).rejects.toThrow("E2EE_KEYS_INVALID");
  await rotate(2, policy);
  const rows = await chatEpochRows(f, chat);
  expect(rows[0]).toEqual(stored[0]);
  expect(rows[1]).toMatchObject({ epoch: 2, signerUserId: "member", bindingMembers: ["member"] });
  // The current epoch is now bound, so another reader cannot rotate it away.
  await expect(rotate(3, policy)).rejects.toThrow("E2EE_KEYS_INVALID");
});
