import { ConvexError, v } from "convex/values";
import {
  ENCRYPTION_PUBLIC_KEY_BYTES,
  equalBytes,
  fingerprint,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  SUITE_1,
  verify,
  workerKeysStatement,
} from "radium-crypto";
import { components } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { mutation } from "../maintenance";
import { authComponent } from "../../convex/auth";
import { requireOwnedWorkspace, requireWorkspaceAccessForUser } from "../../convex/workspaces";
import { ENROLLMENT_TTL } from "../worker/auth";
import { workerMutation, workerQuery } from "../worker/machine";
import { invalidKeys, requireKeyId, requireSealedKey } from "./workspace-contract";
import { latestRoster, workspaceUsers } from "./workspace-keys";

/**
 * Worker E2EE keys and pairing (Keys.md "Workers"). The backend stores and relays public keys,
 * self-signatures, pairing MACs and the owner's sealed pairing secrets; it never decides trust.
 * The owner's browser verifies a Worker's MAC with the pairing secret and certifies the Worker by
 * listing it in the owner-signed roster (v2). Server-side roster parsing here only gates dispatch
 * as defense in depth; clients and Workers verify the signed roster themselves.
 */

type ReadCtx = QueryCtx | MutationCtx;

/** A setup or pairing code is usable this long after the owner creates it. */
export const WORKER_PAIRING_TTL = ENROLLMENT_TTL;
/**
 * The owner's sealed secret is kept this long after the code expires, so an owner who closed the
 * browser before the Worker published its keys can still certify it at the next unlock.
 */
export const WORKER_PAIRING_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Pending pairing rows per workspace, including retained ones awaiting certification. */
const MAX_WORKER_PAIRINGS = 100;
/** Workers one roster may certify. */
export const MAX_ROSTER_WORKERS = 200;
const PAIRING_MAC_BYTES = 32;

/** A certified Worker's public keys, for sealing to and verifying the Worker. */
export type WorkerKeys = {
  keyId: string;
  encryptionPublicKey: ArrayBuffer;
  signingPublicKey: ArrayBuffer;
};

/** Public key row of one Worker, as returned to browsers for their own verification. */
const workerKeyRowValidator = v.object({
  workerId: v.string(),
  keyId: v.string(),
  suite: v.number(),
  encryptionPublicKey: v.bytes(),
  signingPublicKey: v.bytes(),
  selfSignature: v.bytes(),
  pairingMac: v.bytes(),
  pairingId: v.string(),
  createdAt: v.number(),
});

function workerNotPaired(): never {
  throw new ConvexError({ code: "WORKER_NOT_PAIRED" });
}

async function findWorkerKeys(ctx: ReadCtx, workspace: Id<"workspaces">, workerId: string) {
  return await ctx.db
    .query("e2ee_worker_keys")
    .withIndex("by_workspace_and_workerId", (q) =>
      q.eq("workspace", workspace).eq("workerId", workerId),
    )
    .unique();
}

async function findPairing(ctx: ReadCtx, workspace: Id<"workspaces">, pairingId: string) {
  return await ctx.db
    .query("e2ee_worker_pairings")
    .withIndex("by_workspace_and_pairingId", (q) =>
      q.eq("workspace", workspace).eq("pairingId", pairingId),
    )
    .unique();
}

/** Same construction as user fingerprints: both public keys of the Worker's key set. */
function workerFingerprint(keys: Doc<"e2ee_worker_keys">): Promise<string> {
  return fingerprint({
    encryptionPublicKey: new Uint8Array(keys.encryptionPublicKey),
    signingPublicKey: new Uint8Array(keys.signingPublicKey),
  });
}

/**
 * Parses the Worker entries of a stored roster (workerId → keyId and fingerprint). Version 1 bodies
 * certify no Worker. The roster was signature-checked when stored; this is not a trust decision.
 */
