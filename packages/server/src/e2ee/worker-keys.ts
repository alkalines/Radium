import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { base64urlBytes } from "contracts/wire";
import {
  CAPSULE_BYTES,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  equalBytes,
  fingerprint,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  SUITE_1,
  toBase64Url,
  verify,
  workerKeysStatement,
} from "radium-crypto";
import { z } from "zod";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import type { WorkerScope } from "../worker/auth";
import { activeWorkerIds, activeWorkspaceWorkers, workspaceEnrollment } from "../worker/workers";
import { workspaces } from "../workspaces/schema";
import { workspaceUserIds, type Workspace } from "../workspaces/workspaces";
import { e2eeIdentities, e2eeWorkerKeys, e2eeWorkerPairings, e2eeWorkspaceEpochs } from "./schema";
import { identityWire } from "./wire";
import {
  invalidKeys,
  latestRoster,
  lockWorkspaceKeys,
  parseRosterBody,
  requireBox,
  requireKeyId,
} from "./workspace-keys";

/**
 * Worker E2EE keys and pairing (`docs/E2EE/Keys.md`, "Workers"). The backend stores and relays
 * public keys, self-signatures, pairing MACs and the owner's sealed pairing secrets; it never
 * decides trust. The owner's browser verifies a Worker's MAC with the pairing secret and certifies
 * the Worker by listing it in the owner-signed roster (v2+). Roster parsing here only gates
 * dispatch as defense in depth; clients and Workers verify the signed roster themselves.
 */

/** A setup or pairing code is usable this long after the owner creates it (the setup code TTL). */
export const WORKER_PAIRING_TTL_MS = 10 * 60_000;
/**
 * The owner's sealed secret is kept this long after the code expires, so an owner who closed the
 * browser before the Worker published its keys can still certify it at the next unlock.
 */
export const WORKER_PAIRING_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Pending pairing rows per workspace, including retained ones awaiting certification. */
const MAX_WORKER_PAIRINGS = 100;
/** Workers one roster may certify. */
const MAX_ROSTER_WORKERS = 200;
const PAIRING_MAC_BYTES = 32;
/** Key ids one Worker identity read may name. */
const MAX_WORKER_IDENTITY_IDS = 200;

const keyIdInput = z.string().max(32);

export const createWorkerPairingInput = z.object({
  pairingId: keyIdInput,
  sealedSecret: base64urlBytes(CAPSULE_BYTES + 256),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enrollment"), enrollmentId: z.string().min(1).max(256) }),
    z.object({ kind: z.literal("worker"), workerId: z.string().min(1).max(256) }),
  ]),
});

/** A Worker's E2EE key set as it publishes it (machine procedure, Worker slice). */
export const publishWorkerKeysInput = z.object({
  pairingId: keyIdInput,
  keyId: keyIdInput,
  suite: z.number().int(),
  encryptionPublicKey: base64urlBytes(ENCRYPTION_PUBLIC_KEY_BYTES),
  signingPublicKey: base64urlBytes(SIGNING_PUBLIC_KEY_BYTES),
  selfSignature: base64urlBytes(SIGNATURE_BYTES),
  pairingMac: base64urlBytes(PAIRING_MAC_BYTES),
});

/** A certified Worker's public keys, for sealing to and verifying the Worker. */
export type WorkerKeys = {
  keyId: string;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
};

function workerNotPaired(): never {
  throw new AppError("FORBIDDEN", "WORKER_NOT_PAIRED");
}

/**
 * Owner-only: stores the owner's copy of a new pairing secret (sealed in the browser to the
 * owner's own identity key) for a setup enrollment or an active Worker of a keyed workspace. The
 * code that carries the secret to the Worker is built in the browser and never reaches the
 * backend. Returns the code's expiry.
 */
