import { and, desc, eq, inArray } from "drizzle-orm";
import { decodeExactBytes } from "contracts/e2ee/contract";
import { base64urlBytes } from "contracts/wire";
import {
  CAPSULE_BYTES,
  fingerprint,
  grantStatement,
  ROSTER_EPOCH_WINDOW,
  rosterStatement,
  verify,
} from "radium-crypto";
import { z } from "zod";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { activeWorkspaceWorkers } from "../worker/workers";
import {
  MAX_MEMBERS,
  setWorkspaceKeyEpoch,
  workspaceUserIds,
  type Workspace,
} from "../workspaces/workspaces";
import { workspaces } from "../workspaces/schema";
import {
  e2eeIdentities,
  e2eeInvites,
  e2eeJoinRequests,
  e2eeRosters,
  e2eeWorkerKeys,
  e2eeWorkerPairings,
  e2eeWorkspaceEpochs,
  e2eeWorkspaceGrants,
} from "./schema";

/**
 * Workspace key records (`docs/E2EE/Keys.md`): epochs, grants and owner-signed rosters. The
 * backend checks structure, bounds and signatures against the identities it stores; it never
 * holds a private key, and clients verify everything again themselves. Every refusal is the same
 * `E2EE_KEYS_INVALID`, without echoing key material.
 */

/** Size of an encoded workspace public key (suite 1). */
const WORKSPACE_PUBLIC_KEY_BYTES = 1216;
const SIGNATURE_BYTES = 64;
/** Roster bodies and other boxes are bounded. */
const MAX_BOX_BYTES = 65536;
/** Owner and member grants for every member of a full workspace, plus the owner's two. */
const MAX_GRANTS = 2 * MAX_MEMBERS + 2;
/** Workers one roster may certify. */
const MAX_ROSTER_WORKERS = 200;

const keyIdInput = z.string().max(32);

/** A workspace private key sealed to one active identity and signed by the granter. */
export const grantInput = z.object({
  epoch: z.number().int(),
  purpose: z.enum(["member", "owner"]),
  userId: z.string().max(256),
  recipientKeyId: keyIdInput,
  granterKeyId: keyIdInput,
  sealed: base64urlBytes(CAPSULE_BYTES + 256),
  signature: base64urlBytes(SIGNATURE_BYTES),
});

/** Public halves of a workspace key epoch; private seeds exist only in grants. */
export const epochInput = z.object({
  epoch: z.number().int(),
  suite: z.number().int(),
  memberKeyId: keyIdInput,
  memberPublicKey: base64urlBytes(WORKSPACE_PUBLIC_KEY_BYTES),
  ownerKeyId: keyIdInput,
  ownerPublicKey: base64urlBytes(WORKSPACE_PUBLIC_KEY_BYTES),
});

/** Owner-signed roster bytes. */
export const rosterInput = z.object({
  version: z.number().int(),
  body: base64urlBytes(MAX_BOX_BYTES),
  signature: base64urlBytes(SIGNATURE_BYTES),
  signerKeyId: keyIdInput,
});

/** A new epoch with its owner coverage and roster, applied atomically. */
export const workspaceKeysInput = z.object({
  epoch: epochInput,
  grants: z.array(grantInput).max(MAX_GRANTS),
  roster: rosterInput,
});

export type GrantInput = z.output<typeof grantInput>;
export type RosterInput = z.output<typeof rosterInput>;
export type WorkspaceKeysInput = z.output<typeof workspaceKeysInput>;

/** Fails closed without echoing key material. */
export function invalidKeys(): never {
  throw new AppError("BAD_REQUEST", "E2EE_KEYS_INVALID");
}

/** A canonical random 16-byte identifier. */
function requireKeyId(id: string) {
  if (!decodeExactBytes(id, 16)) {
    invalidKeys();
  }
}

function requirePositive(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidKeys();
  }
}

