import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Id } from "backend/convex/_generated/dataModel";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import {
  chatKeyBindingStatement,
  chatKeyStatement,
  createAccountKeys,
  CryptoError,
  encryptionPublicKeyFromSeed,
  equalBytes,
  fingerprint,
  generateEncryptionKeyPair,
  identitySelfSignature,
  openBox,
  randomBytes,
  sealBox,
  sign,
  toBase64Url,
  verify,
  type IdentityKeys,
} from "radium-crypto";
import { keyManager, KeysLockedError } from "./key-manager";
import * as workspaceKeys from "./workspace-keys";
import { configureCryptoClient } from "./runtime";
import { trust, type PublicIdentity } from "./trust-store";
import {
  changeChatScope,
  createChatKeys,
  ensureChatKeys,
  openChatSeed,
  prepareCustodyRelease,
  rememberChatSeed,
  signUnsignedChatKeys,
  writableChatKey,
  type ChatKeysSetupWire,
  type ChatScope,
  type WrapWire,
} from "./chat-keys";
import { CustodialContentError } from "./legacy-content";
import { openHistoricalChat } from "./legacy-chat";

const workspaceId = "workspace" as Id<"workspaces">;
const custody = { kind: "custody", keyId: "custody", epoch: 1, box: new ArrayBuffer(1) } as LegacyBox;

/** A test account's private keys and the public identity the server would publish for it. */
type Account = {
  amk: Uint8Array;
  identity: IdentityKeys;
  public: PublicIdentity;
  selfSignature: Uint8Array;
};

async function account(userId: string): Promise<Account> {
  const keys = await createAccountKeys();
  const identity: PublicIdentity = {
    userId,
    keyId: toBase64Url(keys.identity.keyId),
    suite: keys.identity.suite,
    encryptionPublicKey: keys.identity.encryption.publicKey,
    signingPublicKey: keys.identity.signing.publicKey,
    fingerprint: await fingerprint({
      encryptionPublicKey: keys.identity.encryption.publicKey,
      signingPublicKey: keys.identity.signing.publicKey,
    }),
  };
  return { ...keys, public: identity, selfSignature: await identitySelfSignature(keys.identity) };
}

/**
 * Fake backend for one chat. `roster` stands in for the owner-signed roster's endorsements
 * (`trustedIdentity`), so the chat key code runs its real signing, wrapping and signer checks.
 */
function backend(input: {
  reader: Account;
  roster: Account[];
  workspaceUsers: Array<{ userId: string; keyId: string | null }>;
  chat: Record<string, unknown>;
  identities?: Account[];
  /** Users whose identity the server reports as retired. */
  retired?: string[];
  onMutation?: (name: string, args: Record<string, unknown>) => void;
  /** While `locked` is set the reader's keys are locked (no unlock event, so caches stay). */
  lock?: { locked: boolean };
}) {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  spyOn(keyManager, "getSnapshot").mockImplementation(() =>
    input.lock?.locked
      ? { state: "locked", userId: input.reader.public.userId }
      : {
          state: "unlocked",
          userId: input.reader.public.userId,
          keyId: input.reader.public.keyId,
          fingerprint: input.reader.public.fingerprint,
        },
  );
  spyOn(keyManager, "useAmk").mockImplementation(async (fn) =>
    fn(input.reader.amk, input.reader.identity),
  );
  // Pins: this account is itself, everyone else was approved before.
  spyOn(trust, "check").mockImplementation(async (userId) =>
    userId === input.reader.public.userId ? "self" : "tofu",
  );
  spyOn(workspaceKeys, "trustedIdentity").mockImplementation(async (_workspace, userId) => {
    const endorsed = input.roster.find((member) => member.public.userId === userId);
    if (!endorsed) throw new CryptoError("DECRYPT_FAILED", "Identity unavailable");
    return endorsed.public;
  });
  configureCryptoClient({
    query: async (fn: FunctionReference<"query">, args: Record<string, unknown>) => {
      const name = getFunctionName(fn);
      if (name === "e2ee:chatKeys") return input.chat;
      if (name === "e2ee:workspaceKeyState") return { members: input.workspaceUsers };
      if (name === "e2ee:identityKeysByKeyId") {
        return (input.identities ?? [])
          .filter((identity) => (args.keyIds as string[]).includes(identity.public.keyId))
          .map((identity) => ({
            userId: identity.public.userId,
            keyId: identity.public.keyId,
            suite: identity.public.suite,
            encryptionPublicKey: identity.public.encryptionPublicKey.slice().buffer,
            signingPublicKey: identity.public.signingPublicKey.slice().buffer,
            selfSignature: identity.selfSignature.slice().buffer,
            status: input.retired?.includes(identity.public.userId) ? "retired" : "active",
          }));
      }
      throw new Error(`Unexpected query ${name}`);
    },
    mutation: async (fn: FunctionReference<"mutation">, args: Record<string, unknown>) => {
      const name = getFunctionName(fn);
      mutations.push({ name, args });
      input.onMutation?.(name, args);
      return null;
    },
  } as unknown as ConvexReactClient);
  return mutations;
}

