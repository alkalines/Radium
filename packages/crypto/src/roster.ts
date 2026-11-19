import { decimal, sha256 } from "./box";
import { equalBytes, fromBase64Url, lengthPrefixed, toBase64Url, utf8 } from "./encoding";
import { CryptoError } from "./errors";
import { sign, verify } from "./signatures";
import { rosterStatement } from "./statements";

/** Identity binding endorsed by the owner (fingerprint from `fingerprint()`). */
export type RosterMember = { userId: string; keyId: string; fingerprint: string };

/**
 * A Worker endorsed by the owner: its key set ID and the fingerprint of its encryption and signing public
 * keys. Being listed in the newest roster is the Worker's certificate; revocation removes it.
 */
export type RosterWorker = { workerId: string; keyId: string; fingerprint: string };

/** Per-epoch public key commitments (base64url SHA-256 of each public key). */
export type RosterEpoch = {
  epoch: number;
  memberKeyId: string;
  memberKeyHash: string;
  ownerKeyId: string;
  ownerKeyHash: string;
};

/**
 * Number of most recent epochs a version-3 roster lists itself. Older epochs leave the list for the
 * hash-chained `archive`, so a roster (and every read of it) stays bounded however often keys rotate.
 */
export const ROSTER_EPOCH_WINDOW = 32;

/**
 * Commitment to every epoch older than a version-3 roster's window. `through` is the newest archived
 * epoch (0: none) and `hash` the base64url chain value `A_through`, where `A_0` is 32 zero bytes and
 * `A_n = SHA-256(lengthPrefixed("radium/v1/roster-archive", A_(n-1), rosterEpochBytes(e_n)))`.
 */
export type RosterArchive = { through: number; hash: string };

/** The archive of a roster that has archived nothing (`A_0`); version 1 and 2 bodies read as this. */
export const EMPTY_ROSTER_ARCHIVE: Readonly<RosterArchive> = Object.freeze({
  through: 0,
  hash: toBase64Url(new Uint8Array(32)),
});

/**
 * Owner-signed public roster body, serialized in this declaration's property order. Version 3 lists
 * only the newest `ROSTER_EPOCH_WINDOW` epochs, contiguous and ending at `epoch`, and commits to the
 * rest through `archive`. Versions 1 and 2 list every epoch and are returned with
 * `EMPTY_ROSTER_ARCHIVE`; version 1 bodies (before Workers had keys) also carry no `workers` and are
 * returned with an empty list.
 */
export type WorkspaceRoster = {
  v: 1 | 2 | 3;
  workspace: string;
  version: number;
  epoch: number;
  owner: RosterMember;
  epochs: RosterEpoch[];
  archive: RosterArchive;
  members: RosterMember[];
  workers: RosterWorker[];
};

/** The pinned owner a roster must be signed by. */
export type RosterOwner = RosterMember & { signingPublicKey: Uint8Array };

/** Signed roster as stored in `e2ee_rosters`. */
export type SignedRoster = {
  version: number;
  body: Uint8Array;
  signature: Uint8Array;
  signerKeyId: string;
};

/** Canonical bytes of one roster epoch entry, the unit the archive chain hashes. */
export function rosterEpochBytes(entry: RosterEpoch): Uint8Array {
  return lengthPrefixed([
    decimal(entry.epoch),
    utf8(entry.memberKeyId),
    utf8(entry.memberKeyHash),
    utf8(entry.ownerKeyId),
    utf8(entry.ownerKeyHash),
  ]);
}

/**
 * Extends `archive` with `dropped`, which must be the contiguous epochs right after `archive.through`
 * in ascending order. Throws `CryptoError` (`BAD_INPUT`) otherwise.
 */
export async function extendRosterArchive(
  archive: RosterArchive,
  dropped: readonly RosterEpoch[],
): Promise<RosterArchive> {
  let hash = fromBase64Url(archive.hash);
  let through = archive.through;
  for (const entry of dropped) {
    if (entry.epoch !== through + 1) {
      throw new CryptoError("BAD_INPUT", "Archived roster epochs must be contiguous");
    }
    hash = await sha256(
      lengthPrefixed([utf8("radium/v1/roster-archive"), hash, rosterEpochBytes(entry)]),
    );
    through = entry.epoch;
  }
  return { through, hash: toBase64Url(hash) };
}