function requireBox(value: Uint8Array, max = MAX_BOX_BYTES) {
  if (value.byteLength < 1 || value.byteLength > max) {
    invalidKeys();
  }
}

/** The user's active identity; retired keys never receive new grants. */
export async function activeIdentity(db: Database, userId: string) {
  const [row] = await db
    .select()
    .from(e2eeIdentities)
    .where(and(eq(e2eeIdentities.userId, userId), eq(e2eeIdentities.status, "active")));
  return row;
}

/** The owner and members a roster may list; more than the roster bound is invalid. */
async function rosterAudience(db: Database, workspace: Workspace): Promise<string[]> {
  const users = await workspaceUserIds(db, workspace);
  if (users.length > MAX_MEMBERS + 1) {
    invalidKeys();
  }
  return users;
}

/** The newest owner-signed roster, or undefined before keys exist. */
export async function latestRoster(db: Database, workspaceId: string) {
  const [row] = await db
    .select()
    .from(e2eeRosters)
    .where(eq(e2eeRosters.workspace, workspaceId))
    .orderBy(desc(e2eeRosters.version))
    .limit(1);
  return row;
}

type RosterBody = {
  v?: unknown;
  workspace?: unknown;
  version?: unknown;
  epoch?: unknown;
  owner?: { userId?: unknown; keyId?: unknown };
  members?: unknown;
  epochs?: unknown;
  archive?: { through?: unknown; hash?: unknown };
  workers?: unknown;
};

function parseRosterBody(body: Uint8Array): RosterBody {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalidKeys();
    }
    return parsed as RosterBody;
  } catch {
    return invalidKeys();
  }
}

/** The signed roster's members as userId → pinned keyId, for checking member re-grants. */
function rosterMembers(roster: { body: Uint8Array } | undefined): Map<string, string> {
  const members = new Map<string, string>();
  if (!roster) {
    return members;
  }
  const body = parseRosterBody(roster.body);
  if (!Array.isArray(body.members) || body.members.length > MAX_MEMBERS) {
    invalidKeys();
  }
  for (const member of body.members as { userId?: unknown; keyId?: unknown }[]) {
    if (typeof member?.userId !== "string" || typeof member.keyId !== "string") {
      invalidKeys();
    }
    members.set(member.userId, member.keyId);
  }
  return members;
}

/**
 * Stores a roster after checking it is the next version, signed by the owner's active identity,
 * bound to this workspace and epoch, and lists only current members by their active keys and
 * only certifiable Workers. Version 3 bodies list at most `ROSTER_EPOCH_WINDOW` epochs; their
 * `archive.hash` is copied onto the epoch row `archive.through` as the prefix readers start
 * archive verification from. Version 1/2 bodies (older clients) still list every epoch.
 * Concurrent publishes of one version cannot both land (unique version per workspace).
 */