export async function createWorkerPairing(
  db: Database,
  workspaceId: string,
  userId: string,
  input: z.output<typeof createWorkerPairingInput>,
): Promise<{ expiresAt: number }> {
  requireKeyId(input.pairingId);
  requireBox(input.sealedSecret, CAPSULE_BYTES + 256);
  return await db.transaction(async (tx) => {
    const workspace = await lockWorkspaceKeys(tx, workspaceId, userId, true);
    if (!workspace.keyEpoch) {
      invalidKeys();
    }
    const [pending] = await tx
      .select({ count: count() })
      .from(e2eeWorkerPairings)
      .where(eq(e2eeWorkerPairings.workspace, workspace.id));
    if (pending!.count >= MAX_WORKER_PAIRINGS) {
      invalidKeys();
    }
    const { target } = input;
    if (
      target.kind === "enrollment"
        ? !(await workspaceEnrollment(tx, workspace.id, target.enrollmentId))
        : !(await activeWorkspaceWorkers(tx, workspace.id, [target.workerId])).has(target.workerId)
    ) {
      invalidKeys();
    }
    const expiresAt = new Date(Date.now() + WORKER_PAIRING_TTL_MS);
    const inserted = await tx
      .insert(e2eeWorkerPairings)
      .values({
        workspace: workspace.id,
        pairingId: input.pairingId,
        ownerUserId: workspace.ownerId,
        worker: target.kind === "worker" ? target.workerId : null,
        enrollment: target.kind === "enrollment" ? target.enrollmentId : null,
        sealedSecret: input.sealedSecret,
        expiresAt,
      })
      .onConflictDoNothing({ target: [e2eeWorkerPairings.workspace, e2eeWorkerPairings.pairingId] })
      .returning({ id: e2eeWorkerPairings.id });
    if (inserted.length === 0) {
      invalidKeys();
    }
    return { expiresAt: expiresAt.getTime() };
  });
}

/** Owner-only: the owner's sealed pairing secrets, for certifying Workers that published keys. */
export async function workerPairings(db: Database, workspace: Workspace) {
  const rows = await db
    .select()
    .from(e2eeWorkerPairings)
    .where(
      and(
        eq(e2eeWorkerPairings.workspace, workspace.id),
        eq(e2eeWorkerPairings.ownerUserId, workspace.ownerId),
      ),
    )
    .orderBy(e2eeWorkerPairings.createdAt, e2eeWorkerPairings.id)
    .limit(MAX_WORKER_PAIRINGS + 1);
  if (rows.length > MAX_WORKER_PAIRINGS) {
    invalidKeys();
  }
  return rows.map((row) => ({
    pairingId: row.pairingId,
    workerId: row.worker,
    sealedSecret: toBase64Url(row.sealedSecret),
    expiresAt: row.expiresAt.getTime(),
  }));
}

/**
 * Public key rows of the workspace's active Workers, for any workspace user. Clients trust a row
 * only when the verified roster lists its keyId and fingerprint and its self-signature verifies.
 */
export async function workerKeys(db: Database, workspace: Workspace) {
  const active = await activeWorkerIds(db, workspace.id, MAX_ROSTER_WORKERS);
  const rows =
    active.length === 0
      ? []
      : await db
          .select()
          .from(e2eeWorkerKeys)
          .where(inArray(e2eeWorkerKeys.worker, active))
          .orderBy(e2eeWorkerKeys.createdAt, e2eeWorkerKeys.id);
  return rows.map((row) => ({
    workerId: row.worker,
    keyId: row.keyId,
    suite: row.suite,
    encryptionPublicKey: toBase64Url(row.encryptionPublicKey),
    signingPublicKey: toBase64Url(row.signingPublicKey),
    selfSignature: toBase64Url(row.selfSignature),
    pairingMac: toBase64Url(row.pairingMac),
    pairingId: row.pairingId,
    createdAt: row.createdAt.getTime(),
  }));
}

/**
 * Machine-only: publishes the calling Worker's E2EE key set from a setup or pairing code. The
 * self-signature over `workerKeysStatement` (scope from the verified machine identity, never from
 * input) is checked here; the pairing MAC can only be checked by the owner's browser. The pairing
 * must be unexpired and bound to this Worker, directly or through the enrollment that produced it
 * with this Worker's current proof key. Replaces any previous key set; retrying identical keys is
 * a no-op, and a key id names exactly one key set.
 */
