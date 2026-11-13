import type { Id } from "backend/convex/_generated/dataModel";
import { api } from "backend/convex/_generated/api";
import {
  chatKeyStatement,
  CryptoError,
  encryptionPublicKeyFromSeed,
  equalBytes,
  generateEncryptionKeyPair,
  openBox,
  sealBox,
  sign,
  toBase64Url,
  verify,
} from "radium-crypto";
import { keyManager, KeysLockedError } from "./key-manager";
import {
  bytes,
  buffer,
  cryptoClient,
  currentUserId,
  newKeyId,
  onSecretsCleared,
  secretGeneration,
} from "./runtime";
import { fetchHistoricalIdentities, getOwnPublicKey } from "./public-keys";
import {
  getCurrentMemberPublicKey,
  getMemberKey,
  trustedIdentity,
  TrustRequiredError,
  verifyWorkspaceState,
} from "./workspace-keys";
import { trust, type PublicIdentity } from "./trust-store";
import { requestIdentityTrust } from "./trust-requests";

/**
 * `trustedIdentity`, but a first-contact or changed key opens the Window's trust prompt and waits
 * for the user's decision instead of failing the chat operation outright. Denial (or a lock) still
 * throws, so nothing is sealed to an unapproved key.
 */
async function approvedIdentity(
  workspaceId: Id<"workspaces">,
  userId: string,
): Promise<PublicIdentity> {
  try {
    return await trustedIdentity(workspaceId, userId);
  } catch (error) {
    if (!(error instanceof TrustRequiredError)) throw error;
    await requestIdentityTrust(error.identity, error.trustState);
    return await trustedIdentity(workspaceId, userId);
  }
}

/** Audience of a chat's key epochs. */
export type ChatScope = "personal" | "shared" | "workspace";
/** Wire shape of ChatKeysSetup (bytes as ArrayBuffer for Convex). */
export type ChatKeysSetupWire = {
  e2eeId: string;
  epoch: {
    epoch: number;
    keyId: string;
    suite: number;
    publicKey: ArrayBuffer;
    signerKeyId?: string;
    signature?: ArrayBuffer;
  };
  wraps: WrapWire[];
};
/** A chat seed sealed to a workspace epoch or one identity. */
export type WrapWire =
  | {
      chatEpoch: number;
      recipient: "workspace";
      workspaceEpoch: number;
      recipientKeyId: string;
      sealed: ArrayBuffer;
    }
  | {
      chatEpoch: number;
      recipient: "identity";
      userId: string;
      recipientKeyId: string;
      sealed: ArrayBuffer;
    };
/** A Home row wrap; the server may include additional row metadata. */
export type WrapRowWire = {
  chatEpoch: number;
  recipient: "workspace" | "identity";
  workspaceEpoch?: number;
  userId?: string;
  recipientKeyId: string;
  sealed: ArrayBuffer;
};
const seeds = new Map<string, Uint8Array>();
const deviceEpochs = new Set<string>();
type UnsignedEpoch = {
  chatId: Id<"aisdk_chats">;
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: string;
};
const unsigned = new Map<string, Omit<UnsignedEpoch, "chatId">>();
const opening = new Map<string, Promise<Uint8Array>>();
onSecretsCleared(() => {
  for (const seed of seeds.values()) seed.fill(0);
  seeds.clear();
  deviceEpochs.clear();
  unsigned.clear();
  opening.clear();
});
const cacheKey = (id: string, epoch: number) => `${id}:${epoch}`;

async function makeEpoch(workspaceId: Id<"workspaces">, e2eeId: string, epoch: number) {
  if (trust.getSnapshot() === "rollback") {
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback blocks new keys");
  }
  const generation = secretGeneration();
  const pair = await generateEncryptionKeyPair();
  const wire: ChatKeysSetupWire["epoch"] = {
    epoch,
    keyId: newKeyId(),
    suite: pair.suite,
    publicKey: buffer(pair.publicKey),
  };
  if (keyManager.getSnapshot().state === "unlocked") {
    await keyManager.useAmk(async (_, identity) => {
      wire.signerKeyId = toBase64Url(identity.keyId);
      wire.signature = buffer(
        await sign(
          identity.signing.seed,
          chatKeyStatement({ workspaceId, chatE2eeId: e2eeId, ...wire, publicKey: pair.publicKey }),
        ),
      );
    });
  }
  if (secretGeneration() !== generation) {
    pair.seed.fill(0);
    throw new KeysLockedError();
  }
  seeds.set(cacheKey(e2eeId, epoch), pair.seed);
  deviceEpochs.add(cacheKey(e2eeId, epoch));
  if (!wire.signature) {
    unsigned.set(cacheKey(e2eeId, epoch), {
      workspaceId,
      e2eeId,
      epoch,
      keyId: wire.keyId,
      suite: wire.suite,
      publicKey: toBase64Url(pair.publicKey),
    });
  }
  return { wire, ...pair };
}