export async function storeRoster(
  tx: Database,
  workspace: Workspace,
  roster: RosterInput,
  epoch: number | null = workspace.keyEpoch,
): Promise<void> {
  requirePositive(roster.version);
  requireKeyId(roster.signerKeyId);
  requireBox(roster.body);
  const owner = await activeIdentity(tx, workspace.ownerId);
  const previous = await latestRoster(tx, workspace.id);
  // Signing with a retired or substituted key must not advance the trusted roster head.
  if (
    !owner ||
    epoch === null ||
    owner.keyId !== roster.signerKeyId ||
    roster.signature.byteLength !== SIGNATURE_BYTES ||
    roster.version <= (previous?.version ?? 0) ||
    !(await verify(
      owner.signingPublicKey,
      rosterStatement({ workspaceId: workspace.id, body: roster.body }),
      roster.signature,
    ))
  ) {
    invalidKeys();
  }

  const body = parseRosterBody(roster.body);
  const maxEpochs = body.v === 3 ? ROSTER_EPOCH_WINDOW : 200;
  if (
    (body.v !== 1 && body.v !== 2 && body.v !== 3) ||
    body.workspace !== workspace.id ||
    body.version !== roster.version ||
    body.epoch !== epoch ||
    body.owner?.userId !== workspace.ownerId ||
    body.owner?.keyId !== owner.keyId ||
    !Array.isArray(body.members) ||
    body.members.length > MAX_MEMBERS ||
    !Array.isArray(body.epochs) ||
    body.epochs.length > maxEpochs
  ) {
    invalidKeys();
  }

  // Version 3 window commitment: the epoch row that leaves the window and its chain value.
  let archive: { through: number; hash: string } | null = null;
  if (body.v === 3) {
    const through = body.archive?.through;
    const hash = body.archive?.hash;
    // Readers verify the chain; the server only bounds what it copies onto an epoch row.
    if (
      typeof through !== "number" ||
      !Number.isSafeInteger(through) ||
      through < 0 ||
      through >= epoch ||
      typeof hash !== "string" ||
      hash.length !== 43
    ) {
      invalidKeys();
    }
    archive = { through, hash };
  }

  const users = await rosterAudience(tx, workspace);
  const seen = new Set<string>();
  for (const member of body.members as { userId?: unknown; keyId?: unknown }[]) {
    if (
      typeof member?.userId !== "string" ||
      member.userId === workspace.ownerId ||
      !users.includes(member.userId) ||
      seen.has(member.userId)
    ) {
      invalidKeys();
    }
    const identity = await activeIdentity(tx, member.userId);
    if (!identity || member.keyId !== identity.keyId) {
      invalidKeys();
    }
    seen.add(member.userId);
  }
  // Version 1 rosters predate Worker keys and certify no Worker.
  await admitRosterWorkers(tx, workspace.id, body.v === 1 ? [] : body.workers);

  await tx.insert(e2eeRosters).values({
    workspace: workspace.id,
    version: roster.version,
    body: roster.body,
    signature: roster.signature,
    signerKeyId: roster.signerKeyId,
  });
  if (archive && archive.through > 0) {
    await tx
      .update(e2eeWorkspaceEpochs)
      .set({ rosterArchiveHash: archive.hash })
      .where(
        and(
          eq(e2eeWorkspaceEpochs.workspace, workspace.id),
          eq(e2eeWorkspaceEpochs.epoch, archive.through),
        ),
      );
  }
}

/**
 * Checks the `workers` of a roster being stored: each an active Worker of the workspace whose
 * current key row has the listed keyId and the server-computed fingerprint. Pairing secrets of
 * listed Workers are no longer needed and are deleted in the same transaction.
 */
async function admitRosterWorkers(tx: Database, workspaceId: string, workers: unknown) {
  if (!Array.isArray(workers) || workers.length > MAX_ROSTER_WORKERS) {
    invalidKeys();
  }
  const entries = workers as { workerId?: unknown; keyId?: unknown; fingerprint?: unknown }[];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry?.workerId !== "string" ||
      typeof entry.keyId !== "string" ||
      typeof entry.fingerprint !== "string" ||
      ids.has(entry.workerId)
    ) {
      invalidKeys();
    }
    ids.add(entry.workerId);
  }
  if (ids.size === 0) {
    return;
  }
  const active = await activeWorkspaceWorkers(tx, workspaceId, [...ids]);
  const keys = await tx
    .select()
    .from(e2eeWorkerKeys)
    .where(inArray(e2eeWorkerKeys.worker, [...active]));
  for (const entry of entries as { workerId: string; keyId: string; fingerprint: string }[]) {
    const row = keys.find((key) => key.worker === entry.workerId);
    if (
      !row ||
      row.keyId !== entry.keyId ||
      entry.fingerprint !==
        (await fingerprint({
          encryptionPublicKey: row.encryptionPublicKey,
          signingPublicKey: row.signingPublicKey,
        }))
    ) {
      invalidKeys();
    }
  }
  await tx.delete(e2eeWorkerPairings).where(
    and(
      eq(e2eeWorkerPairings.workspace, workspaceId),
      inArray(
        e2eeWorkerPairings.pairingId,
        keys.map((key) => key.pairingId),
      ),
    ),
  );
}

