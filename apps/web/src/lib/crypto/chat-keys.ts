import type { Id } from "backend/convex/_generated/dataModel";
import type { AcpSignedBinding } from "backend/src/acp/contract";
import type { FunctionReturnType } from "convex/server";
import { api } from "backend/convex/_generated/api";
import {
  chatKeyBindingStatement,
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
    /** V2 binding to the server-assigned chat ID and its policy; absent only at chat creation. */
    bindingSignature?: ArrayBuffer;
    /** Canonical raw picked members the binding covers; shared chats only. */
    bindingMembers?: string[];
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
type ChatKeysState = FunctionReturnType<typeof api.e2ee.chatKeys>;
type EpochRow = ChatKeysState["epochs"][number];
/**
 * The declared audience a binding signature covers (`chatKeyBindingStatement`): scope, creator and,
 * for a shared chat only, its raw picked members in canonical order.
 */
type ChatPolicy = { scope: ChatScope; creatorId: string; members: string[] };
function chatPolicy(scope: ChatScope, creatorId: string, members: readonly string[] = []): ChatPolicy {
  return { scope, creatorId, members: scope === "shared" ? [...new Set(members)].sort() : [] };
}
const servedPolicy = (state: ChatKeysState): ChatPolicy =>
  chatPolicy(state.scope, state.creatorId, state.members);
const policyKey = (policy: ChatPolicy) =>
  JSON.stringify([policy.scope, policy.creatorId, policy.members]);
const samePolicy = (a: ChatPolicy, b: ChatPolicy) => policyKey(a) === policyKey(b);
/** A stored original policy, or undefined for malformed entries and those stored before bindings. */
function storedPolicy(value: unknown): ChatPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { scope, creatorId, members } = value as Record<string, unknown>;
  if (
    (scope !== "personal" && scope !== "shared" && scope !== "workspace") ||
    typeof creatorId !== "string" ||
    !Array.isArray(members) ||
    !members.every((member) => typeof member === "string")
  )
    return undefined;
  return chatPolicy(scope, creatorId, members);
}
/** Wire members of a binding: the canonical raw picked list of a shared chat, nothing otherwise. */
const bindingMembers = (policy: ChatPolicy) =>
  policy.scope === "shared" ? { bindingMembers: policy.members } : {};
function bindingStatement(input: {
  chatId: string;
  workspaceId: string;
  e2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: Uint8Array;
  policy: ChatPolicy;
}): Uint8Array {
  return chatKeyBindingStatement({
    chatId: input.chatId,
    workspaceId: input.workspaceId,
    chatE2eeId: input.e2eeId,
    epoch: input.epoch,
    keyId: input.keyId,
    suite: input.suite,
    publicKey: input.publicKey,
    scope: input.policy.scope,
    creatorId: input.policy.creatorId,
    members: input.policy.members,
  });
}
/** Exactly what a verified binding covered: the signed row and the policy it was checked against. */
function bindingFingerprint(
  row: {
    signerKeyId?: string;
    keyId: string;
    publicKey: ArrayBuffer | Uint8Array;
    bindingSignature?: ArrayBuffer | Uint8Array;
  },
  policy: ChatPolicy,
): string {
  return JSON.stringify([
    row.signerKeyId ?? null,
    row.keyId,
    toBase64Url(bytes(row.publicKey)),
    row.bindingSignature ? toBase64Url(bytes(row.bindingSignature)) : null,
    policyKey(policy),
  ]);
}
const seeds = new Map<string, Uint8Array>();
/** Original policy of each epoch this device generated, keyed by e2eeId and, once known, chat ID. */
const devicePolicies = new Map<string, ChatPolicy>();
type UnsignedEpoch = {
  chatId: Id<"aisdk_chats">;
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: string;
  /** Original policy the epoch was created for; entries stored before bindings lack it. */
  policy?: ChatPolicy;
};
const unsigned = new Map<string, Omit<UnsignedEpoch, "chatId">>();
/** Current epochs (by chat ID) whose binding and signer authority this session verified. */
const verifiedBindings = new Map<string, string>();
const opening = new Map<string, Promise<Uint8Array>>();
const settingUp = new Map<string, Promise<boolean>>();
onSecretsCleared(() => {
  for (const seed of seeds.values()) seed.fill(0);
  seeds.clear();
  devicePolicies.clear();
  unsigned.clear();
  verifiedBindings.clear();
  opening.clear();
  settingUp.clear();
});
const cacheKey = (id: string, epoch: number) => `${id}:${epoch}`;
const unsignedStore = (userId: string) => `radium.e2ee.unsigned.v1:${userId}`;