export async function publishWorkerKeys(
  db: Database,
  scope: WorkerScope,
  input: z.output<typeof publishWorkerKeysInput>,
): Promise<void> {
  const { workspaceId, workerId } = scope;
  requireKeyId(input.pairingId);
  requireKeyId(input.keyId);
  if (
    input.suite !== SUITE_1 ||
    input.encryptionPublicKey.byteLength !== ENCRYPTION_PUBLIC_KEY_BYTES ||
    input.signingPublicKey.byteLength !== SIGNING_PUBLIC_KEY_BYTES ||
    input.selfSignature.byteLength !== SIGNATURE_BYTES ||
    input.pairingMac.byteLength !== PAIRING_MAC_BYTES ||
    !(await verify(
      input.signingPublicKey,
      workerKeysStatement({
        workspaceId,
        workerId,
        keyId: input.keyId,
        suite: input.suite,
        encryptionPublicKey: input.encryptionPublicKey,
        signingPublicKey: input.signingPublicKey,
      }),
      input.selfSignature,
    ))
  ) {
    invalidKeys();
  }
  await db.transaction(async (tx) => {
    const [pairing] = await tx
      .select()
      .from(e2eeWorkerPairings)
      .where(
        and(
          eq(e2eeWorkerPairings.workspace, workspaceId),
          eq(e2eeWorkerPairings.pairingId, input.pairingId),
        ),
      )
      .for("update");
    if (!pairing || pairing.expiresAt.getTime() <= Date.now()) {
      invalidKeys();
    }
    if (pairing.worker !== null) {
      if (pairing.worker !== workerId) {
        invalidKeys();
      }
    } else if (pairing.enrollment !== null) {
      // A setup-code pairing binds to the Worker its enrollment produced, with this proof key.
      const enrollment = await workspaceEnrollment(tx, workspaceId, pairing.enrollment);
      if (
        enrollment?.state !== "completed" ||
        enrollment.completionWorker !== workerId ||
        enrollment.completionKey !== scope.keyId
      ) {
        invalidKeys();
      }
      await tx
        .update(e2eeWorkerPairings)
        .set({ worker: workerId })
        .where(eq(e2eeWorkerPairings.id, pairing.id));
    } else {
      invalidKeys();
    }

    const [previous] = await tx
      .select()
      .from(e2eeWorkerKeys)
      .where(eq(e2eeWorkerKeys.worker, workerId))
      .for("update");
    if (previous?.keyId === input.keyId) {
      const identical =
        previous.pairingId === input.pairingId &&
        equalBytes(previous.encryptionPublicKey, input.encryptionPublicKey) &&
        equalBytes(previous.signingPublicKey, input.signingPublicKey) &&
        equalBytes(previous.pairingMac, input.pairingMac);
      if (!identical) {
        invalidKeys();
      }
      return;
    }
    const row = {
      keyId: input.keyId,
      suite: input.suite,
      encryptionPublicKey: input.encryptionPublicKey,
      signingPublicKey: input.signingPublicKey,
      selfSignature: input.selfSignature,
      pairingMac: input.pairingMac,
      pairingId: input.pairingId,
      createdAt: new Date(),
    };
    await tx
      .insert(e2eeWorkerKeys)
      .values({ worker: workerId, ...row })
      .onConflictDoUpdate({ target: e2eeWorkerKeys.worker, set: row });
  });
}

/**
 * Machine-only: the signed roster and the current (newest) public workspace epoch of the calling
 * Worker's workspace; Workers seal only to the current epoch. The Worker verifies the roster
 * against its pinned owner and the epoch keys against roster hashes.
 */
export async function workerTrustState(db: Database, scope: WorkerScope) {
  const roster = await latestRoster(db, scope.workspaceId);
  const epochs = await db
    .select()
    .from(e2eeWorkspaceEpochs)
    .where(eq(e2eeWorkspaceEpochs.workspace, scope.workspaceId))
    .orderBy(desc(e2eeWorkspaceEpochs.epoch))
    .limit(1);
  return {
    roster: roster
      ? {
          version: roster.version,
          body: toBase64Url(roster.body),
          signature: toBase64Url(roster.signature),
          signerKeyId: roster.signerKeyId,
        }
      : null,
    epochs: epochs.map((epoch) => ({
      epoch: epoch.epoch,
      memberKeyId: epoch.memberKeyId,
      memberPublicKey: toBase64Url(epoch.memberPublicKey),
      ownerKeyId: epoch.ownerKeyId,
      ownerPublicKey: toBase64Url(epoch.ownerPublicKey),
    })),
  };
}

/**
 * Machine-only: public identities by key id, limited to users of the Worker's workspace; others,
 * unknown and pending keys read as `null`. The Worker checks self-signatures and roster membership
 * itself.
 */
export async function workerIdentities(db: Database, scope: WorkerScope, keyIds: string[]) {
  if (keyIds.length > MAX_WORKER_IDENTITY_IDS) {
    invalidKeys();
  }
  for (const keyId of keyIds) {
    requireKeyId(keyId);
  }
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  if (!workspace) {
    invalidKeys();
  }
  const users = new Set(await workspaceUserIds(db, workspace));
  const rows =
    keyIds.length === 0
      ? []
      : await db.select().from(e2eeIdentities).where(inArray(e2eeIdentities.keyId, keyIds));
  const byKey = new Map(rows.map((row) => [row.keyId, row]));
  return keyIds.map((keyId) => {
    const row = byKey.get(keyId);
    if (!row || row.status === "pending" || !users.has(row.userId)) {
      return null;
    }
    return { ...identityWire(row), status: row.status };
  });
}