function keylessChat(chatId: string, fields: Record<string, unknown>) {
  return {
    chat: chatId,
    workspace: workspaceId,
    e2eeId: null,
    keyEpoch: null,
    scope: "shared",
    creatorId: "owner",
    rekey: false,
    workspaceKeyEpoch: 1,
    staleForWorkspace: false,
    members: ["member"],
    epochs: [],
    wraps: [],
    ...fields,
  };
}

async function expectSignedBy(signer: Account, e2eeId: string, epoch: ChatKeysSetupWire["epoch"]) {
  expect(epoch.signerKeyId).toBe(signer.public.keyId);
  const statement = chatKeyStatement({
    workspaceId,
    chatE2eeId: e2eeId,
    epoch: epoch.epoch,
    keyId: epoch.keyId,
    suite: epoch.suite,
    publicKey: new Uint8Array(epoch.publicKey),
  });
  expect(await verify(signer.public.signingPublicKey, statement, new Uint8Array(epoch.signature!))).toBe(true);
}

type Policy = { scope: ChatScope; creatorId: string; members: string[] };

/** The V2 binding of `epoch` verifies for exactly this chat ID and policy, with matching wire members. */
async function expectBound(
  signer: Account,
  chatId: string,
  e2eeId: string,
  epoch: ChatKeysSetupWire["epoch"],
  policy: Policy,
) {
  expect(epoch.signerKeyId).toBe(signer.public.keyId);
  expect(epoch.bindingMembers).toEqual(
    policy.scope === "shared" ? [...new Set(policy.members)].sort() : undefined,
  );
  const statement = chatKeyBindingStatement({
    chatId,
    workspaceId,
    chatE2eeId: e2eeId,
    epoch: epoch.epoch,
    keyId: epoch.keyId,
    suite: epoch.suite,
    publicKey: new Uint8Array(epoch.publicKey),
    ...policy,
  });
  expect(await verify(signer.public.signingPublicKey, statement, new Uint8Array(epoch.bindingSignature!))).toBe(true);
}

/**
 * A stored epoch row and its seed: unsigned, v1-signed by `signer`, or also bound by `signer` to
 * `bound`'s chat ID and policy exactly as an honest client binds it.
 */
async function epochRow(input: {
  chatId: string;
  e2eeId: string;
  epoch: number;
  signer?: Account;
  bound?: Policy & { chatId: string };
}) {
  const pair = await generateEncryptionKeyPair();
  const keyId = toBase64Url(randomBytes(16));
  const statement = {
    workspaceId,
    chatE2eeId: input.e2eeId,
    epoch: input.epoch,
    keyId,
    suite: pair.suite,
    publicKey: pair.publicKey,
  };
  const row: Record<string, unknown> = {
    chat: input.chatId,
    workspace: workspaceId,
    epoch: input.epoch,
    keyId,
    suite: pair.suite,
    publicKey: pair.publicKey.slice().buffer,
    createdAt: 1,
  };
  if (input.signer) {
    const seed = input.signer.identity.signing.seed;
    Object.assign(row, {
      signerUserId: input.signer.public.userId,
      signerKeyId: input.signer.public.keyId,
      signature: (await sign(seed, chatKeyStatement(statement))).slice().buffer,
    });
    if (input.bound) {
      const { chatId, ...policy } = input.bound;
      Object.assign(row, {
        bindingSignature: (await sign(seed, chatKeyBindingStatement({ ...statement, chatId, ...policy }))).slice().buffer,
        ...(policy.scope === "shared" ? { bindingMembers: [...new Set(policy.members)].sort() } : {}),
      });
    }
  }
  return { row, seed: pair.seed };
}

/** A chat seed sealed to `recipient`'s identity, as anyone holding the seed can produce it. */
async function identityWrap(recipient: Account, e2eeId: string, epoch: number, seed: Uint8Array) {
  return {
    chatEpoch: epoch,
    recipient: "identity",
    userId: recipient.public.userId,
    recipientKeyId: recipient.public.keyId,
    sealed: (
      await sealBox({
        recipientPublicKey: recipient.public.encryptionPublicKey,
        plaintext: seed,
        aad: { table: "e2ee_chat_key_wraps", workspace: workspaceId, parent: e2eeId, record: String(epoch), field: recipient.public.keyId },
        pad: "none",
      })
    ).slice().buffer,
  };
}

