import type { Id } from "backend/convex/_generated/dataModel";
import { trpcClient } from "@/lib/trpc-client";
import { setEncryptedName } from "./names";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "server/router";
import {
  CryptoError,
  EMPTY_ROSTER_ARCHIVE,
  encryptionPublicKeyFromSeed,
  equalBytes,
  fromBase64Url,
  generateEncryptionKeyPair,
  generateShortSecret,
  grantStatement,
  openBox,
  phraseToEntropy,
  randomBytes,
  ROSTER_EPOCH_WINDOW,
  sealBox,
  sha256,
  sign,
  signRoster,
  toBase64Url,
  verifyArchivedEpochs,
  verifyRoster,
  type RosterEpoch,
  type RosterMember,
  type RosterWorker,
  type WorkspaceRoster,
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
  type InvitePayload,
} from "./workspace-proofs";

type E2eeOutputs = inferRouterOutputs<AppRouter>["e2ee"];
type KeyState = E2eeOutputs["workspaceKeyState"];
type StaleWrapsPage = E2eeOutputs["staleWorkspaceWraps"];
type EpochRow = KeyState["epochs"][number];
type GrantRow = KeyState["myGrants"][number];
type VerifiedState = KeyState & {
  identities: Map<string, PublicIdentity>;
  verifiedRoster: WorkspaceRoster;
};
/**
 * Verified epochs older than the roster window, `from` up to the window, with this account's grants
 * of them. `key` names the roster they were verified against (version and archive commitment).
 */
type ArchivedEpochs = {
  key: string;
  from: number;
  entries: RosterEpoch[];
  rows: Map<number, { row: EpochRow; rosterEpoch: RosterEpoch }>;
  grants: GrantRow[];
};
type WorkspaceKey = { epoch: number; keyId: string; publicKey: Uint8Array; seed: Uint8Array };
const ring = new Map<string, WorkspaceKey>();
const verifiedStates = new Map<string, { key: string; promise: Promise<VerifiedState> }>();
const stateLoads = new Map<string, Promise<VerifiedState>>();
const archives = new Map<string, ArchivedEpochs>();
/** Server bound on epochs per `workspaceArchivedEpochs` call. */
const ARCHIVED_EPOCH_PAGE = 64;
const cacheKey = (workspaceId: string, epoch: number, purpose: string) =>
  `${workspaceId}:${epoch}:${purpose}`;