async function wrapSeed(input: {
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  epoch: number;
  seed: Uint8Array;
  scope: ChatScope;
  members?: string[];
  creatorId: string;
}): Promise<WrapWire[]> {
  const aad = (recipientKeyId: string) => ({
    table: "e2ee_chat_key_wraps",
    workspace: input.workspaceId,
    parent: input.e2eeId,
    record: String(input.epoch),
    field: recipientKeyId,
  });
  if (input.scope === "workspace") {
    const key = await getCurrentMemberPublicKey(input.workspaceId);
    if (!key) throw new KeysLockedError();
    return [
      {
        chatEpoch: input.epoch,
        recipient: "workspace",
        workspaceEpoch: key.epoch,
        recipientKeyId: key.keyId,
        sealed: buffer(
          await sealBox({
            recipientPublicKey: key.publicKey,
            plaintext: input.seed,
            aad: aad(key.keyId),
            pad: "none",
          }),
        ),
      },
    ];
  }
  const ownId = currentUserId();
  let creator = input.creatorId;
  if (input.scope === "shared" && creator !== ownId) {
    const workspace = await cryptoClient().query(api.e2ee.workspaceKeyState, {
      workspace: input.workspaceId,
    });
    if (!workspace.members.some((member) => member.userId === creator)) creator = "";
  }
  // A removed creator retains history but must not receive the post-removal epoch.
  const recipients = [
    ...new Set([
      ...(creator ? [creator] : []),
      ...(input.scope === "shared" ? (input.members ?? []) : []),
    ]),
  ];
  return Promise.all(
    recipients.map(async (userId) => {
      const identity =
        userId === ownId
          ? await getOwnPublicKey()
          : await approvedIdentity(input.workspaceId, userId);
      return {
        chatEpoch: input.epoch,
        recipient: "identity" as const,
        userId,
        recipientKeyId: identity.keyId,
        sealed: buffer(
          await sealBox({
            recipientPublicKey: identity.encryptionPublicKey,
            plaintext: input.seed,
            aad: aad(identity.keyId),
            pad: "none",
          }),
        ),
      };
    }),
  );
}

/** Creates a chat key and audience wraps; locked devices use only previously verified public keys. */
export async function createChatKeys(input: {
  workspaceId: Id<"workspaces">;
  scope: ChatScope;
  members?: string[];
}): Promise<{
  keys: ChatKeysSetupWire;
  e2eeId: string;
  epoch: 1;
  publicKey: Uint8Array;
  seed: Uint8Array;
}> {
  const e2eeId = newKeyId();
  const pair = await makeEpoch(input.workspaceId, e2eeId, 1);
  const wraps = await wrapSeed({
    ...input,
    e2eeId,
    epoch: 1,
    seed: pair.seed,
    creatorId: currentUserId(),
  });
  return {
    keys: { e2eeId, epoch: pair.wire, wraps },
    e2eeId,
    epoch: 1,
    publicKey: pair.publicKey,
    seed: pair.seed,
  };
}

/** Binds a just-created in-memory seed to the server-assigned chat ID. */
export function rememberChatSeed(
  chatId: Id<"aisdk_chats">,
  e2eeId: string,
  epoch: number,
  seed: Uint8Array,
): void {
  if (!seeds.has(cacheKey(e2eeId, epoch))) {
    seed.fill(0);
    throw new KeysLockedError();
  }
  seeds.set(cacheKey(chatId, epoch), seed);
  seeds.set(cacheKey(e2eeId, epoch), seed);
  if (deviceEpochs.has(cacheKey(e2eeId, epoch))) deviceEpochs.add(cacheKey(chatId, epoch));
  const status = keyManager.getSnapshot();
  const pending = unsigned.get(cacheKey(e2eeId, epoch));
  if (pending && status.state === "locked") {
    try {
      const name = `radium.e2ee.unsigned.v1:${status.userId}`;
      const entries = JSON.parse(localStorage.getItem(name) ?? "[]") as UnsignedEpoch[];
      const remaining = entries.filter(
        (entry) => !(entry.chatId === chatId && entry.epoch === epoch),
      );
      localStorage.setItem(name, JSON.stringify([...remaining, { ...pending, chatId }]));
    } catch {
      /* Public statement only; missing cache means rotate rather than trust unsigned data. */
    }
  }
}