/**
 * Stores a signed grant to an active identity of a current workspace user. Only the owner grants
 * freely; a member may re-grant an epoch they hold, `member` purpose only, to the exact identity
 * the signed roster pins; self grants only through explicit join flows (`allowSelf`). An owner
 * grant replaces a member's or a join self-grant of the same recipient, epoch and purpose, and an
 * owner-signed member grant of the current epoch resolves that identity's key request.
 */
export async function storeGrant(
  tx: Database,
  workspace: Workspace,
  grant: GrantInput,
  granterUserId: string,
  allowSelf = false,
): Promise<void> {
  requirePositive(grant.epoch);
  requireKeyId(grant.recipientKeyId);
  requireKeyId(grant.granterKeyId);
  requireBox(grant.sealed, CAPSULE_BYTES + 256);
  const users = await rosterAudience(tx, workspace);
  const recipient = await activeIdentity(tx, grant.userId);
  const granter = await activeIdentity(tx, granterUserId);
  // New ciphertext may target only identities currently bound to workspace users.
  if (
    !users.includes(grant.userId) ||
    !recipient ||
    recipient.keyId !== grant.recipientKeyId ||
    !granter ||
    granter.keyId !== grant.granterKeyId ||
    grant.signature.byteLength !== SIGNATURE_BYTES ||
    (grant.purpose === "owner" && grant.userId !== workspace.ownerId)
  ) {
    invalidKeys();
  }
  const isOwner = granterUserId === workspace.ownerId;
  if (!allowSelf && granterUserId === grant.userId && !isOwner) {
    invalidKeys();
  }
  const [epoch] = await tx
    .select({ id: e2eeWorkspaceEpochs.id })
    .from(e2eeWorkspaceEpochs)
    .where(
      and(
        eq(e2eeWorkspaceEpochs.workspace, workspace.id),
        eq(e2eeWorkspaceEpochs.epoch, grant.epoch),
      ),
    );
  if (
    !epoch ||
    !(await verify(
      granter.signingPublicKey,
      grantStatement({
        workspaceId: workspace.id,
        epoch: grant.epoch,
        purpose: grant.purpose,
        recipientUserId: grant.userId,
        recipientKeyId: grant.recipientKeyId,
        sealed: grant.sealed,
      }),
      grant.signature,
    ))
  ) {
    invalidKeys();
  }
  if (!isOwner && !allowSelf) {
    // A member can redistribute only an epoch they hold, to the exact identity the owner listed.
    if (
      grant.purpose !== "member" ||
      rosterMembers(await latestRoster(tx, workspace.id)).get(grant.userId) !==
        grant.recipientKeyId
    ) {
      invalidKeys();
    }
    const [held] = await tx
      .select({ id: e2eeWorkspaceGrants.id })
      .from(e2eeWorkspaceGrants)
      .where(
        and(
          eq(e2eeWorkspaceGrants.workspace, workspace.id),
          eq(e2eeWorkspaceGrants.userId, granterUserId),
          eq(e2eeWorkspaceGrants.epoch, grant.epoch),
          eq(e2eeWorkspaceGrants.purpose, "member"),
          eq(e2eeWorkspaceGrants.recipientKeyId, granter.keyId),
        ),
      );
    if (!held) {
      invalidKeys();
    }
  }

  const recipientGrant = and(
    eq(e2eeWorkspaceGrants.workspace, workspace.id),
    eq(e2eeWorkspaceGrants.userId, grant.userId),
    eq(e2eeWorkspaceGrants.epoch, grant.epoch),
    eq(e2eeWorkspaceGrants.purpose, grant.purpose),
  );
  const [old] = await tx
    .select({
      recipientKeyId: e2eeWorkspaceGrants.recipientKeyId,
      granterUserId: e2eeWorkspaceGrants.granterUserId,
    })
    .from(e2eeWorkspaceGrants)
    .where(recipientGrant)
    .for("update");
  // An owner endorsement replaces any join self-grant or member re-grant, so a junk grant can
  // never block the owner's correct one; retries keep endorsed ciphertext intact.
  const replace =
    !old ||
    old.recipientKeyId !== grant.recipientKeyId ||
    (old.granterUserId !== workspace.ownerId && isOwner);
  if (replace) {
    if (old) {
      await tx.delete(e2eeWorkspaceGrants).where(recipientGrant);
    }
    await tx.insert(e2eeWorkspaceGrants).values({
      workspace: workspace.id,
      epoch: grant.epoch,
      purpose: grant.purpose,
      userId: grant.userId,
      recipientKeyId: grant.recipientKeyId,
      granterUserId,
      granterKeyId: grant.granterKeyId,
      sealed: grant.sealed,
      signature: grant.signature,
    });
  }
  // Only an owner-signed grant resolves a key request; a member's re-grant may be junk.
  if (
    grant.purpose === "member" &&
    grant.epoch === workspace.keyEpoch &&
    isOwner &&
    granterUserId !== grant.userId
  ) {
    await tx
      .delete(e2eeJoinRequests)
      .where(
        and(
          eq(e2eeJoinRequests.workspace, workspace.id),
          eq(e2eeJoinRequests.userId, grant.userId),
          eq(e2eeJoinRequests.keyId, grant.recipientKeyId),
        ),
      );
  }
}