/** Drops a locally made epoch the server never accepted, so it is neither reused nor signed. */
function forgetDeviceEpoch(e2eeId: string, epoch: number): void {
  const key = cacheKey(e2eeId, epoch);
  seeds.get(key)?.fill(0);
  seeds.delete(key);
  devicePolicies.delete(key);
  unsigned.delete(key);
}

/**
 * Generates epoch `epoch` for `policy`, remembering the policy for this device. It is signed while
 * unlocked; with the server-assigned `chatId` it is also bound to that chat and policy, which
 * requires unlocked keys. Only a new chat's first epoch is ever created unsigned (locked device).
 */
async function makeEpoch(input: {
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  epoch: number;
  policy: ChatPolicy;
  chatId?: Id<"aisdk_chats">;
}) {
  const { workspaceId, e2eeId, epoch, policy, chatId } = input;
  if (trust.getSnapshot() === "rollback") {
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback blocks new keys");
  }
  const generation = secretGeneration();
  if (chatId && keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
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
      if (!chatId) return;
      wire.bindingSignature = buffer(
        await sign(
          identity.signing.seed,
          bindingStatement({ chatId, workspaceId, e2eeId, ...wire, publicKey: pair.publicKey, policy }),
        ),
      );
      Object.assign(wire, bindingMembers(policy));
    });
  }
  if (secretGeneration() !== generation || (chatId && !wire.bindingSignature)) {
    pair.seed.fill(0);
    throw new KeysLockedError();
  }
  seeds.set(cacheKey(e2eeId, epoch), pair.seed);
  devicePolicies.set(cacheKey(e2eeId, epoch), policy);
  if (!wire.signature) {
    unsigned.set(cacheKey(e2eeId, epoch), {
      workspaceId,
      e2eeId,
      epoch,
      keyId: wire.keyId,
      suite: wire.suite,
      publicKey: toBase64Url(pair.publicKey),
      policy,
    });
  }
  return { wire, ...pair };
}

/**
 * Who receives a new chat epoch. A workspace chat seals to the workspace key. A personal or shared
 * chat seals to its creator and a shared chat's picked members, each only while still a workspace
 * user, exactly as `validateChatWraps` requires: a creator or member who left keeps the history
 * they held but never receives a new epoch, even while a removal batch has not yet deleted their
 * `chat_members` row. `withoutKeys` lists recipients that have no active identity yet.
 */
type ChatAudience =
  | { scope: "workspace" }
  | { scope: "personal" | "shared"; recipients: string[]; withoutKeys: string[] };

async function chatAudience(input: {
  workspaceId: Id<"workspaces">;
  scope: ChatScope;
  members?: string[];
  creatorId: string;
}): Promise<ChatAudience> {
  if (input.scope === "workspace") return { scope: "workspace" };
  const ownId = currentUserId();
  const candidates = [
    ...new Set([input.creatorId, ...(input.scope === "shared" ? (input.members ?? []) : [])]),
  ];
  if (candidates.every((userId) => userId === ownId)) {
    return { scope: input.scope, recipients: candidates, withoutKeys: [] };
  }
  const workspace = await cryptoClient().query(api.e2ee.workspaceKeyState, {
    workspace: input.workspaceId,
  });
  // Workspace users are the owner and explicit members; `keyId` is their active identity, if any.
  // A removal racing this read makes the server refuse the wraps; nothing is sealed to a leaver.
  const keyIds = new Map(workspace.members.map((member) => [member.userId, member.keyId]));
  const recipients = candidates.filter((userId) => userId === ownId || keyIds.has(userId));
  return {
    scope: input.scope,
    recipients,
    withoutKeys: recipients.filter((userId) => userId !== ownId && !keyIds.get(userId)),
  };
}