/** Verifies a signed chat epoch before opening any of its wraps. */
export async function verifyChatEpoch(input: {
  workspaceId: string;
  e2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
  signingPublicKey: Uint8Array;
}): Promise<void> {
  if (
    !(await verify(
      input.signingPublicKey,
      chatKeyStatement({
        workspaceId: input.workspaceId,
        chatE2eeId: input.e2eeId,
        epoch: input.epoch,
        keyId: input.keyId,
        suite: input.suite,
        publicKey: input.publicKey,
      }),
      input.signature,
    ))
  )
    throw new CryptoError("DECRYPT_FAILED", "Chat key signature failed");
}

/** Seed of one chat epoch. Refuses unsigned foreign epochs and unverifiable signers. */
export async function openChatSeed(chatId: Id<"aisdk_chats">, epoch: number): Promise<Uint8Array> {
  const key = cacheKey(chatId, epoch);
  const pending = opening.get(key);
  if (pending) return pending;
  const promise = openCheckedChatSeed(chatId, epoch).finally(() => opening.delete(key));
  opening.set(key, promise);
  return promise;
}

async function openCheckedChatSeed(chatId: Id<"aisdk_chats">, epoch: number): Promise<Uint8Array> {
  const cached = seeds.get(cacheKey(chatId, epoch));
  if (trust.getSnapshot() === "rollback") {
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback blocks key access");
  }
  if (cached) return cached;
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  const generation = secretGeneration();
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
  if (!state.e2eeId) throw new CryptoError("BAD_INPUT", "Chat has no keys");
  const row = state.epochs.find((entry) => entry.epoch === epoch);
  if (!row || !row.signature || !row.signerKeyId)
    throw new CryptoError("DECRYPT_FAILED", "Chat key is unsigned");
  const historical = (await fetchHistoricalIdentities([row.signerKeyId], chatId)).get(
    row.signerKeyId,
  );
  if (!historical) throw new CryptoError("DECRYPT_FAILED", "Chat key signer unavailable");
  let signer: PublicIdentity | undefined;
  if (historical.status === "retired") {
    // Historical signatures can authenticate reads, never future writes. The seed/public-key
    // equality below still binds the opened wrap to this exact signed epoch.
    if (historical.userId === state.creatorId) {
      signer = historical;
    } else {
      const workspace = await verifyWorkspaceState(state.workspace);
      if (
        historical.userId === workspace.ownerId ||
        workspace.verifiedRoster.members.some((member) => member.userId === historical.userId)
      ) {
        signer = historical;
      }
    }
  } else if (historical.userId === currentUserId() || historical.userId === state.creatorId) {
    const signerTrust = await trust.check(historical.userId, historical);
    if (signerTrust === "first-contact" || signerTrust === "changed") {
      await requestIdentityTrust(historical, signerTrust);
    }
    signer = historical;
  } else {
    const candidate = await approvedIdentity(state.workspace, historical.userId);
    if (candidate.keyId === row.signerKeyId) signer = candidate;
  }
  if (!signer) throw new CryptoError("DECRYPT_FAILED", "Unknown chat key signer");
  await verifyChatEpoch({
    workspaceId: state.workspace,
    e2eeId: state.e2eeId,
    ...row,
    publicKey: bytes(row.publicKey),
    signature: bytes(row.signature),
    signingPublicKey: signer.signingPublicKey,
  });
  const wrap =
    state.wraps.find(
      (entry) =>
        entry.chatEpoch === epoch &&
        entry.recipient === "identity" &&
        entry.userId === currentUserId(),
    ) ?? state.wraps.find((entry) => entry.chatEpoch === epoch && entry.recipient === "workspace");
  if (!wrap) throw new CryptoError("DECRYPT_FAILED", "Missing chat key wrap");
  const seed = await openWrap(state.workspace, state.e2eeId, wrap);
  if (!equalBytes(await encryptionPublicKeyFromSeed(seed), bytes(row.publicKey))) {
    seed.fill(0);
    throw new CryptoError("DECRYPT_FAILED", "Chat key does not match epoch");
  }
  if (keyManager.getSnapshot().state !== "unlocked" || secretGeneration() !== generation) {
    seed.fill(0);
    throw new KeysLockedError();
  }
  seeds.set(cacheKey(chatId, epoch), seed);
  return seed;
}