/**
 * Inserts the next workspace key epoch with the owner's member and owner grants, any member
 * grants and the signed roster, then advances `workspaces.key_epoch`, in the caller's
 * transaction. The caller holds the workspace row lock (`lockWorkspace`), so `workspace.keyEpoch`
 * is current and two rotations cannot both succeed.
 */
export async function insertWorkspaceEpoch(
  tx: Database,
  workspace: Workspace,
  input: WorkspaceKeysInput,
): Promise<void> {
  const { epoch, grants, roster } = input;
  if (!workspace.keyEpoch && roster.version !== 1) {
    invalidKeys();
  }
  if (
    epoch.epoch !== (workspace.keyEpoch ?? 0) + 1 ||
    epoch.suite !== 1 ||
    epoch.memberPublicKey.byteLength !== WORKSPACE_PUBLIC_KEY_BYTES ||
    epoch.ownerPublicKey.byteLength !== WORKSPACE_PUBLIC_KEY_BYTES ||
    grants.length > MAX_GRANTS
  ) {
    invalidKeys();
  }
  requireKeyId(epoch.memberKeyId);
  requireKeyId(epoch.ownerKeyId);
  if (
    epoch.memberKeyId === epoch.ownerKeyId ||
    !(["member", "owner"] as const).every((purpose) =>
      grants.some(
        (grant) =>
          grant.userId === workspace.ownerId &&
          grant.purpose === purpose &&
          grant.epoch === epoch.epoch,
      ),
    ) ||
    grants.some((grant) => grant.epoch !== epoch.epoch)
  ) {
    invalidKeys();
  }
  await tx.insert(e2eeWorkspaceEpochs).values({
    workspace: workspace.id,
    epoch: epoch.epoch,
    suite: epoch.suite,
    memberKeyId: epoch.memberKeyId,
    memberPublicKey: epoch.memberPublicKey,
    ownerKeyId: epoch.ownerKeyId,
    ownerPublicKey: epoch.ownerPublicKey,
    createdBy: workspace.ownerId,
  });
  const updated = { ...workspace, keyEpoch: epoch.epoch };
  for (const grant of grants) {
    await storeGrant(tx, updated, grant, workspace.ownerId);
  }
  await storeRoster(tx, updated, roster, epoch.epoch);
  await setWorkspaceKeyEpoch(tx, workspace.id, epoch.epoch);
}