async function wrapSeed(input: {
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  epoch: number;
  seed: Uint8Array;
  audience: ChatAudience;
}): Promise<WrapWire[]> {
  const aad = (recipientKeyId: string) => ({
    table: "e2ee_chat_key_wraps",
    workspace: input.workspaceId,
    parent: input.e2eeId,
    record: String(input.epoch),
    field: recipientKeyId,
  });
  if (input.audience.scope === "workspace") {
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
  return Promise.all(
    input.audience.recipients.map(async (userId) => {
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

async function newChatKeys(
  workspaceId: Id<"workspaces">,
  audience: ChatAudience,
  policy: ChatPolicy,
  chatId?: Id<"aisdk_chats">,
) {
  const e2eeId = newKeyId();
  const pair = await makeEpoch({ workspaceId, e2eeId, epoch: 1, policy, chatId });
  const wraps = await wrapSeed({ workspaceId, e2eeId, epoch: 1, seed: pair.seed, audience });
  return {
    keys: { e2eeId, epoch: pair.wire, wraps } satisfies ChatKeysSetupWire,
    e2eeId,
    epoch: 1 as const,
    publicKey: pair.publicKey,
    seed: pair.seed,
  };
}

/**
 * Creates a new chat's first key and audience wraps before the server assigns its ID; locked
 * devices use only previously verified public keys. The epoch carries no binding, so this device
 * remembers its original policy: the creator may continue it while locked, or bind it when signing
 * it after unlock, only while the server still serves that exact policy.
 */
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
  // The creator is this user, so the audience needs no workspace lookup (locked creation works).
  const audience: ChatAudience =
    input.scope === "workspace"
      ? { scope: "workspace" }
      : {
          scope: input.scope,
          recipients: [
            ...new Set([
              currentUserId(),
              ...(input.scope === "shared" ? (input.members ?? []) : []),
            ]),
          ],
          withoutKeys: [],
        };
  return newChatKeys(
    input.workspaceId,
    audience,
    chatPolicy(input.scope, currentUserId(), input.members),
  );
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
  const policy = devicePolicies.get(cacheKey(e2eeId, epoch));
  if (policy) devicePolicies.set(cacheKey(chatId, epoch), policy);
  const status = keyManager.getSnapshot();
  const pending = unsigned.get(cacheKey(e2eeId, epoch));
  if (pending && status.state === "locked") {
    try {
      const name = unsignedStore(status.userId);
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
  } else {
    signer = await activeSigner(state.workspace, state.creatorId, historical);
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
  const wrap = usableWrap(state, epoch);
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

/**
 * Authenticates the active identity that signed an epoch: this account or the chat's creator by
 * pin, anyone else through the roster or an explicit approval of exactly that key.
 */
async function activeSigner(
  workspaceId: Id<"workspaces">,
  creatorId: string,
  identity: PublicIdentity,
): Promise<PublicIdentity | undefined> {
  if (identity.userId === currentUserId() || identity.userId === creatorId) {
    const signerTrust = await trust.check(identity.userId, identity);
    if (signerTrust === "first-contact" || signerTrust === "changed") {
      await requestIdentityTrust(identity, signerTrust);
    }
    return identity;
  }
  const candidate = await approvedIdentity(workspaceId, identity.userId);
  return candidate.keyId === identity.keyId ? candidate : undefined;
}

/**
 * This reader's wrap of `epoch`: its own identity wrap, or the workspace wrap only while the chat is
 * workspace-scoped. A workspace wrap served for another scope is a replayed key every workspace
 * member could open; narrowing gives every historical epoch identity wraps instead.
 */
function usableWrap(state: ChatKeysState, epoch: number) {
  return (
    state.wraps.find(
      (entry) =>
        entry.chatEpoch === epoch &&
        entry.recipient === "identity" &&
        entry.userId === currentUserId(),
    ) ??
    (state.scope === "workspace"
      ? state.wraps.find((entry) => entry.chatEpoch === epoch && entry.recipient === "workspace")
      : undefined)
  );
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

/**
 * Starts epoch `epoch` of a keyed chat for `audience`, bound to the chat and the served `policy`,
 * and keeps its seed for this device.
 */
async function rotateChatEpoch(input: {
  chatId: Id<"aisdk_chats">;
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  epoch: number;
  audience: ChatAudience;
  policy: ChatPolicy;
}) {
  const next = await makeEpoch({
    workspaceId: input.workspaceId,
    e2eeId: input.e2eeId,
    epoch: input.epoch,
    policy: input.policy,
    chatId: input.chatId,
  });
  try {
    const wraps = await wrapSeed({
      workspaceId: input.workspaceId,
      e2eeId: input.e2eeId,
      epoch: input.epoch,
      seed: next.seed,
      audience: input.audience,
    });
    await cryptoClient().mutation(api.e2ee.rotateChatKey, {
      chatId: input.chatId,
      epoch: next.wire,
      wraps,
    });
  } catch (error) {
    forgetDeviceEpoch(input.e2eeId, input.epoch);
    throw error;
  }
  rememberChatSeed(input.chatId, input.e2eeId, input.epoch, next.seed);
  verifiedBindings.set(
    cacheKey(input.chatId, input.epoch),
    bindingFingerprint(next.wire, input.policy),
  );
  return {
    e2eeId: input.e2eeId,
    workspaceId: input.workspaceId,
    epoch: input.epoch,
    publicKey: next.publicKey,
  };
}

/**
 * Who may have created a chat's current epoch: for a personal chat its creator; for a shared chat
 * its creator or a currently picked member; for a workspace chat the owner or a roster member.
 */
async function signerAuthorized(
  workspaceId: Id<"workspaces">,
  userId: string,
  policy: ChatPolicy,
): Promise<boolean> {
  if (policy.scope === "personal") return userId === policy.creatorId;
  if (policy.scope === "shared") {
    return userId === policy.creatorId || policy.members.includes(userId);
  }
  const { verifiedRoster } = await verifyWorkspaceState(workspaceId);
  return (
    userId === verifiedRoster.owner.userId ||
    verifiedRoster.members.some((member) => member.userId === userId)
  );
}

/**
 * Checks a bound current epoch for new encryption against the served `policy`. "valid": an active,
 * authorized signer bound exactly this chat ID, scope, creator and picked members. "rotate": the
 * epoch may only be replaced (retired signer, signer without current authority, or a proven
 * removal of picked members who left the workspace). Every other mismatch throws: a binding that
 * does not prove the served policy never authorizes encryption, re-certification or widening.
 */
async function currentBinding(
  chatId: Id<"aisdk_chats">,
  state: ChatKeysState,
  row: EpochRow,
  policy: ChatPolicy,
): Promise<"valid" | "rotate"> {
  const failed = new CryptoError("DECRYPT_FAILED", "Chat key binding failed");
  if (!row.bindingSignature || !row.signature || !row.signerKeyId || !state.e2eeId) throw failed;
  if (policy.scope !== "shared" && row.bindingMembers?.length) throw failed;
  const identity = (await fetchHistoricalIdentities([row.signerKeyId], chatId)).get(
    row.signerKeyId,
  );
  if (!identity) throw new CryptoError("DECRYPT_FAILED", "Chat key signer unavailable");
  // Historical signatures authenticate reads, never future writes.
  if (identity.status === "retired") return "rotate";
  const key = cacheKey(chatId, row.epoch);
  const fingerprint = bindingFingerprint(row, policy);
  if (verifiedBindings.get(key) === fingerprint) return "valid";
  const generation = secretGeneration();
  const publicKey = bytes(row.publicKey);
  await verifyChatEpoch({
    workspaceId: state.workspace,
    e2eeId: state.e2eeId,
    ...row,
    publicKey,
    signature: bytes(row.signature),
    signingPublicKey: identity.signingPublicKey,
  });
  // The signature covers the authenticated original members; the served ones are compared after.
  const bound = chatPolicy(policy.scope, policy.creatorId, row.bindingMembers ?? []);
  if (
    !(await verify(
      identity.signingPublicKey,
      bindingStatement({
        chatId,
        workspaceId: state.workspace,
        e2eeId: state.e2eeId,
        ...row,
        publicKey,
        policy: bound,
      }),
      bytes(row.bindingSignature),
    ))
  )
    throw failed;
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  const signer = await activeSigner(state.workspace, state.creatorId, identity);
  if (!signer || !equalBytes(signer.signingPublicKey, identity.signingPublicKey))
    throw new CryptoError("DECRYPT_FAILED", "Unknown chat key signer");
  if (!samePolicy(bound, policy)) {
    // A removal batch prunes picked members who left the workspace. Only that narrowing is
    // accepted, and only to start a fresh epoch: nothing added, every missing member absent from
    // the owner-signed roster.
    if (policy.members.some((userId) => !bound.members.includes(userId))) throw failed;
    const { verifiedRoster } = await verifyWorkspaceState(state.workspace);
    const departed = bound.members.filter((userId) => !policy.members.includes(userId));
    if (
      departed.some(
        (userId) =>
          userId === verifiedRoster.owner.userId ||
          verifiedRoster.members.some((member) => member.userId === userId),
      )
    )
      throw failed;
    return "rotate";
  }
  if (!(await signerAuthorized(state.workspace, identity.userId, policy))) return "rotate";
  if (secretGeneration() === generation) verifiedBindings.set(key, fingerprint);
  return "valid";
}

type KeyPlan = { kind: "use" } | { kind: "sign"; expected: UnsignedEpoch } | { kind: "rotate" };

/**
 * How new content may be encrypted to a chat's current epoch. A bound epoch is used only while
 * fresh and after `currentBinding`. An unbound one (made before its chat ID existed, or by an
 * earlier version) is never certified from server data: only this device's own epoch, while the
 * server still serves its remembered original policy, is continued while locked or, still unsigned
 * after unlock, signed and bound. Everything else needs a fresh bound epoch.
 */
async function planCurrentKey(
  chatId: Id<"aisdk_chats">,
  state: ChatKeysState,
  row: EpochRow,
): Promise<KeyPlan> {
  const policy = servedPolicy(state);
  // A workspace chat whose current epoch predates the workspace's current key epoch was readable
  // with a removed member's key; the owner's rewrap does not change that, so start a new epoch.
  const stale = state.rekey || (state.scope === "workspace" && state.staleForWorkspace);
  if (row.bindingSignature) {
    const binding = await currentBinding(chatId, state, row, policy);
    return binding === "valid" && !stale ? { kind: "use" } : { kind: "rotate" };
  }
  const key = cacheKey(chatId, row.epoch);
  const own = devicePolicies.get(key);
  if (stale || !own || !samePolicy(own, policy) || !seeds.has(key)) return { kind: "rotate" };
  if (keyManager.getSnapshot().state !== "unlocked") return { kind: "use" };
  const pending = row.signature ? undefined : unsigned.get(cacheKey(state.e2eeId!, row.epoch));
  return pending ? { kind: "sign", expected: { ...pending, chatId } } : { kind: "rotate" };
}

function requireOwnUnsignedChat(state: ChatKeysState, expected: UnsignedEpoch): void {
  if (
    state.creatorId !== currentUserId() ||
    state.e2eeId !== expected.e2eeId ||
    state.workspace !== expected.workspaceId
  )
    throw new CryptoError("DECRYPT_FAILED", "Unsigned chat identity changed");
}

/**
 * Signs this device's own unsigned epoch, never a substituted one: the served public key must be
 * the remembered one and match the opened seed. The v1 signature keeps its history readable; the
 * binding is added only for the current epoch while the server serves exactly the remembered
 * original policy. "unavailable": no seed can be opened yet.
 */
async function signOwnEpoch(
  state: ChatKeysState,
  row: EpochRow,
  expected: UnsignedEpoch,
): Promise<"bound" | "signed" | "unavailable"> {
  requireOwnUnsignedChat(state, expected);
  const publicKey = bytes(row.publicKey);
  // Public encryption keys let the backend seal arbitrary seeds. Remembering the exact
  // locally-created statement prevents signing an attacker-known substituted epoch.
  if (
    row.keyId !== expected.keyId ||
    row.suite !== expected.suite ||
    toBase64Url(publicKey) !== expected.publicKey
  )
    throw new CryptoError("DECRYPT_FAILED", "Unsigned chat public key changed");
  const cached = seeds.get(cacheKey(expected.chatId, row.epoch));
  const wrap = cached ? undefined : usableWrap(state, row.epoch);
  if (!cached && !wrap) return "unavailable";
  const seed = cached ?? (await openWrap(state.workspace, expected.e2eeId, wrap!));
  try {
    if (!equalBytes(await encryptionPublicKeyFromSeed(seed), publicKey))
      throw new CryptoError("DECRYPT_FAILED", "Unsigned chat key mismatch");
    const policy =
      row.epoch === state.keyEpoch &&
      expected.policy &&
      samePolicy(expected.policy, servedPolicy(state))
        ? expected.policy
        : undefined;
    const signed = await keyManager.useAmk(async (_, identity) => {
      const statement = {
        workspaceId: state.workspace,
        e2eeId: expected.e2eeId,
        epoch: row.epoch,
        keyId: row.keyId,
        suite: row.suite,
        publicKey,
      };
      const signature = await sign(
        identity.signing.seed,
        chatKeyStatement({ ...statement, chatE2eeId: expected.e2eeId }),
      );
      const bindingSignature = policy
        ? await sign(
            identity.signing.seed,
            bindingStatement({ ...statement, chatId: expected.chatId, policy }),
          )
        : undefined;
      const signerKeyId = toBase64Url(identity.keyId);
      await cryptoClient().mutation(api.e2ee.signChatKey, {
        chatId: expected.chatId,
        epoch: row.epoch,
        signerKeyId,
        signature: buffer(signature),
        ...(policy && bindingSignature
          ? { bindingSignature: buffer(bindingSignature), ...bindingMembers(policy) }
          : {}),
      });
      return { signerKeyId, bindingSignature };
    });
    unsigned.delete(cacheKey(expected.e2eeId, row.epoch));
    if (!policy || !signed.bindingSignature) return "signed";
    verifiedBindings.set(
      cacheKey(expected.chatId, row.epoch),
      bindingFingerprint({ ...row, ...signed }, policy),
    );
    return "bound";
  } finally {
    if (!cached) seed.fill(0);
  }
}

/**
 * Produces the public key new content is encrypted to, starting a fresh bound epoch whenever the
 * current one is stale, unbound (other than this device's own new chat), signed by a retired or
 * unauthorized identity, or bound to members proven to have left. A binding that fails throws.
 */
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
  const plan = await planCurrentKey(chatId, state, row);
  if (
    plan.kind === "rotate" ||
    (plan.kind === "sign" && (await signOwnEpoch(state, row, plan.expected)) !== "bound")
  ) {
    if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
    return rotateChatEpoch({
      chatId,
      workspaceId: state.workspace,
      e2eeId: state.e2eeId,
      epoch: state.keyEpoch + 1,
      policy: servedPolicy(state),
      audience: await chatAudience({
        workspaceId: state.workspace,
        scope: state.scope,
        members: state.members,
        creatorId: state.creatorId,
      }),
    });
  }
  // Authenticate the exact queried public key even for a locally created/cached epoch. A second
  // query inside openChatSeed may return different metadata; a cache hit alone authenticates no row.
  const seed = await openChatSeed(chatId, state.keyEpoch);
  if (!equalBytes(await encryptionPublicKeyFromSeed(seed), bytes(row.publicKey))) {
    throw new CryptoError("DECRYPT_FAILED", "Chat key does not match epoch");
  }
  return {
    e2eeId: state.e2eeId,
    workspaceId: state.workspace,
    epoch: state.keyEpoch,
    publicKey: bytes(row.publicKey),
  };
}

/**
 * Gives a keyless chat its initial key epoch; leaves legacy content intact. Any current reader may
 * do this while unlocked: the epoch is signed by this account's identity, bound to the chat's ID and
 * current policy, and wrapped to exactly the chat's current audience, never to anyone new. Resolves
 * false without writing anything while setup is blocked: keys locked, a workspace without keys, or
 * an audience member without encryption keys (historical content then stays in custody).
 * Concurrent calls for one chat share one attempt, and losing a race against another reader's
 * setup converges on the winner's epoch.
 */
export function ensureChatKeys(chatId: Id<"aisdk_chats">): Promise<boolean> {
  const pending = settingUp.get(chatId);
  if (pending) return pending;
  const attempt = setupInitialChatKeys(chatId).finally(() => settingUp.delete(chatId));
  settingUp.set(chatId, attempt);
  return attempt;
}

async function setupInitialChatKeys(chatId: Id<"aisdk_chats">): Promise<boolean> {
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
  if (state.e2eeId) return true;
  if (keyManager.getSnapshot().state !== "unlocked") return false;
  if (state.scope === "workspace" && !state.workspaceKeyEpoch) return false;
  const audience = await chatAudience({
    workspaceId: state.workspace,
    scope: state.scope,
    members: state.members,
    creatorId: state.creatorId,
  });
  if (audience.scope !== "workspace") {
    // Other recipients' keys are trusted only through the workspace roster, and every recipient
    // needs an identity: a partial audience would hide history from a current reader.
    const others = audience.recipients.some((userId) => userId !== currentUserId());
    if ((others && !state.workspaceKeyEpoch) || audience.withoutKeys.length > 0) return false;
  }
  const policy = servedPolicy(state);
  // The server accepts only this reader's bound signature; a lock while signing leaves none.
  const created = await newChatKeys(state.workspace, audience, policy, chatId).catch(
    (error: unknown) => {
      if (error instanceof KeysLockedError) return undefined;
      throw error;
    },
  );
  if (!created) return false;
  try {
    await cryptoClient().mutation(api.e2ee.setupChatKeys, { chatId, keys: created.keys });
  } catch (error) {
    forgetDeviceEpoch(created.e2eeId, 1);
    // Another reader's setup committed first; its epoch is opened through the normal signer checks.
    const current = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
    if (current.e2eeId) return true;
    throw error;
  }
  rememberChatSeed(chatId, created.e2eeId, 1, created.seed);
  verifiedBindings.set(cacheKey(chatId, 1), bindingFingerprint(created.keys.epoch, policy));
  return true;
}

/**
 * Lets a reader of custodial chat history give the chat a key that history can be released to,
 * without sending a message: the initial epoch of a keyless chat (`ensureChatKeys`), the binding of
 * this device's own unsigned epoch, or a fresh bound epoch whenever `writableChatKey` would start
 * one (stale, unbound, retired or unauthorized signer, departed picked members), which any reader
 * may start. Signing or the new epoch schedules the server-side release. Nothing happens while the
 * current key is bound and fresh. Resolves false while blocked by locked keys or missing recipient
 * or workspace keys; a binding that fails throws rather than releasing to it.
 */
export async function prepareCustodyRelease(chatId: Id<"aisdk_chats">): Promise<boolean> {
  if (!(await ensureChatKeys(chatId))) return false;
  if (keyManager.getSnapshot().state !== "unlocked") return false;
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
  if (!state.e2eeId || !state.keyEpoch) return false;
  const row = state.epochs.find((entry) => entry.epoch === state.keyEpoch);
  if (!row) throw new CryptoError("DECRYPT_FAILED", "Chat key epoch missing");
  const plan = await planCurrentKey(chatId, state, row);
  if (plan.kind === "use") return true;
  if (plan.kind === "sign" && (await signOwnEpoch(state, row, plan.expected)) === "bound") {
    return true;
  }
  const audience = await chatAudience({
    workspaceId: state.workspace,
    scope: state.scope,
    members: state.members,
    creatorId: state.creatorId,
  });
  if (audience.scope !== "workspace" && audience.withoutKeys.length > 0) return false;
  try {
    await rotateChatEpoch({
      chatId,
      workspaceId: state.workspace,
      e2eeId: state.e2eeId,
      epoch: state.keyEpoch + 1,
      audience,
      policy: servedPolicy(state),
    });
  } catch (error) {
    // Another reader rotated first; the release follows their fresh epoch.
    const current = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
    if (current.keyEpoch !== state.keyEpoch && !current.rekey && !current.staleForWorkspace) {
      return true;
    }
    throw error;
  }
  return true;
}

/**
 * Changes audience. Every actual change of scope or picked members starts a fresh epoch bound to
 * the next policy, so no earlier binding ever certifies a new audience; every historical epoch is
 * also wrapped for the new audience, so added readers get the complete history. An ACP chat with
 * keys passes `acpBinding`: the creator's re-signed binding (version + 1) for the new scope and
 * members, stored in the same mutation so the Worker never sees keys without it.
 */
export async function changeChatScope(input: {
  chatId: Id<"aisdk_chats">;
  scope: ChatScope;
  members?: string[];
  acpBinding?: AcpSignedBinding;
}): Promise<void> {
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId: input.chatId });
  if (state.creatorId !== currentUserId())
    throw new CryptoError("BAD_INPUT", "Only the creator changes scope");
  // The server keeps a shared chat's picked members when none are supplied.
  const members =
    input.scope === "shared"
      ? (input.members ?? (state.scope === "shared" ? state.members : []))
      : [];
  const next = chatPolicy(input.scope, state.creatorId, members);
  if (!state.e2eeId || !state.keyEpoch || samePolicy(next, servedPolicy(state))) {
    await cryptoClient().mutation(api.aisdk.SetChatScope, input);
    return;
  }
  const audience = await chatAudience({
    workspaceId: state.workspace,
    scope: input.scope,
    members,
    creatorId: state.creatorId,
  });
  const epoch = state.keyEpoch + 1;
  const fresh = await makeEpoch({
    workspaceId: state.workspace,
    e2eeId: state.e2eeId,
    epoch,
    policy: next,
    chatId: input.chatId,
  });
  try {
    const wraps = await wrapSeed({
      workspaceId: state.workspace,
      e2eeId: state.e2eeId,
      epoch,
      seed: fresh.seed,
      audience,
    });
    for (const row of state.epochs)
      wraps.push(
        ...(await wrapSeed({
          workspaceId: state.workspace,
          e2eeId: state.e2eeId,
          epoch: row.epoch,
          seed: await openChatSeed(input.chatId, row.epoch),
          audience,
        })),
      );
    await cryptoClient().mutation(api.aisdk.SetChatScope, {
      ...input,
      keys: { rotate: fresh.wire, wraps },
    });
  } catch (error) {
    forgetDeviceEpoch(state.e2eeId, epoch);
    throw error;
  }
  rememberChatSeed(input.chatId, state.e2eeId, epoch, fresh.seed);
  verifiedBindings.set(cacheKey(input.chatId, epoch), bindingFingerprint(fresh.wire, next));
}

/**
 * Signs this device's persisted unsigned chat epochs after unlock, never foreign or substituted
 * ones. Entries stored before bindings, and epochs that are no longer current or whose served
 * policy differs from the remembered one, get only the v1 signature for their history; new
 * content then starts a fresh bound epoch.
 */
export async function signUnsignedChatKeys(): Promise<void> {
  const userId = currentUserId();
  let entries: UnsignedEpoch[];
  try {
    entries = JSON.parse(localStorage.getItem(unsignedStore(userId)) ?? "[]");
  } catch {
    return;
  }
  const remaining: UnsignedEpoch[] = [];
  for (const entry of entries) {
    const expected = { ...entry, policy: storedPolicy(entry.policy) };
    const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId: expected.chatId });
    requireOwnUnsignedChat(state, expected);
    const row = state.epochs.find((epoch) => epoch.epoch === expected.epoch);
    if (!row || row.signature) continue;
    if ((await signOwnEpoch(state, row, expected)) === "unavailable") remaining.push(entry);
  }
  try {
    localStorage.setItem(unsignedStore(userId), JSON.stringify(remaining));
  } catch {
    /* No secret material. */
  }
}