async function openWrap(workspaceId: Id<"workspaces">, e2eeId: string, wrap: WrapRowWire) {
  const aad = {
    table: "e2ee_chat_key_wraps",
    workspace: workspaceId,
    parent: e2eeId,
    record: String(wrap.chatEpoch),
    field: wrap.recipientKeyId,
  };
  if (wrap.recipient === "workspace") {
    if (!Number.isSafeInteger(wrap.workspaceEpoch) || !wrap.workspaceEpoch) {
      throw new CryptoError("BAD_ENVELOPE", "Workspace wrap epoch missing");
    }
    const key = await getMemberKey(workspaceId, wrap.workspaceEpoch);
    if (key.keyId !== wrap.recipientKeyId)
      throw new CryptoError("DECRYPT_FAILED", "Workspace wrap key mismatch");
    return openBox({ seed: key.seed, box: bytes(wrap.sealed), aad, pad: "none" });
  }
  return keyManager.useAmk(async (_, identity) => {
    if (wrap.userId !== currentUserId() || toBase64Url(identity.keyId) !== wrap.recipientKeyId)
      throw new CryptoError("DECRYPT_FAILED", "Identity wrap mismatch");
    return openBox({ seed: identity.encryption.seed, box: bytes(wrap.sealed), aad, pad: "none" });
  });
}

/** Opens a Home row through the complete signed-epoch verification path. */
export async function openRowSeed(input: {
  chatId: Id<"aisdk_chats">;
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  wrap: WrapRowWire;
}): Promise<Uint8Array> {
  return openChatSeed(input.chatId, input.wrap.chatEpoch);
}

/** Rotates stale/revoked or unsigned foreign epochs before producing a writable public key. */
export async function writableChatKey(chatId: Id<"aisdk_chats">): Promise<{
  e2eeId: string;
  workspaceId: Id<"workspaces">;
  epoch: number;
  publicKey: Uint8Array;
}> {
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
  if (!state.e2eeId || !state.keyEpoch) throw new CryptoError("BAD_INPUT", "Chat has no keys");
  const row = state.epochs.find((entry) => entry.epoch === state.keyEpoch);
  if (!row) throw new CryptoError("DECRYPT_FAILED", "Chat key epoch missing");
  // A workspace chat whose current epoch predates the workspace's current key epoch was readable
  // with a removed member's key; the owner's rewrap does not change that, so start a new epoch.
  const stale = state.scope === "workspace" && state.staleForWorkspace;
  const signerIdentity = row.signerKeyId
    ? (await fetchHistoricalIdentities([row.signerKeyId], chatId)).get(row.signerKeyId)
    : null;
  const retiredSigner = signerIdentity?.status === "retired";
  if (
    state.rekey ||
    stale ||
    retiredSigner ||
    (!row.signature && !deviceEpochs.has(cacheKey(chatId, state.keyEpoch)))
  ) {
    if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
    const next = await makeEpoch(state.workspace, state.e2eeId, state.keyEpoch + 1);
    const wraps = await wrapSeed({
      workspaceId: state.workspace,
      e2eeId: state.e2eeId,
      epoch: next.wire.epoch,
      seed: next.seed,
      scope: state.scope,
      members: state.members,
      creatorId: state.creatorId,
    });
    await cryptoClient().mutation(api.e2ee.rotateChatKey, { chatId, epoch: next.wire, wraps });
    rememberChatSeed(chatId, state.e2eeId, next.wire.epoch, next.seed);
    return {
      e2eeId: state.e2eeId,
      workspaceId: state.workspace,
      epoch: next.wire.epoch,
      publicKey: next.publicKey,
    };
  }
  if (row.signature && !deviceEpochs.has(cacheKey(chatId, state.keyEpoch)))
    await openChatSeed(chatId, state.keyEpoch);
  return {
    e2eeId: state.e2eeId,
    workspaceId: state.workspace,
    epoch: state.keyEpoch,
    publicKey: bytes(row.publicKey),
  };
}

/** Adds keys to an existing chat only while its creator is unlocked; leaves legacy content intact. */
export async function ensureChatKeys(chatId: Id<"aisdk_chats">): Promise<boolean> {
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
  if (state.e2eeId) return true;
  if (keyManager.getSnapshot().state !== "unlocked" || state.creatorId !== currentUserId())
    return false;
  if (state.scope === "workspace" && !state.workspaceKeyEpoch) return false;
  const created = await createChatKeys({
    workspaceId: state.workspace,
    scope: state.scope,
    members: state.members,
  });
  await cryptoClient().mutation(api.e2ee.setupChatKeys, { chatId, keys: created.keys });
  rememberChatSeed(chatId, created.e2eeId, 1, created.seed);
  return true;
}