/** The owner-signed roster as `verifyWorkspaceState` returns it after verification. */
function verifiedRoster(ownerId: string, members: string[]) {
  spyOn(workspaceKeys, "verifyWorkspaceState").mockResolvedValue({
    verifiedRoster: { owner: { userId: ownerId }, members: members.map((userId) => ({ userId })) },
  } as never);
}

/** Each wrap opens with its recipient's own identity key to the seed of the signed public key. */
async function expectWrapsOpen(
  e2eeId: string,
  epoch: ChatKeysSetupWire["epoch"],
  wraps: WrapWire[],
  recipients: Account[],
) {
  expect(wraps.map((wrap) => (wrap.recipient === "identity" ? wrap.userId : "")).sort()).toEqual(
    recipients.map((recipient) => recipient.public.userId).sort(),
  );
  for (const recipient of recipients) {
    const wrap = wraps.find((entry) => entry.recipient === "identity" && entry.userId === recipient.public.userId)!;
    expect(wrap.recipientKeyId).toBe(recipient.public.keyId);
    const seed = await openBox({
      seed: recipient.identity.encryption.seed,
      box: new Uint8Array(wrap.sealed),
      aad: { table: "e2ee_chat_key_wraps", workspace: workspaceId, parent: e2eeId, record: String(epoch.epoch), field: wrap.recipientKeyId },
      pad: "none",
    });
    expect(equalBytes(await encryptionPublicKeyFromSeed(seed), new Uint8Array(epoch.publicKey))).toBe(true);
  }
}

afterEach(() => mock.restore());