/**
 * Verifies archived epochs served by an untrusted source against the signed `archive`: recomputes the
 * chain from `claimedPrefixHash` (the server's claim for `A_(j-1)`, where `j` is the first entry's
 * epoch; `A_0` is fixed) over `entries` = epochs `j..archive.through` and requires the signed
 * `archive.hash`. Sound for any claimed prefix by SHA-256 collision resistance: a wrong prefix or
 * entry cannot reproduce the signed value. Throws `CryptoError` (`DECRYPT_FAILED`) on any mismatch.
 */
export async function verifyArchivedEpochs(input: {
  archive: RosterArchive;
  claimedPrefixHash: Uint8Array;
  entries: readonly RosterEpoch[];
}): Promise<void> {
  const failed = new CryptoError("DECRYPT_FAILED", "Archived roster epochs differ from roster");
  const first = input.entries[0];
  if (!first || !isPositive(first.epoch) || input.claimedPrefixHash.length !== 32) throw failed;
  // A_0 is not a claim: epoch 1 always chains from 32 zero bytes.
  if (first.epoch === 1 && !equalBytes(input.claimedPrefixHash, new Uint8Array(32))) throw failed;

  let computed: RosterArchive;
  try {
    computed = await extendRosterArchive(
      { through: first.epoch - 1, hash: toBase64Url(input.claimedPrefixHash) },
      input.entries,
    );
  } catch {
    throw failed;
  }
  if (computed.through !== input.archive.through || computed.hash !== input.archive.hash) {
    throw failed;
  }
}

/**
 * Keeps the newest `ROSTER_EPOCH_WINDOW` of `epochs` and moves older ones into `archive`, which must
 * end right before the oldest moved epoch. Converts a version 1/2 epoch list (with the empty archive)
 * and appends to a version-3 window alike.
 */
export async function windowRosterEpochs(input: {
  epochs: readonly RosterEpoch[];
  archive: RosterArchive;
}): Promise<{ epochs: RosterEpoch[]; archive: RosterArchive }> {
  const sorted = [...input.epochs].sort((a, b) => a.epoch - b.epoch);
  const keep = Math.min(sorted.length, ROSTER_EPOCH_WINDOW);
  const dropped = sorted.slice(0, sorted.length - keep);
  return {
    epochs: sorted.slice(sorted.length - keep),
    archive: await extendRosterArchive(input.archive, dropped),
  };
}

/**
 * Creates a canonical version-3 roster signed with the owner's identity signing seed. `epochs` may be
 * longer than the window (a version 1/2 list being converted, or a window plus a new epoch): older
 * entries move into `archive` (`windowRosterEpochs`). The result must list contiguous epochs ending at
 * `epoch` right after the archive, or this throws `CryptoError` (`BAD_INPUT`). The caller must have
 * approved every listed identity and verified every listed Worker's pairing.
 */
export async function signRoster(
  body: Omit<WorkspaceRoster, "v">,
  signingSeed: Uint8Array,
): Promise<SignedRoster> {
  const windowed = await windowRosterEpochs(body);
  if (!isWindow(windowed.epochs, windowed.archive, body.epoch)) {
    throw new CryptoError("BAD_INPUT", "Roster epochs are not a window ending at the current epoch");
  }
  const canonical: WorkspaceRoster = {
    v: 3,
    workspace: body.workspace,
    version: body.version,
    epoch: body.epoch,
    owner: {
      userId: body.owner.userId,
      keyId: body.owner.keyId,
      fingerprint: body.owner.fingerprint,
    },
    epochs: windowed.epochs.map((entry) => ({
      epoch: entry.epoch,
      memberKeyId: entry.memberKeyId,
      memberKeyHash: entry.memberKeyHash,
      ownerKeyId: entry.ownerKeyId,
      ownerKeyHash: entry.ownerKeyHash,
    })),
    archive: { through: windowed.archive.through, hash: windowed.archive.hash },
    members: body.members.map((member) => ({
      userId: member.userId,
      keyId: member.keyId,
      fingerprint: member.fingerprint,
    })),
    workers: body.workers.map((worker) => ({
      workerId: worker.workerId,
      keyId: worker.keyId,
      fingerprint: worker.fingerprint,
    })),
  };
  const encoded = utf8(JSON.stringify(canonical));
  return {
    version: canonical.version,
    body: encoded,
    signature: await sign(
      signingSeed,
      rosterStatement({ workspaceId: canonical.workspace, body: encoded }),
    ),
    signerKeyId: canonical.owner.keyId,
  };
}

function isKeyId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return fromBase64Url(value).length === 16;
  } catch {
    return false;
  }
}

