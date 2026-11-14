import { fromBase64Url, utf8 } from "./encoding";
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
 * Owner-signed public roster body, serialized in this declaration's property order. Version 1 bodies
 * (before Workers had keys) carry no `workers`; `verifyRoster` returns them with an empty list.
 */
export type WorkspaceRoster = {
  v: 1 | 2;
  workspace: string;
  version: number;
  epoch: number;
  owner: RosterMember;
  epochs: RosterEpoch[];
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

/**
 * Creates a canonical version-2 roster signed with the owner's identity signing seed. The caller must
 * have approved every listed identity and verified every listed Worker's pairing.
 */
export async function signRoster(
  body: Omit<WorkspaceRoster, "v">,
  signingSeed: Uint8Array,
): Promise<SignedRoster> {
  const canonical: WorkspaceRoster = {
    v: 2,
    workspace: body.workspace,
    version: body.version,
    epoch: body.epoch,
    owner: {
      userId: body.owner.userId,
      keyId: body.owner.keyId,
      fingerprint: body.owner.fingerprint,
    },
    epochs: body.epochs.map((entry) => ({
      epoch: entry.epoch,
      memberKeyId: entry.memberKeyId,
      memberKeyHash: entry.memberKeyHash,
      ownerKeyId: entry.ownerKeyId,
      ownerKeyHash: entry.ownerKeyHash,
    })),
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
 * Verifies a roster against the pinned owner: signer key, signature, workspace, owner binding, version
 * not below `highWater` (the reader's rollback mark), and the shape of every epoch, member and Worker.
 * Throws `CryptoError` (`DECRYPT_FAILED` for signature/version, `BAD_ENVELOPE` for the body).
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
    (body.v !== 1 && body.v !== 2) ||
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
    (body.v === 2 && !Array.isArray(body.workers))
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

  const workers = body.v === 2 ? body.workers : [];
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
  return { ...body, workers };
}