describe("initial keys of a keyless chat", () => {
  test("reading custodial history lets a non-creator reader create a self-signed epoch for exactly the current audience", async () => {
    const [owner, member] = await Promise.all([account("owner"), account("member")]);
    const chatId = "custodial-keyless" as Id<"aisdk_chats">;
    const mutations = backend({
      reader: member,
      roster: [owner],
      workspaceUsers: [
        { userId: "owner", keyId: owner.public.keyId },
        { userId: "member", keyId: member.public.keyId },
        { userId: "outsider", keyId: "outsider-key" },
      ],
      chat: keylessChat(chatId, {}),
    });

    await expect(
      openHistoricalChat({ chatId, workspaceId, legacyContent: custody, wants: { title: true, queue: false } }, []),
    ).rejects.toBeInstanceOf(CustodialContentError);

    expect(mutations.map((call) => call.name)).toEqual(["e2ee:setupChatKeys"]);
    const keys = mutations[0]!.args.keys as ChatKeysSetupWire;
    expect(keys.epoch.epoch).toBe(1);
    await expectSignedBy(member, keys.e2eeId, keys.epoch);
    await expectBound(member, "custodial-keyless", keys.e2eeId, keys.epoch, { scope: "shared", creatorId: "owner", members: ["member"] });
    await expectWrapsOpen(keys.e2eeId, keys.epoch, keys.wraps, [owner, member]);
  });

  test("a creator or picked member who left gets no wrap, and a recipient without keys blocks setup without writing", async () => {
    const [member, other] = await Promise.all([account("member"), account("other")]);
    const chatId = "removed-creator" as Id<"aisdk_chats">;
    const users = [
      { userId: "owner", keyId: "owner-key" },
      { userId: "member", keyId: member.public.keyId },
      { userId: "other", keyId: other.public.keyId },
    ];
    // "charlie" left the workspace, but an unfinished removal batch still lists them as a member.
    const chat = keylessChat(chatId, { creatorId: "gone", members: ["charlie", "member", "other"] });
    const mutations = backend({ reader: member, roster: [other], workspaceUsers: users, chat });

    expect(await ensureChatKeys(chatId)).toBe(true);
    const keys = mutations[0]!.args.keys as ChatKeysSetupWire;
    await expectWrapsOpen(keys.e2eeId, keys.epoch, keys.wraps, [member, other]);

    mock.restore();
    const blocked = backend({
      reader: member,
      roster: [other],
      workspaceUsers: users.map((user) => (user.userId === "other" ? { ...user, keyId: null } : user)),
      chat: keylessChat("missing-recipient-key", { members: ["member", "other"] }),
    });
    expect(await ensureChatKeys("missing-recipient-key" as Id<"aisdk_chats">)).toBe(false);
    expect(blocked).toEqual([]);
  });

  test("losing a concurrent setup converges on the winner, and other failures still surface", async () => {
    const [owner, member] = await Promise.all([account("owner"), account("member")]);
    const users = [
      { userId: "owner", keyId: owner.public.keyId },
      { userId: "member", keyId: member.public.keyId },
    ];
    const chat: Record<string, unknown> = keylessChat("raced", {});
    const mutations = backend({
      reader: member,
      roster: [owner],
      workspaceUsers: users,
      chat,
      onMutation: () => {
        chat.e2eeId = "winner";
        chat.keyEpoch = 1;
        throw new Error("E2EE_KEYS_INVALID");
      },
    });
    expect(await ensureChatKeys("raced" as Id<"aisdk_chats">)).toBe(true);
    expect(mutations).toHaveLength(1);

    mock.restore();
    backend({
      reader: member,
      roster: [owner],
      workspaceUsers: users,
      chat: keylessChat("rejected", {}),
      onMutation: () => {
        throw new Error("E2EE_KEYS_INVALID");
      },
    });
    await expect(ensureChatKeys("rejected" as Id<"aisdk_chats">)).rejects.toThrow("E2EE_KEYS_INVALID");
  });

  test("another reader opens a peer-signed initial epoch only while its signer is roster-endorsed", async () => {
    const [owner, member, other] = await Promise.all([account("owner"), account("member"), account("other")]);
    const users = [
      { userId: "owner", keyId: owner.public.keyId },
      { userId: "member", keyId: member.public.keyId },
      { userId: "other", keyId: other.public.keyId },
    ];
    const setupChat = keylessChat("peer-signed", { members: ["member", "other"] });
    const mutations = backend({ reader: member, roster: [owner, other], workspaceUsers: users, chat: setupChat });
    expect(await ensureChatKeys("peer-signed" as Id<"aisdk_chats">)).toBe(true);
    const keys = mutations[0]!.args.keys as ChatKeysSetupWire;

    // What `chatKeys` returns to `other`: the member-signed epoch and only other's own wrap.
    const keyed = (chatId: string) => ({
      ...setupChat,
      chat: chatId,
      e2eeId: keys.e2eeId,
      keyEpoch: 1,
      epochs: [{ ...keys.epoch, signerUserId: "member", chat: chatId, workspace: workspaceId, createdAt: 1 }],
      wraps: keys.wraps.filter((wrap) => wrap.recipient === "identity" && wrap.userId === "other"),
    });
    mock.restore();
    backend({ reader: other, roster: [owner, member], workspaceUsers: users, chat: keyed("peer-read"), identities: [member] });
    const seed = await openChatSeed("peer-read" as Id<"aisdk_chats">, 1);
    expect(equalBytes(await encryptionPublicKeyFromSeed(seed), new Uint8Array(keys.epoch.publicKey))).toBe(true);

    mock.restore();
    backend({ reader: other, roster: [owner], workspaceUsers: users, chat: keyed("unendorsed"), identities: [member] });
    await expect(openChatSeed("unendorsed" as Id<"aisdk_chats">, 1)).rejects.toThrow();
  });
});

describe("stale chat keys", () => {
  test("reading custodial history of a revoked chat starts a fresh epoch without a message", async () => {
    const [owner, member] = await Promise.all([account("owner"), account("member")]);
    const chatId = "stale" as Id<"aisdk_chats">;
    const mutations = backend({
      reader: member,
      roster: [owner],
      workspaceUsers: [
        { userId: "owner", keyId: owner.public.keyId },
        { userId: "member", keyId: member.public.keyId },
      ],
      // The revoked chat's current epoch predates bindings (unsigned here); it is never reused.
      chat: keylessChat(chatId, {
        e2eeId: "stale-e2ee",
        keyEpoch: 1,
        rekey: true,
        epochs: [(await epochRow({ chatId, e2eeId: "stale-e2ee", epoch: 1 })).row],
      }),
    });

    await expect(
      openHistoricalChat({ chatId, workspaceId, legacyContent: custody, wants: { title: true, queue: false } }, []),
    ).rejects.toBeInstanceOf(CustodialContentError);

    expect(mutations.map((call) => call.name)).toEqual(["e2ee:rotateChatKey"]);
    const epoch = mutations[0]!.args.epoch as ChatKeysSetupWire["epoch"];
    expect(epoch.epoch).toBe(2);
    await expectSignedBy(member, "stale-e2ee", epoch);
    await expectBound(member, chatId, "stale-e2ee", epoch, { scope: "shared", creatorId: "owner", members: ["member"] });
    await expectWrapsOpen("stale-e2ee", epoch, mutations[0]!.args.wraps as WrapWire[], [owner, member]);
  });
});