/** Changes audience, rotating on removals and wrapping every historical epoch on additions. */
export async function changeChatScope(input: {
  chatId: Id<"aisdk_chats">;
  scope: ChatScope;
  members?: string[];
}): Promise<void> {
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId: input.chatId });
  if (state.creatorId !== currentUserId())
    throw new CryptoError("BAD_INPUT", "Only the creator changes scope");
  if (!state.e2eeId || !state.keyEpoch) {
    await cryptoClient().mutation(api.aisdk.SetChatScope, input);
    return;
  }
  const removed =
    (state.scope === "workspace" && input.scope !== "workspace") ||
    (state.scope === "shared" &&
      input.scope !== "workspace" &&
      state.members.some((id) => input.scope !== "shared" || !input.members?.includes(id)));
  let rotate: ChatKeysSetupWire["epoch"] | undefined;
  let wraps: WrapWire[] = [];
  if (removed) {
    const next = await makeEpoch(state.workspace, state.e2eeId, state.keyEpoch + 1);
    rotate = next.wire;
    wraps = await wrapSeed({
      workspaceId: state.workspace,
      e2eeId: state.e2eeId,
      epoch: rotate.epoch,
      seed: next.seed,
      scope: input.scope,
      members: input.members,
      creatorId: state.creatorId,
    });
  }
  // Even mixed add/remove operations must grant added recipients the complete history.
  for (const row of state.epochs)
    wraps.push(
      ...(await wrapSeed({
        workspaceId: state.workspace,
        e2eeId: state.e2eeId,
        epoch: row.epoch,
        seed: await openChatSeed(input.chatId, row.epoch),
        scope: input.scope,
        members: input.members,
        creatorId: state.creatorId,
      })),
    );
  await cryptoClient().mutation(api.aisdk.SetChatScope, { ...input, keys: { rotate, wraps } });
}

/** Signs this device's persisted unsigned chat identifiers after unlock, never foreign epochs. */
export async function signUnsignedChatKeys(): Promise<void> {
  const userId = currentUserId();
  let entries: UnsignedEpoch[];
  try {
    entries = JSON.parse(localStorage.getItem(`radium.e2ee.unsigned.v1:${userId}`) ?? "[]");
  } catch {
    return;
  }
  const remaining: UnsignedEpoch[] = [];
  for (const expected of entries) {
    const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId: expected.chatId });
    if (
      state.creatorId !== userId ||
      state.e2eeId !== expected.e2eeId ||
      state.workspace !== expected.workspaceId
    )
      throw new CryptoError("DECRYPT_FAILED", "Unsigned chat identity changed");
    const row = state.epochs.find((entry) => entry.epoch === expected.epoch);
    if (!row || row.signature) continue;
    // Public encryption keys let the backend seal arbitrary seeds. Remembering the exact
    // locally-created statement prevents signing an attacker-known substituted epoch.
    if (
      row.keyId !== expected.keyId ||
      row.suite !== expected.suite ||
      toBase64Url(bytes(row.publicKey)) !== expected.publicKey
    )
      throw new CryptoError("DECRYPT_FAILED", "Unsigned chat public key changed");
    const wrap = state.wraps.find((entry) => entry.chatEpoch === row.epoch);
    if (!wrap) {
      remaining.push(expected);
      continue;
    }
    const seed = await openWrap(state.workspace, state.e2eeId, wrap);
    try {
      if (!equalBytes(await encryptionPublicKeyFromSeed(seed), bytes(row.publicKey)))
        throw new CryptoError("DECRYPT_FAILED", "Unsigned chat key mismatch");
      await keyManager.useAmk(async (_, identity) => {
        const signature = await sign(
          identity.signing.seed,
          chatKeyStatement({
            workspaceId: state.workspace,
            chatE2eeId: state.e2eeId!,
            ...row,
            publicKey: bytes(row.publicKey),
          }),
        );
        await cryptoClient().mutation(api.e2ee.signChatKey, {
          chatId: expected.chatId,
          epoch: row.epoch,
          signerKeyId: toBase64Url(identity.keyId),
          signature: buffer(signature),
        });
      });
    } finally {
      seed.fill(0);
    }
  }
  try {
    localStorage.setItem(`radium.e2ee.unsigned.v1:${userId}`, JSON.stringify(remaining));
  } catch {
    /* No secret material. */
  }
}