function rosterWorkers(
  roster: Doc<"e2ee_rosters"> | null,
): Map<string, { keyId: string; fingerprint: string }> {
  const workers = new Map<string, { keyId: string; fingerprint: string }>();
  if (!roster) {
    return workers;
  }
  let body: { v?: unknown; workers?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(roster.body));
  } catch {
    return invalidKeys();
  }
  if (body.v !== 2 && body.v !== 3) {
    return workers;
  }
  if (!Array.isArray(body.workers) || body.workers.length > MAX_ROSTER_WORKERS) {
    invalidKeys();
  }
  for (const entry of body.workers) {
    if (
      typeof entry?.workerId !== "string" ||
      typeof entry.keyId !== "string" ||
      typeof entry.fingerprint !== "string"
    ) {
      invalidKeys();
    }
    workers.set(entry.workerId, { keyId: entry.keyId, fingerprint: entry.fingerprint });
  }
  return workers;
}

/**
 * The Worker's key set only when the latest roster lists this Worker with the same keyId and the
 * fingerprint of the stored keys. Revocation deletes the key row, so a revoked Worker is never
 * returned even before the owner re-signs the roster.
 */
export async function certifiedWorkerKeys(
  ctx: ReadCtx,
  workspace: Id<"workspaces">,
  workerId: string,
): Promise<WorkerKeys | null> {
  const keys = await findWorkerKeys(ctx, workspace, workerId);
  if (!keys) {
    return null;
  }
  const listed = rosterWorkers(await latestRoster(ctx, workspace)).get(workerId);
  if (
    !listed ||
    listed.keyId !== keys.keyId ||
    listed.fingerprint !== (await workerFingerprint(keys))
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
 * Dispatch gate for ACP commands/sessions and Worker tool tasks. Returns `null` for a keyless
 * workspace (legacy plaintext path) and the certified keys otherwise; throws
 * `ConvexError({ code: "WORKER_NOT_PAIRED" })` when the workspace has keys and the Worker is not
 * certified by the latest roster.
 */
export async function requireDispatchableWorker(
  ctx: ReadCtx,
  workspace: Id<"workspaces">,
  workerId: string,
): Promise<WorkerKeys | null> {
  const record = await ctx.db.get("workspaces", workspace);
  if (!record) {
    return workerNotPaired();
  }
  if (!record.keyEpoch) {
    return null;
  }
  return (await certifiedWorkerKeys(ctx, workspace, workerId)) ?? workerNotPaired();
}

/**
 * Validates the `workers` of a roster being stored: each an active Worker of the workspace whose
 * current key row has the listed keyId and the server-computed fingerprint. Pairing secrets of the
 * listed Workers are no longer needed and are deleted in the same transaction.
 */
export async function admitRosterWorkers(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  workers: unknown,
): Promise<void> {
  if (!Array.isArray(workers) || workers.length > MAX_ROSTER_WORKERS) {
    invalidKeys();
  }
  const seen = new Set<string>();
  for (const entry of workers) {
    if (
      typeof entry?.workerId !== "string" ||
      typeof entry.keyId !== "string" ||
      typeof entry.fingerprint !== "string" ||
      seen.has(entry.workerId)
    ) {
      invalidKeys();
    }
    seen.add(entry.workerId);
    const keys = await findWorkerKeys(ctx, workspace, entry.workerId);
    if (
      !keys ||
      keys.keyId !== entry.keyId ||
      entry.fingerprint !== (await workerFingerprint(keys)) ||
      !(await isActiveWorker(ctx, workspace, entry.workerId))
    ) {
      invalidKeys();
    }
    const pairing = await findPairing(ctx, workspace, keys.pairingId);
    if (pairing) {
      await ctx.db.delete("e2ee_worker_pairings", pairing._id);
    }
  }
}

async function isActiveWorker(
  ctx: ReadCtx,
  workspace: Id<"workspaces">,
  workerId: string,
): Promise<boolean> {
  try {
    const worker = await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId: workspace,
      workerId,
    });
    return worker.status === "active";
  } catch {
    // The component reports unknown and cross-workspace Workers as errors.
    return false;
  }
}

/** Revocation: the Worker's keys and pending pairings stop existing with its identity. */
export async function deleteWorkerKeys(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  workerId: string,
): Promise<void> {
  const keys = await findWorkerKeys(ctx, workspace, workerId);
  if (keys) {
    await ctx.db.delete("e2ee_worker_keys", keys._id);
  }
  const pairings = await ctx.db
    .query("e2ee_worker_pairings")
    .withIndex("by_workspace_and_pairingId", (q) => q.eq("workspace", workspace))
    .take(MAX_WORKER_PAIRINGS + 1);
  for (const pairing of pairings) {
    if (pairing.workerId === workerId) {
      await ctx.db.delete("e2ee_worker_pairings", pairing._id);
    }
  }
}