test("a locally created bound epoch cannot be redirected to a substituted server public key", async () => {
  const [reader, attacker] = await Promise.all([account("local-reader"), account("attacker")]);
  const chatId = "substituted-local-epoch" as Id<"aisdk_chats">;
  const chat = keylessChat(chatId, { scope: "personal", creatorId: reader.public.userId, members: [] });
  const mutations = backend({
    reader,
    roster: [],
    identities: [reader],
    workspaceUsers: [{ userId: reader.public.userId, keyId: reader.public.keyId }],
    chat,
    onMutation(name, args) {
      if (name !== "e2ee:setupChatKeys") return;
      const keys = args.keys as ChatKeysSetupWire;
      Object.assign(chat, { e2eeId: keys.e2eeId, keyEpoch: 1, epochs: [keys.epoch], wraps: keys.wraps });
    },
  });
  expect(await ensureChatKeys(chatId)).toBe(true);
  const epochs = chat.epochs as ChatKeysSetupWire["epoch"][];
  epochs[0]!.publicKey = attacker.public.encryptionPublicKey.slice().buffer;
  // The verified binding no longer covers the row, and the substituted key is never rotated away
  // from or written to.
  await expect(writableChatKey(chatId)).rejects.toThrow("Chat key signature failed");
  expect(mutations.map((call) => call.name)).toEqual(["e2ee:setupChatKeys"]);
});