function isDigest(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return fromBase64Url(value).length === 32;
  } catch {
    return false;
  }
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Version-3 window shape: the newest `min(epoch, ROSTER_EPOCH_WINDOW)` epochs in ascending,
 * contiguous order ending at `epoch`, right after `archive.through`; an archive of nothing is `A_0`.
 */
function isWindow(epochs: readonly RosterEpoch[], archive: RosterArchive, epoch: number): boolean {
  if (
    !archive ||
    typeof archive !== "object" ||
    !Number.isSafeInteger(archive.through) ||
    archive.through < 0 ||
    !isDigest(archive.hash) ||
    (archive.through === 0 && archive.hash !== EMPTY_ROSTER_ARCHIVE.hash) ||
    epochs.length !== Math.min(epoch, ROSTER_EPOCH_WINDOW) ||
    archive.through !== epoch - epochs.length
  ) {
    return false;
  }
  return epochs.every((entry, index) => entry?.epoch === archive.through + 1 + index);
}

/**
 * Verifies a roster against the pinned owner: signer key, signature, workspace, owner binding, version
 * not below `highWater` (the reader's rollback mark), and the shape of every epoch, member and Worker,
 * plus the window and archive fields of version 3. Archived epochs are verified separately
 * (`verifyArchivedEpochs`). Throws `CryptoError` (`DECRYPT_FAILED` for signature/version,
 * `BAD_ENVELOPE` for the body).
 */
export async function verifyRoster(
  input: SignedRoster & { workspaceId: string; owner: RosterOwner; highWater: number },
): Promise<WorkspaceRoster> {
  if (
    input.version < input.highWater ||
    input.signerKeyId !== input.owner.keyId ||
    !(await verify(
      input.owner.signingPublicKey,
      rosterStatement({ workspaceId: input.workspaceId, body: input.body }),
      input.signature,
    ))
  )
    throw new CryptoError("DECRYPT_FAILED", "Roster signature or version failed");

  let body: WorkspaceRoster;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
  } catch {
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster body");
  }
  if (
    !body ||
    typeof body !== "object" ||
    (body.v !== 1 && body.v !== 2 && body.v !== 3) ||
    body.workspace !== input.workspaceId ||
    body.version !== input.version ||
    !isPositive(body.version) ||
    !isPositive(body.epoch) ||
    !body.owner ||
    body.owner.userId !== input.owner.userId ||
    body.owner.keyId !== input.owner.keyId ||
    body.owner.fingerprint !== input.owner.fingerprint ||
    !Array.isArray(body.epochs) ||
    !Array.isArray(body.members) ||
    (body.v !== 1 && !Array.isArray(body.workers))
  )
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster body");

  const epochIds = new Set<number>();
  for (const epoch of body.epochs) {
    if (
      !epoch ||
      !isPositive(epoch.epoch) ||
      epoch.epoch > body.epoch ||
      epochIds.has(epoch.epoch) ||
      !isKeyId(epoch.memberKeyId) ||
      !isKeyId(epoch.ownerKeyId) ||
      !isDigest(epoch.memberKeyHash) ||
      !isDigest(epoch.ownerKeyHash)
    )
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster epoch");
    epochIds.add(epoch.epoch);
  }
  if (!epochIds.has(body.epoch))
    throw new CryptoError("BAD_ENVELOPE", "Roster current epoch missing");
  if (body.v === 3 && !isWindow(body.epochs, body.archive, body.epoch))
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster epoch window");

  const members = new Set<string>();
  for (const member of body.members) {
    if (
      !member ||
      typeof member.userId !== "string" ||
      typeof member.fingerprint !== "string" ||
      member.userId === body.owner.userId ||
      members.has(member.userId) ||
      !isKeyId(member.keyId)
    )
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster member");
    members.add(member.userId);
  }

  const workers = body.v === 1 ? [] : body.workers;
  const workerIds = new Set<string>();
  for (const worker of workers) {
    if (
      !worker ||
      typeof worker.workerId !== "string" ||
      worker.workerId.length === 0 ||
      typeof worker.fingerprint !== "string" ||
      workerIds.has(worker.workerId) ||
      !isKeyId(worker.keyId)
    )
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster worker");
    workerIds.add(worker.workerId);
  }
  const archive =
    body.v === 3
      ? { through: body.archive.through, hash: body.archive.hash }
      : { ...EMPTY_ROSTER_ARCHIVE };
  return { ...body, archive, workers };
}
