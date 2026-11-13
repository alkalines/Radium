import { api } from "backend/convex/_generated/api";
import type { Doc, Id } from "backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import {
  CryptoError,
  encryptionPublicKeyFromSeed,
  equalBytes,
  fromBase64Url,
  generateEncryptionKeyPair,
  generateShortSecret,
  grantStatement,
  openBox,
  phraseToEntropy,
  randomBytes,
  sealBox,
  sha256,
  sign,
  toBase64Url,
} from "radium-crypto";
import { keyManager, KeysLockedError } from "./key-manager";
import {
  cacheWorkspacePublicKey,
  cachedWorkspacePublicKey,
  fetchHistoricalIdentities,
  fetchIdentities,
} from "./public-keys";
import {
  advanceHighWater,
  buffer,
  bytes,
  cryptoClient,
  currentUserId,
  highWater,
  newKeyId,
  onSecretsCleared,
  secretGeneration,
} from "./runtime";
import { trust, type PublicIdentity } from "./trust-store";
import { requestIdentityTrust } from "./trust-requests";
import {
  joinMac,
  openInvitePayload,
  openWorkspaceGrant,
  sealInvitePayload,
  signRoster,
  verifyRoster,
  type InvitePayload,
  type RosterMember,
  type WorkspaceRoster,
} from "./workspace-proofs";

type KeyState = FunctionReturnType<typeof api.e2ee.workspaceKeyState>;
type VerifiedState = KeyState & {
  identities: Map<string, PublicIdentity>;
  verifiedRoster: WorkspaceRoster;
};
type WorkspaceKey = { epoch: number; keyId: string; publicKey: Uint8Array; seed: Uint8Array };
const ring = new Map<string, WorkspaceKey>();
const verifiedStates = new Map<string, { key: string; promise: Promise<VerifiedState> }>();
const stateLoads = new Map<string, Promise<VerifiedState>>();
const cacheKey = (workspaceId: string, epoch: number, purpose: string) =>
  `${workspaceId}:${epoch}:${purpose}`;
onSecretsCleared(() => {
  for (const key of ring.values()) key.seed.fill(0);
  ring.clear();
  verifiedStates.clear();
  stateLoads.clear();
});
trust.subscribe(() => {
  verifiedStates.clear();
  stateLoads.clear();
});
/** Raised before any unapproved or changed identity receives or authenticates keys. */
export class TrustRequiredError extends Error {
  constructor(
    public readonly identity: PublicIdentity,
    public readonly trustState: "first-contact" | "changed",
  ) {
    super(
      trustState === "changed"
        ? "Identity key changed; approval required"
        : "Approve this identity before exchanging keys",
    );
    this.name = "TrustRequiredError";
  }
}
async function requireTrust(identity: PublicIdentity) {
  const state = await trust.check(identity.userId, identity);
  if (state === "first-contact" || state === "changed") {
    await requestIdentityTrust(identity, state);
  }
}
/** Loads the current roster, requiring an explicitly pinned owner and checking every epoch hash. */
export function verifyWorkspaceState(workspaceId: Id<"workspaces">): Promise<VerifiedState> {
  const pending = stateLoads.get(workspaceId);
  if (pending) return pending;
  const load = (async () => {
    const state = await cryptoClient().query(api.e2ee.workspaceKeyState, {
      workspace: workspaceId,
    });
    // Include ciphertext and public byte fields: equal version numbers alone cannot authenticate
    // a substituted roster/epoch. Repeated callers share verification, never bypass freshness.
    const key = JSON.stringify(state, (_, value) =>
      value instanceof ArrayBuffer ? toBase64Url(bytes(value)) : value,
    );
    const cached = verifiedStates.get(workspaceId);
    if (cached?.key === key) return cached.promise;
    const promise = verifyState(workspaceId, state);
    verifiedStates.set(workspaceId, { key, promise });
    try {
      return await promise;
    } catch (error) {
      verifiedStates.delete(workspaceId);
      throw error;
    }
  })().finally(() => stateLoads.delete(workspaceId));
  stateLoads.set(workspaceId, load);
  return load;
}