onSecretsCleared(() => {
  for (const key of ring.values()) key.seed.fill(0);
  ring.clear();
  verifiedStates.clear();
  stateLoads.clear();
  archives.clear();
});
trust.subscribe(() => {
  verifiedStates.clear();
  stateLoads.clear();
  archives.clear();
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
/** Device marker holding the newest roster version this device verified for a workspace. */
const rosterMarker = (workspaceId: string) => `radium.e2ee.roster.v1:${workspaceId}`;
/**
 * Whether this device has verified an owner-signed roster for the workspace. Workspace keys are never
 * removed, so such a workspace stays keyed whatever the server later reports.
 */
export function workspaceKnownKeyed(workspaceId: string): boolean {
  return highWater(rosterMarker(workspaceId)) > 0;
}
/** The server reported a workspace keyless that this device verified as keyed. */
export class KeylessDowngradeError extends Error {
  constructor() {
    super(
      "The server reports this workspace as unencrypted, but this device verified its encryption keys. Nothing was sent.",
    );
    this.name = "KeylessDowngradeError";
  }
}
/**
 * Resolves the server's keyed/keyless claim for a plaintext decision: `serverKeyed`, unless the
 * server claims keyless for a workspace this device knows is keyed, which throws
 * `KeylessDowngradeError` so the caller sends nothing in plaintext.
 */
export function keyedWorkspaceClaim(workspaceId: string, serverKeyed: boolean): boolean {
  if (!serverKeyed && workspaceKnownKeyed(workspaceId)) throw new KeylessDowngradeError();
  return serverKeyed;
}
/** Loads the current roster, requiring an explicitly pinned owner and checking every epoch hash. */
export function verifyWorkspaceState(workspaceId: string): Promise<VerifiedState> {
  const pending = stateLoads.get(workspaceId);
  if (pending) return pending;
  const load = (async () => {
    const state = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
    // Include ciphertext and public byte fields: equal version numbers alone cannot authenticate
    // a substituted roster/epoch. Repeated callers share verification, never bypass freshness.
    const key = JSON.stringify(state);
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

async function verifyState(workspaceId: string, state: KeyState): Promise<VerifiedState> {
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
  const marker = rosterMarker(workspaceId);
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
      body: fromBase64Url(roster.body),
      signature: fromBase64Url(roster.signature),
      owner: historical,
      highWater: highWater(marker),
    });
    const resigned = await wireRoster({
      ...previous,
      version: previous.version + 1,
      owner: memberBinding(owner),
    });
    await trpcClient().e2ee.publishRoster.mutate({
      workspace: workspaceId,
      roster: resigned,
    });
    roster = { ...roster, ...resigned };
  }
  const verifiedRoster = await verifyRoster({
    workspaceId,
    version: roster.version,
    signerKeyId: roster.signerKeyId,
    body: fromBase64Url(roster.body),
    signature: fromBase64Url(roster.signature),
    owner,
    highWater: highWater(marker),
  });
  // The server serves only the roster window (the newest `ROSTER_EPOCH_WINDOW` epochs). Version 3
  // rosters list exactly that window; version 1/2 rosters list every epoch, of which the same newest
  // ones must match. Older epochs are verified on demand (`archivedEpochs`).
  const window = verifiedRoster.epochs.filter(
    (entry) => entry.epoch > verifiedRoster.epoch - ROSTER_EPOCH_WINDOW,
  );
  if (verifiedRoster.epoch !== state.keyEpoch || state.epochs.length !== window.length)
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch rollback or substitution");
  for (const epoch of state.epochs) {
    const entry = window.find((row) => row.epoch === epoch.epoch);
    if (!entry || !sameRosterEpoch(entry, await rosterEpochOf(epoch)))
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
    publicKey: fromBase64Url(latest.memberPublicKey),
  });
  return { ...state, identities, verifiedRoster };
}
/** Roster commitment of a served epoch row: its key IDs and SHA-256 of each public key. */
async function rosterEpochOf(row: EpochRow): Promise<RosterEpoch> {
  return {
    epoch: row.epoch,
    memberKeyId: row.memberKeyId,
    memberKeyHash: toBase64Url(await sha256(fromBase64Url(row.memberPublicKey))),
    ownerKeyId: row.ownerKeyId,
    ownerKeyHash: toBase64Url(await sha256(fromBase64Url(row.ownerPublicKey))),
  };
}
function sameRosterEpoch(a: RosterEpoch, b: RosterEpoch): boolean {
  return (
    a.epoch === b.epoch &&
    a.memberKeyId === b.memberKeyId &&
    a.memberKeyHash === b.memberKeyHash &&
    a.ownerKeyId === b.ownerKeyId &&
    a.ownerKeyHash === b.ownerKeyHash
  );
}
/**
 * Verified epochs `from` up to the start of the roster window, read in pages from
 * `workspaceArchivedEpochs`. Version 3: the rows must reproduce the signed `archive` hash chain from
 * the server's claimed prefix (or from epoch 1 when it has none). Version 1/2: the roster lists every
 * epoch itself. Results are cached per workspace and roster, and extended to older epochs on demand.
 */
async function archivedEpochs(
  workspaceId: string,
  state: VerifiedState,
  from: number,
): Promise<ArchivedEpochs> {
  const roster = state.verifiedRoster;
  const windowStart = state.epochs[0]?.epoch ?? 1;
  if (!Number.isSafeInteger(from) || from < 1 || from >= windowStart)
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  const key = `${roster.version}:${roster.archive.hash}`;
  const cached = archives.get(workspaceId);
  const known = cached?.key === key ? cached : undefined;
  if (known && known.from <= from) return known;
  const end = known ? known.from - 1 : windowStart - 1;

  const fetchPage = (start: number) =>
    trpcClient().e2ee.workspaceArchivedEpochs.query({
      workspace: workspaceId,
      fromEpoch: start,
      toEpoch: Math.min(start + ARCHIVED_EPOCH_PAGE - 1, end),
    });
  let start = from;
  let page = await fetchPage(start);
  // Without a stored chain value before `from`, verify from epoch 1, whose prefix is fixed.
  if (roster.v === 3 && start > 1 && page.prefixHash === null) {
    start = 1;
    page = await fetchPage(start);
  }
  const prefixHash = page.prefixHash;
  const rows: EpochRow[] = [...page.epochs];
  const grants: GrantRow[] = [...page.myGrants];
  for (let next = start + ARCHIVED_EPOCH_PAGE; next <= end; next += ARCHIVED_EPOCH_PAGE) {
    const more = await fetchPage(next);
    rows.push(...more.epochs);
    grants.push(...more.myGrants);
  }

  const fetched = await Promise.all(rows.map(rosterEpochOf));
  const entries = [...fetched, ...(known?.entries ?? [])];
  if (roster.v === 3) {
    let claimedPrefixHash: Uint8Array = new Uint8Array(32);
    if (start > 1) {
      if (prefixHash === null)
        throw new CryptoError("DECRYPT_FAILED", "Archived roster epochs differ from roster");
      claimedPrefixHash = fromBase64Url(prefixHash);
    }
    await verifyArchivedEpochs({ archive: roster.archive, claimedPrefixHash, entries });
  } else {
    for (const entry of fetched) {
      const listed = roster.epochs.find((row) => row.epoch === entry.epoch);
      if (!listed || !sameRosterEpoch(listed, entry))
        throw new CryptoError("DECRYPT_FAILED", "Workspace epoch differs from signed roster");
    }
    if (fetched.length !== end - start + 1)
      throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  }

  const verified: ArchivedEpochs = {
    key,
    from: start,
    entries,
    rows: new Map(known?.rows),
    grants: [...grants, ...(known?.grants ?? [])],
  };
  rows.forEach((row, index) => verified.rows.set(row.epoch, { row, rosterEpoch: fetched[index]! }));
  archives.set(workspaceId, verified);
  return verified;
}
/** The verified public row, roster commitment and this account's grants of one epoch. */
async function epochRecord(
  workspaceId: string,
  state: VerifiedState,
  epoch: number,
): Promise<{ row: EpochRow; rosterEpoch: RosterEpoch; grants: GrantRow[] }> {
  const row = state.epochs.find((entry) => entry.epoch === epoch);
  if (row) {
    const rosterEpoch = state.verifiedRoster.epochs.find((entry) => entry.epoch === epoch);
    if (!rosterEpoch) throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
    return { row, rosterEpoch, grants: state.myGrants };
  }
  const archived = await archivedEpochs(workspaceId, state, epoch);
  const record = archived.rows.get(epoch);
  if (!record) throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  return { ...record, grants: archived.grants };
}
/** Checks an identity pin, plus owner endorsement when the identity is not the chat creator. */
export async function trustedIdentity(
  workspaceId: string,
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
  workspaceId: string,
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
  const { row, rosterEpoch, grants } = await epochRecord(workspaceId, state, epoch);
  return keyManager.useAmk(async (_, own) => {
    const recipientKeyId = toBase64Url(own.keyId);
    const grant = grants.find(
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
    const publicKey = fromBase64Url(purpose === "member" ? row.memberPublicKey : row.ownerPublicKey);
    const seed = await openWorkspaceGrant({
      workspaceId,
      ...grant,
      sealed: fromBase64Url(grant.sealed),
      signature: fromBase64Url(grant.signature),
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
export function getMemberKey(workspaceId: string, epoch: number): Promise<WorkspaceKey> {
  return getWorkspaceKey(workspaceId, epoch, "member");
}
/**
 * Opens the workspace owner key of `epoch` (current epoch by default). Owner-only: members hold no
 * owner grant. Same checks and memory-only cache as `getMemberKey`.
 */
export async function getOwnerKey(
  workspaceId: string,
  epoch?: number,
): Promise<WorkspaceKey> {
  const state = await verifyWorkspaceState(workspaceId);
  if (state.role !== "owner" || !state.keyEpoch) {
    throw new CryptoError("DECRYPT_FAILED", "Workspace owner key not granted");
  }
  return getWorkspaceKey(workspaceId, epoch ?? state.keyEpoch, "owner");
}
/**
 * Owner-only: publishes the next roster version with `workers` as the certified Workers, keeping
 * epochs and members. The caller must have verified every listed Worker's pairing. No-op when the
 * verified roster already lists exactly these Workers. Resolves whether a roster was published.
 */
export async function publishRosterWorkers(
  workspaceId: string,
  workers: RosterWorker[],
): Promise<boolean> {
  const state = await verifyWorkspaceState(workspaceId);
  if (state.role !== "owner") throw new CryptoError("DECRYPT_FAILED", "Only owners sign rosters");
  const key = (list: RosterWorker[]) =>
    JSON.stringify(
      list
        .map((worker) => [worker.workerId, worker.keyId, worker.fingerprint])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
  if (key(state.verifiedRoster.workers) === key(workers)) return false;
  await trpcClient().e2ee.publishRoster.mutate({
    workspace: workspaceId,
    roster: await wireRoster({
      ...state.verifiedRoster,
      version: state.verifiedRoster.version + 1,
      workers,
    }),
  });
  return true;
}
/** Returns the verified current member public key; locked mode reads only the verified device cache. */
export async function getCurrentMemberPublicKey(
  workspaceId: string,
): Promise<{ epoch: number; keyId: string; publicKey: Uint8Array } | null> {
  if (keyManager.getSnapshot().state !== "unlocked") return cachedWorkspacePublicKey(workspaceId);
  const raw = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
  if (!raw.keyEpoch) return null;
  const state = await verifyWorkspaceState(workspaceId);
  const row = state.epochs.find((epoch) => epoch.epoch === state.keyEpoch)!;
  return { epoch: row.epoch, keyId: row.memberKeyId, publicKey: fromBase64Url(row.memberPublicKey) };
}
async function ownIdentity(): Promise<PublicIdentity> {
  const own = (await fetchIdentities([currentUserId()])).get(currentUserId());
  if (!own) throw new CryptoError("DECRYPT_FAILED", "Active identity missing");
  await requireTrust(own);
  return own;
}
async function makeGrant(
  workspaceId: string,
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
      sealed: toBase64Url(sealed),
      signature: toBase64Url(
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
async function wireRoster(roster: Omit<WorkspaceRoster, "v">) {
  let workers = roster.workers;
  if (workers.length) {
    // Never re-list a Worker whose key set is gone (revoked) or replaced; the backend refuses it.
    // Server rows can only shrink this list, never add to it.
    const rows = await trpcClient().e2ee.workerKeys.query({
      workspace: roster.workspace,
    });
    workers = workers.filter((worker) =>
      rows.some((row) => row.workerId === worker.workerId && row.keyId === worker.keyId),
    );
  }
  return keyManager.useAmk(async (_, identity) => {
    const signed = await signRoster({ ...roster, workers }, identity.signing.seed);
    return { ...signed, body: toBase64Url(signed.body), signature: toBase64Url(signed.signature) };
  });
}
async function createEpoch(
  workspaceId: string,
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
      memberPublicKey: toBase64Url(member.publicKey),
      ownerKeyId: newKeyId(),
      ownerPublicKey: toBase64Url(owner.publicKey),
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
      workers: previous?.verifiedRoster.workers ?? [],
      workspace: workspaceId,
      version: (previous?.verifiedRoster.version ?? 0) + 1,
      epoch,
      owner: memberBinding(own),
      // `signRoster` keeps the newest epochs and chains the one leaving the window into `archive`
      // (a version 1/2 roster's full list is converted on this signature).
      archive: previous?.verifiedRoster.archive ?? EMPTY_ROSTER_ARCHIVE,
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
export async function bootstrapWorkspace(workspaceId: string): Promise<void> {
  const state = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
  if (state.keyEpoch || state.role !== "owner") return;
  const keys = await createEpoch(workspaceId, 1);
  await trpcClient().e2ee.bootstrapWorkspaceKeys.mutate({
    workspace: workspaceId,
    ...keys,
  });
}
/** Creates a workspace then bootstraps keys as soon as its ID is available. */
export async function createKeyedWorkspace(name: string): Promise<Id<"workspaces">> {
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  const workspace = await trpcClient().workspaces.create.mutate();
  await bootstrapWorkspace(workspace);
  await setEncryptedName({ target: workspace, workspace, table: "workspaces", name });
  return workspace;
}
/**
 * Removes a member and rotates both workspace keys, grants and roster in one backend mutation.
 * The rotation is already in tRPC's wire form: every binary field is unpadded base64url text.
 */
export async function removeMemberWithRotation(
  workspaceId: string,
  email: string,
  userId: string,
): Promise<void> {
  const raw = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
  const keys = raw.keyEpoch
    ? await createEpoch(
        workspaceId,
        raw.keyEpoch + 1,
        await verifyWorkspaceState(workspaceId),
        userId,
      )
    : undefined;
  await trpcClient().workspaces.removeMember.mutate({
    workspace: workspaceId,
    email,
    rotation: keys && {
      epoch: keys.epoch,
      grants: keys.grants,
      roster: {
        version: keys.roster.version,
        signerKeyId: keys.roster.signerKeyId,
        body: keys.roster.body,
        signature: keys.roster.signature,
      },
    },
  });
}
/** Starts a new workspace epoch after loss of the sole owner's historical owner key. */
export async function rotateWorkspace(workspaceId: string): Promise<void> {
  const state = await verifyWorkspaceState(workspaceId);
  await trpcClient().e2ee.rotateWorkspaceEpoch.mutate({
    workspace: workspaceId,
    ...(await createEpoch(workspaceId, state.keyEpoch! + 1, state)),
  });
}
async function accessPayload(
  workspaceId: string,
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
  workspaceId: string,
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
    await trpcClient().e2ee.createInvite.mutate({
      workspace: workspaceId,
      inviteId,
      invitedUserId,
      epoch: payload.epoch,
      sealed: toBase64Url(sealed),
      ownerSecret: toBase64Url(ownerSecret),
    });
    return `${window.location.origin}/join/${inviteId}#${toBase64Url(secret)}`;
  } finally {
    secret.fill(0);
  }
}
/** Enables a generated 12-word phrase. Caller displays the words once, outside React state. */
export async function enableWorkspacePhrase(workspaceId: string): Promise<string[]> {
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
    await trpcClient().e2ee.setPhrase.mutate({
      workspace: workspaceId,
      epoch: payload.epoch,
      phraseId,
      wrapper: toBase64Url(wrapper),
      ownerSecret: toBase64Url(ownerSecret),
    });
    return phrase.words;
  } finally {
    phrase.entropy.fill(0);
  }
}
async function acceptPayload(
  workspaceId: string,
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
      !equalBytes(await encryptionPublicKeyFromSeed(seed), fromBase64Url(epoch.memberPublicKey))
    )
      throw new CryptoError("DECRYPT_FAILED", "Access seed differs from roster");
    const own = await ownIdentity();
    const selfGrant = await makeGrant(workspaceId, payload.epoch, "member", seed, own);
    const mac = toBase64Url(await joinMac({ secret, workspaceId, identity: own, phrase }));
    if (phrase)
      await trpcClient().e2ee.acceptPhrase.mutate({
        workspace: workspaceId,
        keyId: own.keyId,
        mac,
        selfGrant,
      });
    else
      await trpcClient().e2ee.acceptInvite.mutate({
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
  const row = await trpcClient().e2ee.getInvite.query({ inviteId });
  if (!row) throw new CryptoError("BAD_INPUT", "Access link expired or unavailable");
  const payload = await openInvitePayload({
    secret,
    id: inviteId,
    workspaceId: row.workspace,
    epoch: row.epoch,
    invitedUserId: currentUserId(),
    sealed: fromBase64Url(row.sealed),
  });
  await acceptPayload(row.workspace, payload, secret, false, inviteId);
}
/** Opens a phrase locally and self-grants the authenticated current member seed. */
export async function acceptWorkspacePhrase(
  workspaceId: string,
  words: string,
): Promise<void> {
  const secret = phraseToEntropy(words, 12);
  try {
    const state = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
    if (!state.phrase) throw new CryptoError("BAD_INPUT", "No current workspace phrase");
    const payload = await openInvitePayload({
      secret,
      id: state.phrase.phraseId,
      workspaceId,
      epoch: state.phrase.epoch,
      invitedUserId: "",
      sealed: fromBase64Url(state.phrase.wrapper),
      phrase: true,
    });
    await acceptPayload(workspaceId, payload, secret, true);
  } finally {
    secret.fill(0);
  }
}
/** Approves a request after the UI records an explicit trust pin; grants all held member epochs. */
export async function approveKeyRequest(
  workspaceId: string,
  requestId: string,
): Promise<void> {
  const state = await verifyWorkspaceState(workspaceId);
  const request = state.joinRequests.find((row) => row.id === requestId);
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
  // Epochs older than the roster window: the recipient gets every member key this account holds.
  if ((state.epochs[0]?.epoch ?? 1) > 1) {
    const archived = await archivedEpochs(workspaceId, state, 1);
    for (const epoch of archived.rows.keys()) {
      const held = archived.grants.some(
        (grant) => grant.epoch === epoch && grant.purpose === "member",
      );
      if (!held) continue;
      const key = await getMemberKey(workspaceId, epoch);
      grants.push(await makeGrant(workspaceId, epoch, "member", key.seed, recipient));
    }
  }
  if (state.role === "owner") {
    const members = state.verifiedRoster.members.filter(
      (entry) => entry.userId !== recipient.userId,
    );
    members.push(memberBinding(recipient));
    await trpcClient().e2ee.publishRoster.mutate({
      workspace: workspaceId,
      roster: await wireRoster({
        ...state.verifiedRoster,
        version: state.verifiedRoster.version + 1,
        members,
      }),
    });
  } else if (!state.verifiedRoster.members.some((entry) => entry.userId === recipient.userId))
    throw new CryptoError("DECRYPT_FAILED", "Recipient absent from roster");
  // Bounded batches: every stored grant re-checks workspace membership (`storeGrant`).
  for (let start = 0; start < grants.length; start += ROSTER_EPOCH_WINDOW) {
    await trpcClient().e2ee.addGrants.mutate({
      workspace: workspaceId,
      grants: grants.slice(start, start + ROSTER_EPOCH_WINDOW),
    });
  }
}
/**
 * Processes MAC-proven joins, requests missing keys and rewraps stale historical workspace wraps.
 * Resolves whether it wrote anything, so the caller refetches the key state it read.
 */
export async function syncWorkspaceKeys(workspaceId: string): Promise<boolean> {
  const raw = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
  if (!raw.keyEpoch) {
    if (raw.role !== "owner") return false;
    await bootstrapWorkspace(workspaceId);
    return true;
  }
  let changed = false;
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
    ) {
      await trpcClient().e2ee.requestKeys.mutate({
        workspace: workspaceId,
        keyId: own.keyId,
      });
      changed = true;
    }
  }
  for (const request of state.joinRequests) {
    if (request.source === "request") {
      const identity = state.identities.get(request.userId);
      if (
        state.role !== "owner" &&
        identity &&
        request.keyId === identity.keyId &&
        ["tofu", "verified"].includes(await trust.check(identity.userId, identity))
      ) {
        await approveKeyRequest(workspaceId, request.id);
        changed = true;
      }
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
      box: fromBase64Url(request.ownerSecret),
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
          fromBase64Url(request.mac),
        )
      )
        throw new CryptoError("DECRYPT_FAILED", "Join proof failed");
      // A proven external secret may explicitly replace a changed pin, but never bypass rollback.
      await trust.pin(identity.userId, identity, "verified");
      await approveKeyRequest(workspaceId, request.id);
      changed = true;
    } finally {
      secret.fill(0);
    }
  }
  if (state.role === "owner" && (await rewrapWorkspaceChats(workspaceId))) changed = true;
  return changed;
}
/** Resolves whether any stale wrap was replaced. */
async function rewrapWorkspaceChats(workspaceId: string): Promise<boolean> {
  const current = await getCurrentMemberPublicKey(workspaceId);
  if (!current) return false;
  let replaced = false;
  let cursor: { workspaceEpoch: number; id: string } | null = null;
  do {
    const result: StaleWrapsPage = await trpcClient().e2ee.staleWorkspaceWraps.query({
      workspace: workspaceId,
      cursor,
      limit: 50,
    });
    const replacements = [];
    for (const wrap of result.page) {
      if (wrap.recipient !== "workspace" || wrap.workspaceEpoch === null)
        throw new CryptoError("BAD_ENVELOPE", "Invalid workspace wrap");
      const chat = await trpcClient().e2ee.chatKeys.query({
        chatId: wrap.chat,
        epoch: wrap.chatEpoch,
      });
      if (!chat.e2eeId) throw new CryptoError("BAD_ENVELOPE", "Missing chat identity");
      const old = await getMemberKey(workspaceId, wrap.workspaceEpoch);
      const aad = {
        table: "e2ee_chat_key_wraps",
        workspace: workspaceId,
        parent: chat.e2eeId,
        record: String(wrap.chatEpoch),
        field: wrap.recipientKeyId,
      };
      const seed = await openBox({
        seed: old.seed,
        box: fromBase64Url(wrap.sealed),
        aad,
        pad: "none",
      });
      try {
        const row = chat.epochs.find((epoch) => epoch.epoch === wrap.chatEpoch);
        if (
          !row ||
          !equalBytes(await encryptionPublicKeyFromSeed(seed), fromBase64Url(row.publicKey))
        )
          throw new CryptoError("DECRYPT_FAILED", "Stale chat wrap mismatch");
        const sealed = await sealBox({
          recipientPublicKey: current.publicKey,
          plaintext: seed,
          aad: { ...aad, field: current.keyId },
          pad: "none",
        });
        replacements.push({
          oldWrap: wrap.id,
          wrap: {
            chatEpoch: wrap.chatEpoch,
            recipient: "workspace" as const,
            workspaceEpoch: current.epoch,
            recipientKeyId: current.keyId,
            sealed: toBase64Url(sealed),
          },
        });
      } finally {
        seed.fill(0);
      }
    }
    if (replacements.length) {
      await trpcClient().e2ee.replaceWorkspaceWraps.mutate({
        workspace: workspaceId,
        replacements,
      });
      replaced = true;
    }
    cursor = result.cursor;
  } while (cursor);
  return replaced;
}