/**
 * The Worker entries of a stored roster (workerId → keyId and fingerprint). Version 1 bodies
 * certify no Worker. The roster was signature-checked when stored; this is not a trust decision.
 */
function rosterWorkers(roster: { body: Uint8Array } | undefined) {
  const listed = new Map<string, { keyId: string; fingerprint: string }>();
  if (!roster) {
    return listed;
  }
  const body = parseRosterBody(roster.body);
  if (body.v !== 2 && body.v !== 3) {
    return listed;
  }
  if (!Array.isArray(body.workers) || body.workers.length > MAX_ROSTER_WORKERS) {
    invalidKeys();
  }
  for (const entry of body.workers as {
    workerId?: unknown;
    keyId?: unknown;
    fingerprint?: unknown;
  }[]) {
    if (
      typeof entry?.workerId !== "string" ||
      typeof entry.keyId !== "string" ||
      typeof entry.fingerprint !== "string"
    ) {
      invalidKeys();
    }
    listed.set(entry.workerId, { keyId: entry.keyId, fingerprint: entry.fingerprint });
  }
  return listed;
}

/**
 * The Worker's key set, only while it is an active Worker of `workspaceId` and the newest roster
 * lists it with the same keyId and the fingerprint of the stored keys. Revocation applies at once,
 * before the owner signs a roster without the Worker.
 */
export async function certifiedWorkerKeys(
  db: Database,
  workspaceId: string,
  workerId: string,
): Promise<WorkerKeys | null> {
  if (!(await activeWorkspaceWorkers(db, workspaceId, [workerId])).has(workerId)) {
    return null;
  }
  const [keys] = await db.select().from(e2eeWorkerKeys).where(eq(e2eeWorkerKeys.worker, workerId));
  if (!keys) {
    return null;
  }
  const listed = rosterWorkers(await latestRoster(db, workspaceId)).get(workerId);
  if (
    !listed ||
    listed.keyId !== keys.keyId ||
    listed.fingerprint !==
      (await fingerprint({
        encryptionPublicKey: keys.encryptionPublicKey,
        signingPublicKey: keys.signingPublicKey,
      }))
  ) {
    return null;
  }
  return {
    keyId: keys.keyId,
    encryptionPublicKey: keys.encryptionPublicKey,
    signingPublicKey: keys.signingPublicKey,
  };
}

/**
 * Dispatch gate for ACP commands and sessions and Worker tool tasks. `null` for a keyless
 * workspace, the certified keys otherwise; refuses with `WORKER_NOT_PAIRED` when the workspace is
 * unknown, or keyed and the Worker is not certified by the newest roster.
 */
export async function requireDispatchableWorker(
  db: Database,
  workspaceId: string,
  workerId: string,
): Promise<WorkerKeys | null> {
  const [workspace] = await db
    .select({ keyEpoch: workspaces.keyEpoch })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    workerNotPaired();
  }
  if (!workspace.keyEpoch) {
    return null;
  }
  return (await certifiedWorkerKeys(db, workspaceId, workerId)) ?? workerNotPaired();
}

/** Revocation: the Worker's keys and pending pairings stop existing with its identity. */
export async function deleteWorkerKeys(tx: Database, workspaceId: string, workerId: string) {
  await tx.delete(e2eeWorkerKeys).where(eq(e2eeWorkerKeys.worker, workerId));
  await tx
    .delete(e2eeWorkerPairings)
    .where(
      and(eq(e2eeWorkerPairings.workspace, workspaceId), eq(e2eeWorkerPairings.worker, workerId)),
    );
}

/** Retention: deletes up to `batch` pairing secrets past expiry plus the retention period. */
export async function pruneWorkerPairings(db: Database, now: number, batch: number) {
  const cutoff = new Date(now - WORKER_PAIRING_RETENTION_MS);
  const deleted = await db
    .delete(e2eeWorkerPairings)
    .where(
      sql`${e2eeWorkerPairings.id} in (select ${e2eeWorkerPairings.id} from ${e2eeWorkerPairings} where ${e2eeWorkerPairings.expiresAt} <= ${cutoff} limit ${batch})`,
    )
    .returning({ id: e2eeWorkerPairings.id });
  return deleted.length;
}