/** Deletes old-epoch admission proofs (access links, join requests) before keys rotate. */
export async function clearWorkspaceJoins(tx: Database, workspaceId: string): Promise<void> {
  await tx.delete(e2eeInvites).where(eq(e2eeInvites.workspace, workspaceId));
  await tx.delete(e2eeJoinRequests).where(eq(e2eeJoinRequests.workspace, workspaceId));
}

/**
 * Whether the current epoch's `purpose` key is still recoverable by a current workspace user's
 * active identity through an owner-issued grant. A no-recovery reset retires identities without
 * rotating workspace keys, so the public epoch alone must not decide that new content can be
 * sealed to it. Checks availability, not possession of the sealed seed.
 */
export async function workspaceKeyAvailable(
  db: Database,
  workspace: Workspace,
  purpose: "member" | "owner",
): Promise<boolean> {
  if (!workspace.keyEpoch) {
    return false;
  }
  const users =
    purpose === "owner" ? [workspace.ownerId] : await workspaceUserIds(db, workspace);
  if (users.length > MAX_MEMBERS + 1) {
    return false;
  }
  const [row] = await db
    .select({ id: e2eeWorkspaceGrants.id })
    .from(e2eeWorkspaceGrants)
    .innerJoin(
      e2eeIdentities,
      and(
        eq(e2eeIdentities.userId, e2eeWorkspaceGrants.userId),
        eq(e2eeIdentities.status, "active"),
        eq(e2eeIdentities.keyId, e2eeWorkspaceGrants.recipientKeyId),
      ),
    )
    .where(
      and(
        eq(e2eeWorkspaceGrants.workspace, workspace.id),
        eq(e2eeWorkspaceGrants.epoch, workspace.keyEpoch),
        eq(e2eeWorkspaceGrants.purpose, purpose),
        eq(e2eeWorkspaceGrants.granterUserId, workspace.ownerId),
        inArray(e2eeWorkspaceGrants.userId, users),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The public recipient new workspace-member content must be sealed to: the current epoch's
 * member key, while some current user can still open it. Undefined for a keyless workspace or an
 * unrecoverable epoch.
 */
export async function currentMemberRecipient(
  db: Database,
  workspace: Workspace,
): Promise<{ kind: "workspace_member"; keyId: string; epoch: number } | undefined> {
  if (!workspace.keyEpoch || !(await workspaceKeyAvailable(db, workspace, "member"))) {
    return undefined;
  }
  const [row] = await db
    .select({ keyId: e2eeWorkspaceEpochs.memberKeyId, epoch: e2eeWorkspaceEpochs.epoch })
    .from(e2eeWorkspaceEpochs)
    .where(
      and(
        eq(e2eeWorkspaceEpochs.workspace, workspace.id),
        eq(e2eeWorkspaceEpochs.epoch, workspace.keyEpoch),
      ),
    );
  if (!row) {
    throw new Error("Current workspace key epoch is missing.");
  }
  return { kind: "workspace_member", ...row };
}

/**
 * The current epoch's public owner key: the recipient of content the server seals for the
 * workspace owner only (Gateway telemetry). Null for a keyless workspace or one without a current
 * epoch row. Private key material never reaches the server.
 */
export async function workspaceOwnerSealingKey(
  db: Database,
  workspaceId: string,
): Promise<{ epoch: number; publicKey: Uint8Array } | null> {
  const [row] = await db
    .select({ epoch: e2eeWorkspaceEpochs.epoch, publicKey: e2eeWorkspaceEpochs.ownerPublicKey })
    .from(workspaces)
    .innerJoin(
      e2eeWorkspaceEpochs,
      and(
        eq(e2eeWorkspaceEpochs.workspace, workspaces.id),
        eq(e2eeWorkspaceEpochs.epoch, workspaces.keyEpoch),
      ),
    )
    .where(eq(workspaces.id, workspaceId));
  return row ?? null;
}