describe("recipient binding", () => {
  test("a creator-signed workspace root with a forged identity wrap, replayed onto a personal chat ID, is refused", async () => {
    const bob = await account("bob");
    const e2eeId = "replayed-workspace-e2ee";
    // A valid root of Bob's workspace chat; anyone holding its seed (the owner) forges a wrap to Bob.
    const root = await epochRow({
      chatId: "workspace-chat",
      e2eeId,
      epoch: 1,
      signer: bob,
      bound: { chatId: "workspace-chat", scope: "workspace", creatorId: "bob", members: [] },
    });
    const chatId = "personal-chat" as Id<"aisdk_chats">;
    const mutations = backend({
      reader: bob,
      roster: [],
      identities: [bob],
      workspaceUsers: [{ userId: "bob", keyId: bob.public.keyId }],
      chat: keylessChat(chatId, {
        scope: "personal",
        creatorId: "bob",
        members: [],
        e2eeId,
        keyEpoch: 1,
        epochs: [root.row],
        wraps: [await identityWrap(bob, e2eeId, 1, root.seed)],
      }),
    });
    await expect(writableChatKey(chatId)).rejects.toThrow("Chat key binding failed");
    await expect(prepareCustodyRelease(chatId)).rejects.toThrow("Chat key binding failed");
    expect(mutations).toEqual([]);
  });

  test("a workspace wrap is never opened for a chat outside workspace scope", async () => {
    const bob = await account("bob");
    const chatId = "personal-workspace-wrap" as Id<"aisdk_chats">;
    const e2eeId = "personal-workspace-wrap-e2ee";
    const root = await epochRow({ chatId, e2eeId, epoch: 1, signer: bob });
    backend({
      reader: bob,
      roster: [],
      identities: [bob],
      workspaceUsers: [],
      chat: keylessChat(chatId, {
        scope: "personal",
        creatorId: "bob",
        members: [],
        e2eeId,
        keyEpoch: 1,
        epochs: [root.row],
        wraps: [{ chatEpoch: 1, recipient: "workspace", workspaceEpoch: 1, recipientKeyId: "workspace-key", sealed: new ArrayBuffer(8) }],
      }),
    });
    const memberKey = spyOn(workspaceKeys, "getMemberKey");
    await expect(openChatSeed(chatId, 1)).rejects.toThrow("Missing chat key wrap");
    expect(memberKey).not.toHaveBeenCalled();
  });

  test("an epoch bound to another chat is refused, in the same scope or after that chat was private", async () => {
    const [bob, alice] = await Promise.all([account("bob"), account("alice")]);
    const users = [
      { userId: "bob", keyId: bob.public.keyId },
      { userId: "alice", keyId: alice.public.keyId },
    ];
    const originals: Array<{ scope: ChatScope; members: string[] }> = [
      { scope: "shared", members: ["alice"] },
      // Formerly private, its seed later shared with Alice by widening.
      { scope: "personal", members: [] },
    ];
    for (const original of originals) {
      const e2eeId = `replayed-${original.scope}`;
      const root = await epochRow({
        chatId: "chat-a",
        e2eeId,
        epoch: 1,
        signer: bob,
        bound: { chatId: "chat-a", creatorId: "bob", ...original },
      });
      const chatId = `chat-b-${original.scope}` as Id<"aisdk_chats">;
      mock.restore();
      const mutations = backend({
        reader: bob,
        roster: [alice],
        identities: [bob],
        workspaceUsers: users,
        chat: keylessChat(chatId, {
          scope: "shared",
          creatorId: "bob",
          members: ["alice"],
          e2eeId,
          keyEpoch: 1,
          epochs: [root.row],
          wraps: [await identityWrap(bob, e2eeId, 1, root.seed)],
        }),
      });
      await expect(writableChatKey(chatId)).rejects.toThrow("Chat key binding failed");
      expect(mutations).toEqual([]);
    }
  });

  test("a shared binding fails closed on altered members; only a proven departure starts a fresh epoch", async () => {
    const [bob, alice, mallory] = await Promise.all([account("bob"), account("alice"), account("mallory")]);
    const chatId = "members-chat" as Id<"aisdk_chats">;
    const e2eeId = "members-e2ee";
    const root = await epochRow({
      chatId,
      e2eeId,
      epoch: 1,
      signer: bob,
      bound: { chatId, scope: "shared", creatorId: "bob", members: ["alice"] },
    });
    const wraps = [await identityWrap(bob, e2eeId, 1, root.seed)];
    const served = (members: string[], roster: string[], rekey = false) => {
      mock.restore();
      const mutations = backend({
        reader: bob,
        roster: [alice, mallory],
        identities: [bob],
        workspaceUsers: [
          { userId: "bob", keyId: bob.public.keyId },
          { userId: "alice", keyId: alice.public.keyId },
          { userId: "mallory", keyId: mallory.public.keyId },
        ],
        chat: keylessChat(chatId, {
          scope: "shared",
          creatorId: "bob",
          members,
          rekey,
          e2eeId,
          keyEpoch: 1,
          epochs: [root.row],
          wraps,
        }),
      });
      verifiedRoster("owner", roster);
      return mutations;
    };

    // Exactly the bound policy: the epoch is written to as is.
    let mutations = served(["alice"], ["bob", "alice", "mallory"]);
    expect((await writableChatKey(chatId)).epoch).toBe(1);
    // An added member is never accepted, whatever the rekey state.
    mutations = served(["alice", "mallory"], ["bob", "alice", "mallory"], true);
    await expect(writableChatKey(chatId)).rejects.toThrow("Chat key binding failed");
    // A removed member still in the owner-signed roster is no proven departure.
    mutations = served([], ["bob", "alice", "mallory"], true);
    await expect(writableChatKey(chatId)).rejects.toThrow("Chat key binding failed");
    await expect(prepareCustodyRelease(chatId)).rejects.toThrow("Chat key binding failed");
    expect(mutations).toEqual([]);

    // Alice left the workspace: the pruned list only narrows, so the old epoch is replaced.
    mutations = served([], ["bob", "mallory"], true);
    expect((await writableChatKey(chatId)).epoch).toBe(2);
    expect(mutations.map((call) => call.name)).toEqual(["e2ee:rotateChatKey"]);
    const epoch = mutations[0]!.args.epoch as ChatKeysSetupWire["epoch"];
    await expectBound(bob, chatId, e2eeId, epoch, { scope: "shared", creatorId: "bob", members: [] });
    await expectWrapsOpen(e2eeId, epoch, mutations[0]!.args.wraps as WrapWire[], [bob]);
  });

  test("custody preparation replaces unsigned, retired-signer and unbound epochs instead of certifying them", async () => {
    const [owner, member] = await Promise.all([account("owner"), account("member")]);
    const users = [
      { userId: "owner", keyId: owner.public.keyId },
      { userId: "member", keyId: member.public.keyId },
    ];
    const policy: Policy = { scope: "shared", creatorId: "owner", members: ["member"] };
    const cases = [
      { name: "unsigned", signer: undefined, bound: false, retired: [] },
      { name: "retired", signer: owner, bound: true, retired: ["owner"] },
      { name: "unbound", signer: owner, bound: false, retired: [] },
    ];
    for (const current of cases) {
      const chatId = `prep-${current.name}` as Id<"aisdk_chats">;
      const e2eeId = `prep-${current.name}-e2ee`;
      const { row } = await epochRow({
        chatId,
        e2eeId,
        epoch: 1,
        signer: current.signer,
        bound: current.bound ? { chatId, ...policy } : undefined,
      });
      mock.restore();
      const mutations = backend({
        reader: member,
        roster: [owner],
        identities: [owner, member],
        retired: current.retired,
        workspaceUsers: users,
        chat: keylessChat(chatId, { e2eeId, keyEpoch: 1, epochs: [row] }),
      });
      expect(await prepareCustodyRelease(chatId)).toBe(true);
      expect(mutations.map((call) => call.name)).toEqual(["e2ee:rotateChatKey"]);
      const epoch = mutations[0]!.args.epoch as ChatKeysSetupWire["epoch"];
      expect(epoch.epoch).toBe(2);
      await expectBound(member, chatId, e2eeId, epoch, policy);
      await expectWrapsOpen(e2eeId, epoch, mutations[0]!.args.wraps as WrapWire[], [owner, member]);
    }
  });

  test("a chat created while locked continues under its remembered policy and is bound only to that policy", async () => {
    const [bob, alice, mallory] = await Promise.all([account("bob"), account("alice"), account("mallory")]);
    const values = new Map<string, string>([
      [
        "radium.e2ee.pub.v1:bob",
        JSON.stringify({
          identity: { keyId: bob.public.keyId, encryptionPublicKey: toBase64Url(bob.public.encryptionPublicKey) },
          workspaces: {},
        }),
      ],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => void values.set(name, value),
      },
    });
    try {
      const lock = { locked: true };
      const chats = new Map<string, Record<string, unknown>>();
      const mutations = backend({
        reader: bob,
        roster: [alice, mallory],
        identities: [bob],
        workspaceUsers: [],
        chat: {},
        lock,
      });
      // One backend for several chats: `chatKeys` answers for the requested chat.
      configureCryptoClient({
        query: async (fn: FunctionReference<"query">, args: Record<string, unknown>) => {
          const name = getFunctionName(fn);
          if (name === "e2ee:chatKeys") return chats.get(args.chatId as string);
          if (name === "e2ee:identityKeysByKeyId") return [];
          throw new Error(`Unexpected query ${name}`);
        },
        mutation: async (fn: FunctionReference<"mutation">, args: Record<string, unknown>) => {
          mutations.push({ name: getFunctionName(fn), args });
          return null;
        },
      } as unknown as ConvexReactClient);
      /** Locked creation, then the server stores the unsigned epoch under the assigned chat ID. */
      const createLocked = async (chatId: string, scope: ChatScope, members: string[]) => {
        const created = await createChatKeys({ workspaceId, scope, members });
        expect(created.keys.epoch.signature).toBeUndefined();
        chats.set(
          chatId,
          keylessChat(chatId, {
            scope,
            creatorId: "bob",
            members,
            e2eeId: created.e2eeId,
            keyEpoch: 1,
            epochs: [{ ...created.keys.epoch, chat: chatId, workspace: workspaceId, createdAt: 1 }],
            wraps: created.keys.wraps.filter((wrap) => wrap.recipient === "identity" && wrap.userId === "bob"),
          }),
        );
        rememberChatSeed(chatId as Id<"aisdk_chats">, created.e2eeId, 1, created.seed);
        return created;
      };

      const own = await createLocked("locked-own", "personal", []);
      const local = await writableChatKey("locked-own" as Id<"aisdk_chats">);
      expect(local.epoch).toBe(1);
      expect(equalBytes(local.publicKey, own.publicKey)).toBe(true);
      // A served policy other than the remembered one is never continued; rotating needs unlock.
      chats.get("locked-own")!.scope = "workspace";
      await expect(writableChatKey("locked-own" as Id<"aisdk_chats">)).rejects.toBeInstanceOf(KeysLockedError);
      chats.get("locked-own")!.scope = "personal";

      const changed = await createLocked("locked-changed", "shared", ["alice"]);
      chats.get("locked-changed")!.members = ["alice", "mallory"];
      const pending = await createLocked("locked-pending", "personal", []);
      expect(mutations).toEqual([]);

      // Unlocked: writing to the pending chat binds the cached original policy, then uses it.
      lock.locked = false;
      expect((await writableChatKey("locked-pending" as Id<"aisdk_chats">)).epoch).toBe(1);
      expect(mutations.map((call) => call.name)).toEqual(["e2ee:signChatKey"]);
      const bound = mutations[0]!.args as ChatKeysSetupWire["epoch"] & { chatId: string };
      await expectSignedBy(bob, pending.e2eeId, { ...pending.keys.epoch, ...bound, epoch: 1 });
      await expectBound(bob, "locked-pending", pending.e2eeId, { ...pending.keys.epoch, ...bound, epoch: 1 }, {
        scope: "personal",
        creatorId: "bob",
        members: [],
      });
      chats.get("locked-pending")!.epochs = [{ ...pending.keys.epoch, ...bound, epoch: 1 }];

      // Signing after unlock: the unchanged policy is bound; a server-changed one gets v1 only.
      await signUnsignedChatKeys();
      const signed = mutations.slice(1).map((call) => call.args as ChatKeysSetupWire["epoch"] & { chatId: string });
      expect(signed.map((args) => args.chatId).sort()).toEqual(["locked-changed", "locked-own"]);
      const ownArgs = signed.find((args) => args.chatId === "locked-own")!;
      const changedArgs = signed.find((args) => args.chatId === "locked-changed")!;
      await expectBound(bob, "locked-own", own.e2eeId, { ...own.keys.epoch, ...ownArgs, epoch: 1 }, {
        scope: "personal",
        creatorId: "bob",
        members: [],
      });
      await expectSignedBy(bob, changed.e2eeId, { ...changed.keys.epoch, ...changedArgs, epoch: 1 });
      expect(changedArgs.bindingSignature).toBeUndefined();
      expect(changedArgs.bindingMembers).toBeUndefined();
      expect(JSON.parse(values.get("radium.e2ee.unsigned.v1:bob")!)).toEqual([]);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("every honest scope change starts a fresh bound epoch and keeps history readable", async () => {
    const [bob, alice] = await Promise.all([account("bob"), account("alice")]);
    const chatId = "scoped" as Id<"aisdk_chats">;
    const chat: Record<string, unknown> = keylessChat(chatId, { scope: "personal", creatorId: "bob", members: [] });
    type ScopeKeys = { rotate: ChatKeysSetupWire["epoch"]; wraps: WrapWire[] };
    const mutations = backend({
      reader: bob,
      roster: [alice],
      identities: [bob],
      workspaceUsers: [
        { userId: "bob", keyId: bob.public.keyId },
        { userId: "alice", keyId: alice.public.keyId },
      ],
      chat,
      onMutation(name, args) {
        if (name === "e2ee:setupChatKeys") {
          const keys = args.keys as ChatKeysSetupWire;
          Object.assign(chat, { e2eeId: keys.e2eeId, keyEpoch: 1, epochs: [keys.epoch], wraps: keys.wraps });
        }
        if (name === "aisdk:SetChatScope" && args.keys) {
          const keys = args.keys as ScopeKeys;
          Object.assign(chat, {
            scope: args.scope,
            members: (args.members as string[] | undefined) ?? [],
            keyEpoch: keys.rotate.epoch,
            epochs: [...(chat.epochs as unknown[]), keys.rotate],
            wraps: [
              ...(chat.wraps as WrapWire[]),
              ...keys.wraps.filter((wrap) => wrap.recipient === "identity" && wrap.userId === "bob"),
            ],
          });
        }
      },
    });
    expect(await ensureChatKeys(chatId)).toBe(true);
    const e2eeId = chat.e2eeId as string;
    const first = (chat.epochs as ChatKeysSetupWire["epoch"][])[0]!;
    await expectBound(bob, chatId, e2eeId, first, { scope: "personal", creatorId: "bob", members: [] });

    // Widening to Alice: a fresh epoch bound to the next policy; the old epoch is wrapped for her.
    await changeChatScope({ chatId, scope: "shared", members: ["alice"] });
    const widen = mutations.at(-1)!.args.keys as ScopeKeys;
    expect(widen.rotate.epoch).toBe(2);
    await expectBound(bob, chatId, e2eeId, widen.rotate, { scope: "shared", creatorId: "bob", members: ["alice"] });
    await expectWrapsOpen(e2eeId, widen.rotate, widen.wraps.filter((wrap) => wrap.chatEpoch === 2), [bob, alice]);
    await expectWrapsOpen(e2eeId, first, widen.wraps.filter((wrap) => wrap.chatEpoch === 1), [bob, alice]);
    expect((await writableChatKey(chatId)).epoch).toBe(2);

    // Narrowing back is another fresh bound epoch, for Bob alone.
    await changeChatScope({ chatId, scope: "personal" });
    const narrow = mutations.at(-1)!.args.keys as ScopeKeys;
    expect(narrow.rotate.epoch).toBe(3);
    await expectBound(bob, chatId, e2eeId, narrow.rotate, { scope: "personal", creatorId: "bob", members: [] });
    await expectWrapsOpen(e2eeId, narrow.rotate, narrow.wraps.filter((wrap) => wrap.chatEpoch === 3), [bob]);
    expect((await writableChatKey(chatId)).epoch).toBe(3);

    // An unchanged policy needs no key change.
    await changeChatScope({ chatId, scope: "personal" });
    expect(mutations.at(-1)!.args.keys).toBeUndefined();
    expect(mutations.map((call) => call.name)).toEqual([
      "e2ee:setupChatKeys",
      "aisdk:SetChatScope",
      "aisdk:SetChatScope",
      "aisdk:SetChatScope",
    ]);
  });
});