async function verifyState(workspaceId: Id<"workspaces">, state: KeyState): Promise<VerifiedState> {
  const generation = secretGeneration();
  const identities = await fetchIdentities([
    state.ownerId,
    currentUserId(),
    ...state.members.map((member) => member.userId),
    ...state.myGrants.map((grant) => grant.granterUserId),
  ]);
  const owner = identities.get(state.ownerId);
  if (!owner || !state.roster || !state.keyEpoch)
    throw new CryptoError("DECRYPT_FAILED", "Workspace roster missing");
  await requireTrust(owner);
  const marker = `radium.e2ee.roster.v1:${workspaceId}`;
  let roster = state.roster;
  if (roster.signerKeyId !== owner.keyId && state.ownerId === currentUserId()) {
    const historical = (await fetchHistoricalIdentities([roster.signerKeyId])).get(
      roster.signerKeyId,
    );
    if (!historical || historical.status !== "retired" || historical.userId !== state.ownerId) {
      throw new CryptoError("DECRYPT_FAILED", "Historical roster owner unavailable");
    }
    // Only the owner may re-endorse a historical roster after resetting their identity.
    // Members wait for this fresh signature and approve the owner's changed active identity.
    const previous = await verifyRoster({
      workspaceId,
      ...roster,
      body: bytes(roster.body),
      signature: bytes(roster.signature),
      owner: historical,
      highWater: highWater(marker),
    });
    const resigned = await wireRoster({
      ...previous,
      version: previous.version + 1,
      owner: memberBinding(owner),
    });
    await cryptoClient().mutation(api.e2ee.publishRoster, {
      workspace: workspaceId,
      roster: resigned,
    });
    roster = { ...roster, ...resigned };
  }
  const verifiedRoster = await verifyRoster({
    workspaceId,
    version: roster.version,
    signerKeyId: roster.signerKeyId,
    body: bytes(roster.body),
    signature: bytes(roster.signature),
    owner,
    highWater: highWater(marker),
  });
  if (
    verifiedRoster.epoch !== state.keyEpoch ||
    state.epochs.length !== verifiedRoster.epochs.length
  )
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch rollback or substitution");
  for (const epoch of state.epochs) {
    const entry = verifiedRoster.epochs.find((row) => row.epoch === epoch.epoch);
    if (
      !entry ||
      entry.memberKeyId !== epoch.memberKeyId ||
      entry.ownerKeyId !== epoch.ownerKeyId ||
      entry.memberKeyHash !== toBase64Url(await sha256(bytes(epoch.memberPublicKey))) ||
      entry.ownerKeyHash !== toBase64Url(await sha256(bytes(epoch.ownerPublicKey)))
    )
      throw new CryptoError("DECRYPT_FAILED", "Workspace epoch differs from signed roster");
  }
  if (secretGeneration() !== generation) {
    throw new KeysLockedError();
  }
  advanceHighWater(marker, verifiedRoster.version);
  const latest = state.epochs.find((epoch) => epoch.epoch === state.keyEpoch)!;
  cacheWorkspacePublicKey(workspaceId, {
    epoch: latest.epoch,
    keyId: latest.memberKeyId,
    publicKey: bytes(latest.memberPublicKey),
  });
  return { ...state, identities, verifiedRoster };
}
/** Checks an identity pin, plus owner endorsement when the identity is not the chat creator. */
export async function trustedIdentity(
  workspaceId: Id<"workspaces">,
  userId: string,
  allowPinnedCreator = false,
): Promise<PublicIdentity> {
  const state = await verifyWorkspaceState(workspaceId);
  const identity = state.identities.get(userId);
  if (!identity) throw new CryptoError("DECRYPT_FAILED", "Identity unavailable");
  if (userId === currentUserId() || userId === state.ownerId || allowPinnedCreator) {
    await requireTrust(identity);
    return identity;
  }
  // The user's own pin decides first: a changed key must be approved explicitly even when the
  // server presents it, and an approved (tofu/verified) key needs no further endorsement.
  const pinState = await trust.check(userId, identity);
  if (pinState === "changed") {
    await requestIdentityTrust(identity, "changed");
    return identity;
  }
  if (pinState === "tofu" || pinState === "verified") {
    return identity;
  }
  // First contact: the owner-signed roster endorses members; anyone else needs an explicit approval.
  const member = state.verifiedRoster.members.find(
    (entry) =>
      entry.userId === userId &&
      entry.keyId === identity.keyId &&
      entry.fingerprint === identity.fingerprint,
  );
  if (!member) {
    await requestIdentityTrust(identity, "first-contact");
  }
  return identity;
}
async function getWorkspaceKey(
  workspaceId: Id<"workspaces">,
  epoch: number,
  purpose: "member" | "owner",
): Promise<WorkspaceKey> {
  if (trust.getSnapshot() === "rollback") {
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback blocks key access");
  }
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  const cached = ring.get(cacheKey(workspaceId, epoch, purpose));
  if (cached) return cached;
  const generation = secretGeneration();
  const state = await verifyWorkspaceState(workspaceId);
  const row = state.epochs.find((entry) => entry.epoch === epoch);
  const rosterEpoch = state.verifiedRoster.epochs.find((entry) => entry.epoch === epoch);
  if (!row || !rosterEpoch) throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  return keyManager.useAmk(async (_, own) => {
    const recipientKeyId = toBase64Url(own.keyId);
    const grant = state.myGrants.find(
      (entry) =>
        entry.epoch === epoch &&
        entry.purpose === purpose &&
        entry.recipientKeyId === recipientKeyId,
    );
    if (!grant) throw new CryptoError("DECRYPT_FAILED", "Workspace key not granted");
    let granter = state.identities.get(grant.granterUserId);
    const retired = granter?.keyId !== grant.granterKeyId;
    if (retired) {
      granter = (await fetchHistoricalIdentities([grant.granterKeyId])).get(grant.granterKeyId);
      const endorsedUser =
        grant.granterUserId === state.ownerId ||
        state.verifiedRoster.members.some((member) => member.userId === grant.granterUserId);
      // Historical signatures authenticate reads only through the current owner's epoch hash;
      // a retired signer cannot introduce a new seed or authorize owner-key grants as a member.
      if (
        !granter ||
        granter.status !== "retired" ||
        granter.userId !== grant.granterUserId ||
        !endorsedUser ||
        (purpose === "owner" && granter.userId !== state.ownerId)
      ) {
        throw new CryptoError("DECRYPT_FAILED", "Historical grant signer not authorized");
      }
    }
    if (!granter || granter.keyId !== grant.granterKeyId) {
      throw new CryptoError("DECRYPT_FAILED", "Grant signer unavailable");
    }
    if (!retired) {
      if (granter.userId === currentUserId() || granter.userId === state.ownerId) {
        await requireTrust(granter);
      } else {
        const entry = state.verifiedRoster.members.find(
          (member) =>
            member.userId === granter.userId &&
            member.keyId === granter.keyId &&
            member.fingerprint === granter.fingerprint,
        );
        if (!entry || purpose === "owner") {
          throw new CryptoError("DECRYPT_FAILED", "Grant signer not authorized by roster");
        }
        if ((await trust.check(granter.userId, granter)) === "changed") {
          await requestIdentityTrust(granter, "changed");
        }
      }
    }
    const publicKey = bytes(purpose === "member" ? row.memberPublicKey : row.ownerPublicKey);
    const seed = await openWorkspaceGrant({
      workspaceId,
      ...grant,
      sealed: bytes(grant.sealed),
      signature: bytes(grant.signature),
      granter,
      recipientSeed: own.encryption.seed,
      epochPublicKey: publicKey,
      rosterKeyHash: purpose === "member" ? rosterEpoch.memberKeyHash : rosterEpoch.ownerKeyHash,
    });
    if (keyManager.getSnapshot().state !== "unlocked" || secretGeneration() !== generation) {
      seed.fill(0);
      throw new KeysLockedError();
    }
    const result = {
      epoch,
      keyId: purpose === "member" ? row.memberKeyId : row.ownerKeyId,
      publicKey,
      seed,
    };
    ring.set(cacheKey(workspaceId, epoch, purpose), result);
    return result;
  });
}
/** Opens a member grant with signature, signed-roster and derived-public-key checks. Memory only. */
export function getMemberKey(workspaceId: Id<"workspaces">, epoch: number): Promise<WorkspaceKey> {
  return getWorkspaceKey(workspaceId, epoch, "member");
}
/** Returns the verified current member public key; locked mode reads only the verified device cache. */
export async function getCurrentMemberPublicKey(
  workspaceId: Id<"workspaces">,
): Promise<{ epoch: number; keyId: string; publicKey: Uint8Array } | null> {
  if (keyManager.getSnapshot().state !== "unlocked") return cachedWorkspacePublicKey(workspaceId);
  const raw = await cryptoClient().query(api.e2ee.workspaceKeyState, { workspace: workspaceId });
  if (!raw.keyEpoch) return null;
  const state = await verifyWorkspaceState(workspaceId);
  const row = state.epochs.find((epoch) => epoch.epoch === state.keyEpoch)!;
  return { epoch: row.epoch, keyId: row.memberKeyId, publicKey: bytes(row.memberPublicKey) };
}
async function ownIdentity(): Promise<PublicIdentity> {
  const own = (await fetchIdentities([currentUserId()])).get(currentUserId());
  if (!own) throw new CryptoError("DECRYPT_FAILED", "Active identity missing");
  await requireTrust(own);
  return own;
}
async function makeGrant(
  workspaceId: Id<"workspaces">,
  epoch: number,
  purpose: "member" | "owner",
  seed: Uint8Array,
  recipient: PublicIdentity,
) {
  return keyManager.useAmk(async (_, identity) => {
    const sealed = await sealBox({
      recipientPublicKey: recipient.encryptionPublicKey,
      plaintext: seed,
      aad: {
        table: "e2ee_workspace_grants",
        workspace: workspaceId,
        parent: recipient.userId,
        record: `${epoch}:${purpose}`,
        field: recipient.keyId,
      },
      pad: "none",
    });
    return {
      epoch,
      purpose,
      userId: recipient.userId,
      recipientKeyId: recipient.keyId,
      granterKeyId: toBase64Url(identity.keyId),
      sealed: buffer(sealed),
      signature: buffer(
        await sign(
          identity.signing.seed,
          grantStatement({
            workspaceId,
            epoch,
            purpose,
            recipientUserId: recipient.userId,
            recipientKeyId: recipient.keyId,
            sealed,
          }),
        ),
      ),
    };
  });
}
function memberBinding(identity: PublicIdentity): RosterMember {
  return { userId: identity.userId, keyId: identity.keyId, fingerprint: identity.fingerprint };
}
async function wireRoster(roster: WorkspaceRoster) {
  return keyManager.useAmk(async (_, identity) => {
    const signed = await signRoster(roster, identity.signing.seed);
    return { ...signed, body: buffer(signed.body), signature: buffer(signed.signature) };
  });
}
async function createEpoch(
  workspaceId: Id<"workspaces">,
  epoch: number,
  previous?: VerifiedState,
  excludedUserId?: string,
) {
  const generation = secretGeneration();
  const own = await ownIdentity();
  const member = await generateEncryptionKeyPair();
  const owner = await generateEncryptionKeyPair();
  try {
    const wire = {
      epoch,
      suite: member.suite,
      memberKeyId: newKeyId(),
      memberPublicKey: buffer(member.publicKey),
      ownerKeyId: newKeyId(),
      ownerPublicKey: buffer(owner.publicKey),
    };
    const grants = [
      await makeGrant(workspaceId, epoch, "member", member.seed, own),
      await makeGrant(workspaceId, epoch, "owner", owner.seed, own),
    ];
    const members: RosterMember[] = [];
    if (previous)
      for (const entry of previous.members) {
        if (entry.userId === own.userId || entry.userId === excludedUserId) continue;
        const identity = previous.identities.get(entry.userId);
        if (!identity) continue;
        const pin = await trust.check(identity.userId, identity);
        if (pin === "changed") {
          await requestIdentityTrust(identity, "changed");
        }
        if (pin === "first-contact") {
          await requestIdentityTrust(identity, "first-contact");
        }
        members.push(memberBinding(identity));
        grants.push(await makeGrant(workspaceId, epoch, "member", member.seed, identity));
      }
    const roster = await wireRoster({
      v: 1,
      workspace: workspaceId,
      version: (previous?.verifiedRoster.version ?? 0) + 1,
      epoch,
      owner: memberBinding(own),
      epochs: [
        ...(previous?.verifiedRoster.epochs ?? []),
        {
          epoch,
          memberKeyId: wire.memberKeyId,
          memberKeyHash: toBase64Url(await sha256(member.publicKey)),
          ownerKeyId: wire.ownerKeyId,
          ownerKeyHash: toBase64Url(await sha256(owner.publicKey)),
        },
      ],
      members,
    });
    if (secretGeneration() !== generation) {
      throw new KeysLockedError();
    }
    return { epoch: wire, grants, roster };
  } finally {
    member.seed.fill(0);
    owner.seed.fill(0);
  }
}
/** Atomically bootstraps a keyless owned workspace; a closed browser is repaired on next unlock. */
export async function bootstrapWorkspace(workspaceId: Id<"workspaces">): Promise<void> {
  const state = await cryptoClient().query(api.e2ee.workspaceKeyState, { workspace: workspaceId });
  if (state.keyEpoch || state.role !== "owner") return;
  const keys = await createEpoch(workspaceId, 1);
  await cryptoClient().mutation(api.e2ee.bootstrapWorkspaceKeys, {
    workspace: workspaceId,
    ...keys,
  });
}
/** Creates a workspace then bootstraps keys as soon as its Convex ID is available. */
export async function createKeyedWorkspace(name: string): Promise<Id<"workspaces">> {
  if (keyManager.getSnapshot().state === "locked") {
    throw new KeysLockedError();
  }
  const workspace = await cryptoClient().mutation(api.workspaces.create, { name });
  if (keyManager.getSnapshot().state === "unlocked") await bootstrapWorkspace(workspace);
  return workspace;
}
/** Removes a member and rotates both workspace keys, grants and roster in one backend mutation. */
export async function removeMemberWithRotation(
  workspaceId: Id<"workspaces">,
  email: string,
  userId: string,
): Promise<void> {
  const raw = await cryptoClient().query(api.e2ee.workspaceKeyState, { workspace: workspaceId });
  const rotation = raw.keyEpoch
    ? await createEpoch(
        workspaceId,
        raw.keyEpoch + 1,
        await verifyWorkspaceState(workspaceId),
        userId,
      )
    : undefined;
  await cryptoClient().mutation(api.workspaces.removeMember, {
    workspace: workspaceId,
    email,
    rotation,
  });
}
/** Starts a new workspace epoch after loss of the sole owner's historical owner key. */
export async function rotateWorkspace(workspaceId: Id<"workspaces">): Promise<void> {
  const state = await verifyWorkspaceState(workspaceId);
  await cryptoClient().mutation(api.e2ee.rotateWorkspaceEpoch, {
    workspace: workspaceId,
    ...(await createEpoch(workspaceId, state.keyEpoch! + 1, state)),
  });
}
async function accessPayload(
  workspaceId: Id<"workspaces">,
): Promise<{ payload: InvitePayload; owner: WorkspaceKey }> {
  const state = await verifyWorkspaceState(workspaceId);
  const member = await getMemberKey(workspaceId, state.keyEpoch!);
  return {
    payload: {
      v: 1,
      workspace: workspaceId,
      epoch: member.epoch,
      memberSeed: toBase64Url(member.seed),
      owner: state.verifiedRoster.owner,
    },
    owner: await getWorkspaceKey(workspaceId, member.epoch, "owner"),
  };
}
/** Creates a one-use seven-day access link. The returned secret URL must stay outside React state. */
export async function createAccessLink(
  workspaceId: Id<"workspaces">,
  invitedUserId: string,
): Promise<string> {
  const { payload, owner } = await accessPayload(workspaceId);
  const inviteId = newKeyId();
  const secret = randomBytes(32);
  try {
    const sealed = await sealInvitePayload({ secret, id: inviteId, payload, invitedUserId });
    const ownerSecret = await sealBox({
      recipientPublicKey: owner.publicKey,
      plaintext: secret,
      aad: {
        table: "e2ee_invites",
        workspace: workspaceId,
        parent: "owner",
        record: inviteId,
        field: "secret",
      },
      pad: "none",
    });
    await cryptoClient().mutation(api.e2ee.createInvite, {
      workspace: workspaceId,
      inviteId,
      invitedUserId,
      epoch: payload.epoch,
      sealed: buffer(sealed),
      ownerSecret: buffer(ownerSecret),
    });
    return `${window.location.origin}/join/${inviteId}#${toBase64Url(secret)}`;
  } finally {
    secret.fill(0);
  }
}
/** Enables a generated 12-word phrase. Caller displays the words once, outside React state. */
export async function enableWorkspacePhrase(workspaceId: Id<"workspaces">): Promise<string[]> {
  const { payload, owner } = await accessPayload(workspaceId);
  const phraseId = newKeyId();
  const phrase = generateShortSecret();
  try {
    const wrapper = await sealInvitePayload({
      secret: phrase.entropy,
      id: phraseId,
      payload,
      invitedUserId: "",
      phrase: true,
    });
    const ownerSecret = await sealBox({
      recipientPublicKey: owner.publicKey,
      plaintext: phrase.entropy,
      aad: {
        table: "e2ee_phrases",
        workspace: workspaceId,
        parent: "owner",
        record: phraseId,
        field: "secret",
      },
      pad: "none",
    });
    await cryptoClient().mutation(api.e2ee.setPhrase, {
      workspace: workspaceId,
      epoch: payload.epoch,
      phraseId,
      wrapper: buffer(wrapper),
      ownerSecret: buffer(ownerSecret),
    });
    return phrase.words;
  } finally {
    phrase.entropy.fill(0);
  }
}
async function acceptPayload(
  workspaceId: Id<"workspaces">,
  payload: InvitePayload,
  secret: Uint8Array,
  phrase: boolean,
  inviteId?: string,
) {
  // The payload is authenticated by the link secret or phrase, which the backend never sees, so
  // the owner identity it names is bound by that secret: pin it as verified before the roster check.
  const ownerIdentity = (await fetchIdentities([payload.owner.userId])).get(payload.owner.userId);
  if (
    !ownerIdentity ||
    ownerIdentity.keyId !== payload.owner.keyId ||
    ownerIdentity.fingerprint !== payload.owner.fingerprint
  ) {
    throw new CryptoError("DECRYPT_FAILED", "Access owner differs from the link");
  }
  if ((await trust.check(ownerIdentity.userId, ownerIdentity)) !== "verified") {
    await trust.pin(ownerIdentity.userId, ownerIdentity, "verified");
  }
  const state = await verifyWorkspaceState(workspaceId);
  const owner = state.verifiedRoster.owner;
  if (JSON.stringify(payload.owner) !== JSON.stringify(owner) || payload.epoch !== state.keyEpoch)
    throw new CryptoError("DECRYPT_FAILED", "Access owner or epoch mismatch");
  const seed = fromBase64Url(payload.memberSeed);
  try {
    const epoch = state.epochs.find((row) => row.epoch === payload.epoch);
    if (
      !epoch ||
      !equalBytes(await encryptionPublicKeyFromSeed(seed), bytes(epoch.memberPublicKey))
    )
      throw new CryptoError("DECRYPT_FAILED", "Access seed differs from roster");
    const own = await ownIdentity();
    const selfGrant = await makeGrant(workspaceId, payload.epoch, "member", seed, own);
    const mac = buffer(await joinMac({ secret, workspaceId, identity: own, phrase }));
    if (phrase)
      await cryptoClient().mutation(api.e2ee.acceptPhrase, {
        workspace: workspaceId,
        keyId: own.keyId,
        mac,
        selfGrant,
      });
    else
      await cryptoClient().mutation(api.e2ee.acceptInvite, {
        inviteId: inviteId!,
        keyId: own.keyId,
        mac,
        selfGrant,
      });
  } finally {
    seed.fill(0);
  }
}
/** Accepts an access link whose fragment has already been removed from the address bar. */
export async function acceptAccessLink(inviteId: string, secret: Uint8Array): Promise<void> {
  if (secret.length !== 32 || fromBase64Url(inviteId).length !== 16)
    throw new CryptoError("BAD_INPUT", "Invalid access link");
  const row = await cryptoClient().query(api.e2ee.getInvite, { inviteId });
  if (!row) throw new CryptoError("BAD_INPUT", "Access link expired or unavailable");
  const payload = await openInvitePayload({
    secret,
    id: inviteId,
    workspaceId: row.workspace,
    epoch: row.epoch,
    invitedUserId: currentUserId(),
    sealed: bytes(row.sealed),
  });
  await acceptPayload(row.workspace, payload, secret, false, inviteId);
}
/** Opens a phrase locally and self-grants the authenticated current member seed. */
export async function acceptWorkspacePhrase(
  workspaceId: Id<"workspaces">,
  words: string,
): Promise<void> {
  const secret = phraseToEntropy(words, 12);
  try {
    const state = await cryptoClient().query(api.e2ee.workspaceKeyState, {
      workspace: workspaceId,
    });
    if (!state.phrase) throw new CryptoError("BAD_INPUT", "No current workspace phrase");
    const payload = await openInvitePayload({
      secret,
      id: state.phrase.phraseId,
      workspaceId,
      epoch: state.phrase.epoch,
      invitedUserId: "",
      sealed: bytes(state.phrase.wrapper),
      phrase: true,
    });
    await acceptPayload(workspaceId, payload, secret, true);
  } finally {
    secret.fill(0);
  }
}
/** Approves a request after the UI records an explicit trust pin; grants all held member epochs. */
export async function approveKeyRequest(
  workspaceId: Id<"workspaces">,
  requestId: Id<"e2ee_join_requests">,
): Promise<void> {
  const state = await verifyWorkspaceState(workspaceId);
  const request = state.joinRequests.find((row) => row._id === requestId);
  if (!request) return;
  const recipient = state.identities.get(request.userId);
  if (!recipient || recipient.keyId !== request.keyId)
    throw new CryptoError("DECRYPT_FAILED", "Request identity changed");
  await requireTrust(recipient);
  const grants = [];
  for (const epoch of state.epochs) {
    const held = state.myGrants.some(
      (grant) => grant.epoch === epoch.epoch && grant.purpose === "member",
    );
    if (!held) continue;
    const key = await getMemberKey(workspaceId, epoch.epoch);
    grants.push(await makeGrant(workspaceId, epoch.epoch, "member", key.seed, recipient));
  }
  if (state.role === "owner") {
    const members = state.verifiedRoster.members.filter(
      (entry) => entry.userId !== recipient.userId,
    );
    members.push(memberBinding(recipient));
    await cryptoClient().mutation(api.e2ee.publishRoster, {
      workspace: workspaceId,
      roster: await wireRoster({
        ...state.verifiedRoster,
        version: state.verifiedRoster.version + 1,
        members,
      }),
    });
  } else if (!state.verifiedRoster.members.some((entry) => entry.userId === recipient.userId))
    throw new CryptoError("DECRYPT_FAILED", "Recipient absent from roster");
  await cryptoClient().mutation(api.e2ee.addGrants, { workspace: workspaceId, grants });
}
/** Processes MAC-proven joins, requests missing keys and rewraps stale historical workspace wraps. */
export async function syncWorkspaceKeys(workspaceId: Id<"workspaces">): Promise<void> {
  const raw = await cryptoClient().query(api.e2ee.workspaceKeyState, { workspace: workspaceId });
  if (!raw.keyEpoch) {
    if (raw.role === "owner") await bootstrapWorkspace(workspaceId);
    return;
  }
  const state = await verifyWorkspaceState(workspaceId);
  const own = await ownIdentity();
  const pending = state.joinRequests.some(
    (request) => request.userId === own.userId && request.keyId === own.keyId,
  );
  if (
    !pending &&
    !state.myGrants.some(
      (grant) =>
        grant.epoch === state.keyEpoch &&
        grant.purpose === "member" &&
        grant.recipientKeyId === own.keyId &&
        grant.granterUserId !== own.userId,
    )
  ) {
    if (
      state.role !== "owner" ||
      !state.myGrants.some(
        (grant) => grant.epoch === state.keyEpoch && grant.recipientKeyId === own.keyId,
      )
    )
      await cryptoClient().mutation(api.e2ee.requestKeys, {
        workspace: workspaceId,
        keyId: own.keyId,
      });
  }
  for (const request of state.joinRequests) {
    if (request.source === "request") {
      const identity = state.identities.get(request.userId);
      if (
        state.role !== "owner" &&
        identity &&
        request.keyId === identity.keyId &&
        ["tofu", "verified"].includes(await trust.check(identity.userId, identity))
      )
        await approveKeyRequest(workspaceId, request._id);
      continue;
    }
    if (
      state.role !== "owner" ||
      !request.mac ||
      !request.ownerSecret ||
      !request.epoch ||
      !request.sourceId
    )
      continue;
    const identity = state.identities.get(request.userId);
    if (!identity || identity.keyId !== request.keyId)
      throw new CryptoError("DECRYPT_FAILED", "Join identity changed");
    const ownerKey = await getWorkspaceKey(workspaceId, request.epoch, "owner");
    const secret = await openBox({
      seed: ownerKey.seed,
      box: bytes(request.ownerSecret),
      aad: {
        table: request.source === "phrase" ? "e2ee_phrases" : "e2ee_invites",
        workspace: workspaceId,
        parent: "owner",
        record: request.sourceId,
        field: "secret",
      },
      pad: "none",
    });
    try {
      if (
        !equalBytes(
          await joinMac({ secret, workspaceId, identity, phrase: request.source === "phrase" }),
          bytes(request.mac),
        )
      )
        throw new CryptoError("DECRYPT_FAILED", "Join proof failed");
      // A proven external secret may explicitly replace a changed pin, but never bypass rollback.
      await trust.pin(identity.userId, identity, "verified");
      await approveKeyRequest(workspaceId, request._id);
    } finally {
      secret.fill(0);
    }
  }
  if (state.role === "owner") await rewrapWorkspaceChats(workspaceId);
}
async function rewrapWorkspaceChats(workspaceId: Id<"workspaces">) {
  const current = await getCurrentMemberPublicKey(workspaceId);
  if (!current) return;
  let cursor: string | null = null;
  let done = false;
  while (!done) {
    const page: { page: Doc<"e2ee_chat_key_wraps">[]; isDone: boolean; continueCursor: string } =
      await cryptoClient().query(api.e2ee.staleWorkspaceWraps, {
        workspace: workspaceId,
        paginationOpts: { cursor, numItems: 50 },
      });
    const replacements = [];
    for (const wrap of page.page) {
      if (wrap.recipient !== "workspace" || wrap.workspaceEpoch === undefined)
        throw new CryptoError("BAD_ENVELOPE", "Invalid workspace wrap");
      const chat = await cryptoClient().query(api.e2ee.chatKeys, { chatId: wrap.chat });
      if (!chat.e2eeId) throw new CryptoError("BAD_ENVELOPE", "Missing chat identity");
      const old = await getMemberKey(workspaceId, wrap.workspaceEpoch);
      const aad = {
        table: "e2ee_chat_key_wraps",
        workspace: workspaceId,
        parent: chat.e2eeId,
        record: String(wrap.chatEpoch),
        field: wrap.recipientKeyId,
      };
      const seed = await openBox({ seed: old.seed, box: bytes(wrap.sealed), aad, pad: "none" });
      try {
        const row = chat.epochs.find((epoch) => epoch.epoch === wrap.chatEpoch);
        if (!row || !equalBytes(await encryptionPublicKeyFromSeed(seed), bytes(row.publicKey)))
          throw new CryptoError("DECRYPT_FAILED", "Stale chat wrap mismatch");
        const sealed = await sealBox({
          recipientPublicKey: current.publicKey,
          plaintext: seed,
          aad: { ...aad, field: current.keyId },
          pad: "none",
        });
        replacements.push({
          oldWrap: wrap._id,
          wrap: {
            chatEpoch: wrap.chatEpoch,
            recipient: "workspace" as const,
            workspaceEpoch: current.epoch,
            recipientKeyId: current.keyId,
            sealed: buffer(sealed),
          },
        });
      } finally {
        seed.fill(0);
      }
    }
    if (replacements.length)
      await cryptoClient().mutation(api.e2ee.replaceWorkspaceWraps, {
        workspace: workspaceId,
        replacements,
      });
    cursor = page.continueCursor;
    done = page.isDone;
  }
}