/** Deletes a bounded batch of pairing secrets past their retention; called by the hourly prune. */
export async function pruneWorkerPairings(ctx: MutationCtx): Promise<void> {
  const rows = await ctx.db
    .query("e2ee_worker_pairings")
    .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now() - WORKER_PAIRING_RETENTION_MS))
    .take(500);
  for (const row of rows) {
    await ctx.db.delete("e2ee_worker_pairings", row._id);
  }
}

/**
 * Owner-only: stores the owner's copy of a new pairing secret (sealed in the browser to the owner's
 * own identity key) for a setup enrollment or an enrolled Worker of a keyed workspace. The code that
 * carries the secret to the Worker is built in the browser and never reaches the backend. Returns
 * the code's expiry.
 */
export const createWorkerPairing = mutation({
  args: {
    workspace: v.id("workspaces"),
    pairingId: v.string(),
    sealedSecret: v.bytes(),
    target: v.union(
      v.object({ kind: v.literal("enrollment"), enrollmentId: v.string() }),
      v.object({ kind: v.literal("worker"), workerId: v.string() }),
    ),
  },
  returns: v.object({ expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    if (!workspace.keyEpoch) {
      invalidKeys();
    }
    requireKeyId(args.pairingId);
    requireSealedKey(args.sealedSecret);
    const existing = await ctx.db
      .query("e2ee_worker_pairings")
      .withIndex("by_workspace_and_pairingId", (q) => q.eq("workspace", workspace._id))
      .take(MAX_WORKER_PAIRINGS + 1);
    if (
      existing.length >= MAX_WORKER_PAIRINGS ||
      existing.some((row) => row.pairingId === args.pairingId)
    ) {
      invalidKeys();
    }

    let enrollment: Id<"worker_enrollments"> | undefined;
    let workerId: string | undefined;
    if (args.target.kind === "enrollment") {
      const id = ctx.db.normalizeId("worker_enrollments", args.target.enrollmentId);
      const record = id ? await ctx.db.get("worker_enrollments", id) : null;
      if (!record || record.workspace !== workspace._id) {
        invalidKeys();
      }
      enrollment = record._id;
    } else {
      if (!(await isActiveWorker(ctx, workspace._id, args.target.workerId))) {
        invalidKeys();
      }
      workerId = args.target.workerId;
    }

    const expiresAt = Date.now() + WORKER_PAIRING_TTL;
    await ctx.db.insert("e2ee_worker_pairings", {
      workspace: workspace._id,
      pairingId: args.pairingId,
      ownerUserId: workspace.ownerId,
      ...(workerId ? { workerId } : {}),
      ...(enrollment ? { enrollment } : {}),
      sealedSecret: args.sealedSecret,
      expiresAt,
    });
    return { expiresAt };
  },
});

/** Owner-only: the owner's sealed pairing secrets, for certifying Workers that published keys. */
export const workerPairings = query({
  args: { workspace: v.id("workspaces") },
  returns: v.array(
    v.object({
      pairingId: v.string(),
      workerId: v.optional(v.string()),
      sealedSecret: v.bytes(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const rows = await ctx.db
      .query("e2ee_worker_pairings")
      .withIndex("by_workspace_and_pairingId", (q) => q.eq("workspace", workspace._id))
      .take(MAX_WORKER_PAIRINGS + 1);
    if (rows.length > MAX_WORKER_PAIRINGS) {
      invalidKeys();
    }
    return rows
      .filter((row) => row.ownerUserId === workspace.ownerId)
      .map((row) => ({
        pairingId: row.pairingId,
        ...(row.workerId ? { workerId: row.workerId } : {}),
        sealedSecret: row.sealedSecret,
        expiresAt: row.expiresAt,
      }));
  },
});

/**
 * Public key rows of the workspace's active Workers, for any workspace member. Clients trust a row
 * only when the verified roster lists its keyId and fingerprint and its self-signature verifies.
 */
export const workerKeys = query({
  args: { workspace: v.id("workspaces") },
  returns: v.array(workerKeyRowValidator),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const workspace = await requireWorkspaceAccessForUser(ctx, args.workspace, user._id);
    const active = new Set(
      (
        await ctx.runQuery(components.workerIdentity.identities.listWorkers, {
          workspaceId: workspace._id,
          limit: 100,
        })
      )
        .filter((worker) => worker.status === "active")
        .map((worker) => worker.workerId),
    );
    const rows = await ctx.db
      .query("e2ee_worker_keys")
      .withIndex("by_workspace_and_workerId", (q) => q.eq("workspace", workspace._id))
      .take(MAX_ROSTER_WORKERS + 1);
    if (rows.length > MAX_ROSTER_WORKERS) {
      invalidKeys();
    }
    return rows
      .filter((row) => active.has(row.workerId))
      .map((row) => ({
        workerId: row.workerId,
        keyId: row.keyId,
        suite: row.suite,
        encryptionPublicKey: row.encryptionPublicKey,
        signingPublicKey: row.signingPublicKey,
        selfSignature: row.selfSignature,
        pairingMac: row.pairingMac,
        pairingId: row.pairingId,
        createdAt: row.createdAt,
      }));
  },
});

/**
 * Machine-only: publishes the calling Worker's E2EE key set from a setup or pairing code. The
 * self-signature over `workerKeysStatement` (scope from the verified machine identity, never from
 * arguments) is checked here; the pairing MAC can only be checked by the owner's browser. The
 * pairing must be unexpired and bound to this Worker (directly, or through the enrollment that
 * created it). Replaces any previous key set; retrying identical keys is a no-op.
 */
export const publishWorkerKeys = workerMutation({
  args: {
    pairingId: v.string(),
    keyId: v.string(),
    suite: v.number(),
    encryptionPublicKey: v.bytes(),
    signingPublicKey: v.bytes(),
    selfSignature: v.bytes(),
    pairingMac: v.bytes(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { workspaceId, workerId } = ctx.worker;
    requireKeyId(args.pairingId);
    requireKeyId(args.keyId);
    if (
      args.suite !== SUITE_1 ||
      args.encryptionPublicKey.byteLength !== ENCRYPTION_PUBLIC_KEY_BYTES ||
      args.signingPublicKey.byteLength !== SIGNING_PUBLIC_KEY_BYTES ||
      args.selfSignature.byteLength !== SIGNATURE_BYTES ||
      args.pairingMac.byteLength !== PAIRING_MAC_BYTES
    ) {
      invalidKeys();
    }
    const statement = workerKeysStatement({
      workspaceId,
      workerId,
      keyId: args.keyId,
      suite: args.suite,
      encryptionPublicKey: new Uint8Array(args.encryptionPublicKey),
      signingPublicKey: new Uint8Array(args.signingPublicKey),
    });
    if (
      !(await verify(
        new Uint8Array(args.signingPublicKey),
        statement,
        new Uint8Array(args.selfSignature),
      ))
    ) {
      invalidKeys();
    }

    const pairing = await findPairing(ctx, workspaceId, args.pairingId);
    if (!pairing || pairing.expiresAt <= Date.now()) {
      invalidKeys();
    }
    if (pairing.workerId !== undefined) {
      if (pairing.workerId !== workerId) {
        invalidKeys();
      }
    } else if (pairing.enrollment) {
      // A setup-code pairing binds to the Worker its enrollment produced, proven by that Worker's key.
      const enrollment = await ctx.db.get("worker_enrollments", pairing.enrollment);
      const key = await ctx.runQuery(components.workerIdentity.identities.getVerificationKey, {
        workspaceId,
        keyId: ctx.worker.keyId,
      });
      if (!enrollment || !key) {
        invalidKeys();
      }
      const receipt = await ctx.runQuery(components.workerIdentity.enrollment.recoverEnrollment, {
        workspaceId,
        enrollmentId: enrollment.componentEnrollmentId,
        thumbprint: key.publicKey.thumbprint,
      });
      if (receipt.workerId !== workerId) {
        invalidKeys();
      }
      await ctx.db.patch("e2ee_worker_pairings", pairing._id, { workerId });
    } else {
      invalidKeys();
    }

    const previous = await findWorkerKeys(ctx, workspaceId, workerId);
    if (previous?.keyId === args.keyId) {
      // A key ID names exactly one key set: a retry must carry identical keys and proofs.
      const identical =
        previous.pairingId === args.pairingId &&
        equalBytes(
          new Uint8Array(previous.encryptionPublicKey),
          new Uint8Array(args.encryptionPublicKey),
        ) &&
        equalBytes(
          new Uint8Array(previous.signingPublicKey),
          new Uint8Array(args.signingPublicKey),
        ) &&
        equalBytes(new Uint8Array(previous.pairingMac), new Uint8Array(args.pairingMac));
      if (!identical) {
        invalidKeys();
      }
      return null;
    }
    if (previous) {
      await ctx.db.delete("e2ee_worker_keys", previous._id);
    }
    await ctx.db.insert("e2ee_worker_keys", {
      workspace: workspaceId,
      workerId,
      keyId: args.keyId,
      suite: args.suite,
      encryptionPublicKey: args.encryptionPublicKey,
      signingPublicKey: args.signingPublicKey,
      selfSignature: args.selfSignature,
      pairingMac: args.pairingMac,
      pairingId: args.pairingId,
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Machine-only: the signed roster and the current (newest) public workspace epoch of the calling
 * Worker's workspace; Workers seal only to the current epoch. The Worker verifies the roster against
 * its pinned owner and the epoch keys against roster hashes.
 */
export const workerTrustState = workerQuery({
  args: {},
  returns: v.object({
    roster: v.union(
      v.null(),
      v.object({
        version: v.number(),
        body: v.bytes(),
        signature: v.bytes(),
        signerKeyId: v.string(),
      }),
    ),
    epochs: v.array(
      v.object({
        epoch: v.number(),
        memberKeyId: v.string(),
        memberPublicKey: v.bytes(),
        ownerKeyId: v.string(),
        ownerPublicKey: v.bytes(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const roster = await latestRoster(ctx, ctx.worker.workspaceId);
    const epochs = await ctx.db
      .query("e2ee_workspace_epochs")
      .withIndex("by_workspace_and_epoch", (q) => q.eq("workspace", ctx.worker.workspaceId))
      .order("desc")
      .take(1);
    return {
      roster: roster
        ? {
            version: roster.version,
            body: roster.body,
            signature: roster.signature,
            signerKeyId: roster.signerKeyId,
          }
        : null,
      epochs: epochs.map((epoch) => ({
        epoch: epoch.epoch,
        memberKeyId: epoch.memberKeyId,
        memberPublicKey: epoch.memberPublicKey,
        ownerKeyId: epoch.ownerKeyId,
        ownerPublicKey: epoch.ownerPublicKey,
      })),
    };
  },
});

/**
 * Machine-only: public identities by key ID, limited to users of the Worker's workspace (others and
 * pending keys resolve to `null`). The Worker checks self-signatures and roster membership itself.
 */
export const workerIdentities = workerQuery({
  args: { keyIds: v.array(v.string()) },
  returns: v.array(
    v.union(
      v.null(),
      v.object({
        userId: v.string(),
        keyId: v.string(),
        suite: v.number(),
        encryptionPublicKey: v.bytes(),
        signingPublicKey: v.bytes(),
        selfSignature: v.bytes(),
        status: v.union(v.literal("active"), v.literal("retired")),
      }),
    ),
  ),
  handler: async (ctx, args) => {
    if (args.keyIds.length > 200) {
      invalidKeys();
    }
    const workspace = await ctx.db.get("workspaces", ctx.worker.workspaceId);
    if (!workspace) {
      return invalidKeys();
    }
    const users = new Set(await workspaceUsers(ctx, workspace));
    const results = [];
    for (const keyId of args.keyIds) {
      requireKeyId(keyId);
      const identity = await ctx.db
        .query("e2ee_identities")
        .withIndex("by_keyId", (q) => q.eq("keyId", keyId))
        .unique();
      if (!identity || identity.status === "pending" || !users.has(identity.userId)) {
        results.push(null);
        continue;
      }
      results.push({
        userId: identity.userId,
        keyId,
        suite: identity.suite,
        encryptionPublicKey: identity.encryptionPublicKey,
        signingPublicKey: identity.signingPublicKey,
        selfSignature: identity.selfSignature,
        status: identity.status,
      });
    }
    return results;
  },
});
