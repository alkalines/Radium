import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import {
  grantStatement,
  rosterStatement,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  chatKeyStatement,
} from "radium-crypto";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { GrantInput } from "../src/e2ee/workspace-contract";

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
    epoch: { epoch: 1, keyId: keyId(61), suite: 1, publicKey: bytes(1216) },
    wraps: [
      {
        chatEpoch: 1,
        recipient: "identity" as const,
        userId: "owner",
        recipientKeyId: keyId(1),
        sealed: bytes(1200),
      },
    ],
  };
  await expect(owner.mutation(api.e2ee.setupChatKeys, { chatId, keys })).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  keys.wraps.push({
    chatEpoch: 1,
    recipient: "identity",
    userId: "member",
    recipientKeyId: keyId(99),
    sealed: bytes(1200),
  });
  await expect(owner.mutation(api.e2ee.setupChatKeys, { chatId, keys })).rejects.toThrow(
    "E2EE_KEYS_INVALID",
  );
  keys.wraps[1]!.recipientKeyId = keyId(2);
  await owner.mutation(api.e2ee.setupChatKeys, { chatId, keys });
  expect((await owner.query(api.e2ee.chatKeys, { chatId })).keyEpoch).toBe(1);
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

async function chatEpochInput(
  workspace: Id<"workspaces">,
  e2eeId: string,
  epoch: number,
  signer: keyof typeof seeds,
) {
  const publicKey = bytes(1216, 9);
  const id = keyId(70 + epoch);
  return {
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
}

/** A workspace wrap input sealed to the member key of `workspaceEpoch` (fixture key IDs `10 + n`). */
const workspaceWrap = (chatEpoch: number, workspaceEpoch: number, sealedBytes: number) => ({
  chatEpoch,
  recipient: "workspace" as const,
  workspaceEpoch,
  recipientKeyId: keyId(10 + workspaceEpoch),
  sealed: bytes(sealedBytes),
});

async function keyedWorkspaceChat(
  f: Awaited<ReturnType<typeof fixture>>,
  creator: string,
  scope: "workspace" | "personal" = "workspace",
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
      publicKey: bytes(1216),
      signerUserId: creator,
      signerKeyId: keyId(creator === "owner" ? 1 : 2),
      signature: bytes(64),
      // After the workspace keys of these fixtures, so a freshly keyed chat is not stale.
      createdAt: Date.now() + 60_000,
    });
    return chat;
  });
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
      rotate: await chatEpochInput(f.workspace, e2eeId, 2, "owner"),
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

test("non-creators rotate a chat key only when it needs rotation, and epochs are capped", async () => {
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
    epoch: await chatEpochInput(f.workspace, e2eeId, epoch, user),
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

  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { keyEpoch: 199 }));
  await f.member.mutation(api.e2ee.rotateChatKey, await rotate("member", 200));
  await expect(
    f.member.mutation(api.e2ee.rotateChatKey, await rotate("member", 201)),
  ).rejects.toThrow("E2EE_KEYS_INVALID");
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

  await f.t.run(async (ctx) => {
    await ctx.db.insert("e2ee_chat_keys", {
      chat,
      workspace: f.workspace,
      epoch: 2,
      keyId: keyId(72),
      suite: 1,
      publicKey: bytes(1216),
      createdAt: Date.now() + 60_000,
    });
    await ctx.db.patch("aisdk_chats", chat, { keyEpoch: 2 });
  });
  expect(await info()).not.toBeNull();
  expect(await stale()).toBe(false);
  await f.t.run((ctx) => ctx.db.patch("aisdk_chats", chat, { rekey: true }));
  expect(await info()).toBeNull();
});
