import { and, asc, eq, gt, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { WORKER_TASK_RETENTION_MS } from "contracts/worker/task-contract";
import type { z } from "zod";
import type { keyTelemetryValidator } from "contracts/acp/gateway";
import { failWorkerAcpWork } from "../acp/sessions";
import { clearWarmSessions } from "../acp/warm";
import { takeToken, type RateLimit } from "../auth/ratelimit";
import type { Database, Kv } from "../drivers/types";
import { deleteWorkerKeys } from "../e2ee/worker-keys";
import { AppError } from "../errors";
import { invalidateApiKeys } from "../gateway/keys";
import { dispatchJobs } from "../jobs/outbox";
import { kvSet, kvTake } from "../kv";
import type { Runtime } from "../runtime";
import { signalChat } from "../streams/signals";
import { workspaces } from "../workspaces/schema";
import type { WorkerScope } from "./auth";
import { clearWorkerGateway, workerGatewaySettings } from "./gateway";
import { deleteWorkerPresence, workerPresence } from "./presence";
import { workerEnrollments, workerKeys, workerTasks, workers } from "./schema";
import {
  CHALLENGE_TTL_MS,
  ENROLLMENT_TTL_MS,
  issueWorkerToken,
  normalizeWorkerKey,
  randomToken,
  tokenDigest,
  verifyWorkerProof,
  type WorkerIdentity,
} from "./signing";
import { TASK_SIGNAL } from "./tasks";

/**
 * Worker identity: owner management (setup codes, listing, revocation) and machine-auth
 * admission (Convex `src/worker/{management,identity}.ts` with the `workerIdentity` component).
 *
 * Machine authentication: `POST /api/worker/auth/challenge` stores a one-use statement in Valkey
 * for sixty seconds; `/complete` takes it with `GETDEL` before anything else, verifies the
 * Worker's proof against the key the challenge bound, then admits it against current Postgres
 * state and answers with the identity (enroll, recover) or a five-minute access token. Every
 * failure is the same {@link WorkerAuthDenied}.
 */

/** Any machine-auth refusal; the HTTP layer answers every one with the same 401. */
export class WorkerAuthDenied extends Error {
  constructor() {
    super("WORKER_AUTH_DENIED");
    this.name = "WorkerAuthDenied";
  }
}

function denied(): never {
  throw new WorkerAuthDenied();
}

/** Setup codes per workspace (Convex `setup`: 10 per minute). */
const SETUP_LIMIT: RateLimit = { name: "worker-setup", capacity: 10, periodMs: 60_000 };
/** Challenges per workspace (Convex `challenge`: 120 per minute). */
const CHALLENGE_LIMIT: RateLimit = { name: "worker-challenge", capacity: 120, periodMs: 60_000 };

/** Workers listed per workspace (Convex `listWorkers` limit). */
const MAX_LISTED_WORKERS = 100;
const MAX_WORKER_NAME = 80;
/** Pending and revoked setup codes are deleted this long after they expire. */
export const WORKER_ENROLLMENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

type KeyTelemetry = z.infer<typeof keyTelemetryValidator>;
type ProofKey = { algorithm: string; material: string; thumbprint: string };

/** A stored challenge: the operation scope the Worker's proof will be admitted for. */
type Challenge =
  | {
      kind: "token";
      workspace: string;
      workerId: string;
      keyId: string;
      identityEpoch: number;
      material: string;
    }
  | ({
      kind: "enroll" | "recover";
      workspace: string;
      enrollmentId: string;
      requestId: string;
    } & ProofKey);

const challengeKey = (id: string) => `worker:challenge:${id}`;

// ---------------------------------------------------------------------------------------------
// Owner management

/** Owner: the workspace's Workers with their last heartbeat, temp directory and Gateway access. */
export async function listWorkers(db: Database, kv: Kv, workspace: string) {
  const rows = await db
    .select()
    .from(workers)
    .where(eq(workers.workspace, workspace))
    .orderBy(asc(workers.createdAt), asc(workers.id))
    .limit(MAX_LISTED_WORKERS);
  const ids = rows.map((row) => row.id);
  const [presence, gateway] = await Promise.all([
    workerPresence(kv, ids),
    workerGatewaySettings(db, ids),
  ]);
  return rows.map((row) => {
    const seen = presence.get(row.id);
    const settings = gateway.get(row.id);
    return {
      ...workerMetadata(row),
      lastSeenAt: seen?.lastSeenAt ?? null,
      tempDirectory: seen?.tempDirectory || null,
      gateway: {
        access: settings?.access ?? ("off" as const),
        telemetry: settings?.telemetry ?? ("workspace" as KeyTelemetry),
      },
    };
  });
}

function workerMetadata(row: typeof workers.$inferSelect) {
  return {
    workerId: row.id,
    workspaceId: row.workspace,
    name: row.name,
    capabilities: row.capabilities,
    status: row.status,
    identityEpoch: row.identityEpoch,
  };
}

/** Worker: its own metadata (`worker.current`). */
export async function currentWorker(db: Database, scope: WorkerScope) {
  const [row] = await db.select().from(workers).where(eq(workers.id, scope.workerId));
  if (!row) throw new AppError("NOT_FOUND", "Worker not found.");
  return workerMetadata(row);
}

/**
 * Owner: a one-time setup code. Only the token's digest is stored. `code` is the
 * `radium-worker-v1.` code for keyless workspaces; keyed workspaces build a `radium-worker-v2.`
 * code in the browser from `bundle` plus a pairing secret the backend never sees. The bundle is
 * base64url, not encrypted: it carries the raw token.
 */
export async function createEnrollment(runtime: Runtime, workspace: string, name: string) {
  if (!runtime.config.WORKER_AUTH_PRIVATE_JWK) {
    throw new AppError("CONFLICT", "Worker authentication is not configured on this server.");
  }
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_WORKER_NAME) {
    throw new AppError("BAD_REQUEST", `Worker names must be 1 to ${MAX_WORKER_NAME} characters.`);
  }
  const { db, kv } = runtime.drivers;
  if (!(await takeToken(kv, SETUP_LIMIT, workspace))) {
    throw new AppError("CONFLICT", "Too many setup codes; try again in a minute.");
  }
  const token = randomToken();
  const expiresAt = Date.now() + ENROLLMENT_TTL_MS;
  const [row] = await db
    .insert(workerEnrollments)
    .values({
      workspace,
      tokenHash: await tokenDigest(token),
      name: trimmed,
      // Identity only; execution capabilities need a policy of their own.
      capabilities: [],
      expiresAt: new Date(expiresAt),
      state: "pending",
    })
    .returning({ id: workerEnrollments.id });
  const bundle = {
    version: 1 as const,
    backendUrl: runtime.config.API_URL,
    enrollmentId: row!.id,
    token,
    expiresAt,
  };
  const code = `radium-worker-v1.${Buffer.from(JSON.stringify(bundle)).toString("base64url")}`;
  return { code, expiresAt, enrollmentId: row!.id, bundle };
}

/** Owner: cancels an unused setup code. A used one names a Worker, which is revoked instead. */
export async function revokeEnrollment(db: Database, workspace: string, enrollmentId: string) {
  const [revoked] = await db
    .update(workerEnrollments)
    .set({ state: "revoked" })
    .where(
      and(
        eq(workerEnrollments.id, enrollmentId),
        eq(workerEnrollments.workspace, workspace),
        inArray(workerEnrollments.state, ["pending", "revoked"]),
      ),
    )
    .returning({ id: workerEnrollments.id });
  if (revoked) return;
  const [used] = await db
    .select({ id: workerEnrollments.id })
    .from(workerEnrollments)
    .where(and(eq(workerEnrollments.id, enrollmentId), eq(workerEnrollments.workspace, workspace)));
  if (used) throw new AppError("CONFLICT", "This setup code was already used; revoke the Worker.");
  throw new AppError("NOT_FOUND", "Setup code not found.");
}

/**
 * Owner: revokes a Worker in one transaction. Under the Worker row lock: status `revoked` and
 * the identity epoch advanced (once; a retry changes nothing more), so every token issued before
 * stops at its next call; its E2EE keys and pairings deleted; its Gateway key revoked and access
 * cleared; its unfinished tool tasks failed; its ACP commands, interactions and sessions failed
 * and its open epochs closed (`failWorkerAcpWork`). After commit: the key cache tombstone,
 * presence and warm sessions, the epoch stream deletions, and a signal to each chat handler
 * waiting on a failed task.
 */
export async function revokeWorker(runtime: Runtime, workspace: string, workerId: string) {
  const { db, kv } = runtime.drivers;
  const revoked = await db.transaction(async (tx) => {
    const [worker] = await tx
      .select({ status: workers.status })
      .from(workers)
      .where(and(eq(workers.id, workerId), eq(workers.workspace, workspace)))
      .for("update");
    if (!worker) throw new AppError("NOT_FOUND", "Worker not found.");
    if (worker.status === "active") {
      await tx
        .update(workers)
        .set({ status: "revoked", identityEpoch: sql`${workers.identityEpoch} + 1` })
        .where(eq(workers.id, workerId));
    }
    await deleteWorkerKeys(tx, workspace, workerId);
    const hashes = await clearWorkerGateway(tx, workerId);
    const now = new Date();
    const tasks = await tx
      .update(workerTasks)
      .set({
        status: "failed",
        terminalAt: now,
        updatedAt: now,
        revision: sql`${workerTasks.revision} + 1`,
      })
      .where(
        and(
          eq(workerTasks.worker, workerId),
          notInArray(workerTasks.status, ["failed", "success"]),
        ),
      )
      .returning({ id: workerTasks.id, chat: workerTasks.chat });
    const jobs = await failWorkerAcpWork(tx, workerId);
    return { hashes, tasks, jobs };
  });
  await Promise.all([
    invalidateApiKeys(kv, revoked.hashes),
    deleteWorkerPresence(kv, workerId),
    clearWarmSessions(kv, workerId),
  ]);
  runtime.defer(dispatchJobs(runtime, revoked.jobs));
  for (const task of revoked.tasks) {
    if (task.chat) await signalChat(runtime, task.chat, { topic: TASK_SIGNAL, ids: [task.id] });
  }
}

/** Retention: deletes up to `batch` pending or revoked setup codes past expiry plus a week. */
export async function pruneWorkerEnrollments(db: Database, now: number, batch: number) {
  const cutoff = new Date(now - WORKER_ENROLLMENT_RETENTION_MS);
  const deleted = await db
    .delete(workerEnrollments)
    .where(
      inArray(
        workerEnrollments.id,
        db
          .select({ id: workerEnrollments.id })
          .from(workerEnrollments)
          .where(
            and(
              inArray(workerEnrollments.state, ["pending", "revoked"]),
              lte(workerEnrollments.expiresAt, cutoff),
            ),
          )
          .limit(batch),
      ),
    )
    .returning({ id: workerEnrollments.id });
  return deleted.length;
}

/** Retention: deletes up to `batch` finished tool tasks five minutes after they ended. */
export async function pruneWorkerTasks(db: Database, now: number, batch: number) {
  const cutoff = new Date(now - WORKER_TASK_RETENTION_MS);
  const deleted = await db
    .delete(workerTasks)
    .where(
      inArray(
        workerTasks.id,
        db
          .select({ id: workerTasks.id })
          .from(workerTasks)
          .where(lte(workerTasks.terminalAt, cutoff))
          .limit(batch),
      ),
    )
    .returning({ id: workerTasks.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------------------------
// Machine-auth admission

/** The active Worker key `keyId` of a live `workspace`, with what a token challenge binds. */
async function verificationKey(db: Database, workspace: string, keyId: string) {
  const [row] = await db
    .select({
      workerId: workers.id,
      identityEpoch: workers.identityEpoch,
      material: workerKeys.material,
    })
    .from(workerKeys)
    .innerJoin(workers, eq(workers.id, workerKeys.worker))
    .innerJoin(workspaces, eq(workspaces.id, workers.workspace))
    .where(
      and(
        eq(workerKeys.id, keyId),
        eq(workers.workspace, workspace),
        eq(workers.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    );
  return row;
}

/** An enrollment of a live workspace. */
async function liveEnrollment(db: Database, enrollmentId: string) {
  const [row] = await db
    .select({ enrollment: workerEnrollments })
    .from(workerEnrollments)
    .innerJoin(workspaces, eq(workspaces.id, workerEnrollments.workspace))
    .where(and(eq(workerEnrollments.id, enrollmentId), isNull(workspaces.archivedAt)));
  return row?.enrollment;
}

export type ChallengeRequest =
  | { kind: "token"; workspaceId: string; workerId: string; keyId: string }
  | { kind: "enroll" | "recover"; enrollmentId: string; requestId: string; publicKey: unknown };

/**
 * Stores a one-use statement for the Worker to sign, valid for sixty seconds. `enroll` binds a
 * new public key to a setup code and a stable retry request id; `recover` binds key possession to
 * a completed setup; `token` binds the stored key and current identity epoch. Request ids are
 * selectors only: what the challenge binds comes from Postgres.
 */
export async function createChallenge(runtime: Runtime, request: ChallengeRequest) {
  if (!runtime.config.WORKER_AUTH_PRIVATE_JWK) denied();
  const { db, kv } = runtime.drivers;
  let challenge: Challenge;
  if (request.kind === "token") {
    const key = await verificationKey(db, request.workspaceId, request.keyId);
    if (!key || key.workerId !== request.workerId) denied();
    challenge = {
      kind: "token",
      workspace: request.workspaceId,
      workerId: key.workerId,
      keyId: request.keyId,
      identityEpoch: key.identityEpoch,
      material: key.material,
    };
  } else {
    if (request.requestId.length > 128) denied();
    const publicKey = await normalizeWorkerKey(request.publicKey);
    const enrollment = await liveEnrollment(db, request.enrollmentId);
    if (!enrollment) denied();
    challenge = {
      kind: request.kind,
      workspace: enrollment.workspace,
      enrollmentId: enrollment.id,
      requestId: request.requestId,
      ...publicKey,
    };
  }
  if (!(await takeToken(kv, CHALLENGE_LIMIT, challenge.workspace))) denied();
  const challengeId = randomToken();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  await kvSet(kv, challengeKey(challengeId), JSON.stringify(challenge), {
    ttlMs: CHALLENGE_TTL_MS,
  });
  return { challengeId, expiresAt, audience: runtime.config.API_URL };
}

/**
 * Admits a signed challenge. The challenge is taken (`GETDEL`) before the proof is checked, so it
 * is single use even when the proof fails. Returns the identity (enroll, recover) or an access
 * token (token).
 */
export async function completeChallenge(
  runtime: Runtime,
  request: { challengeId: string; proof: string; token?: string },
): Promise<WorkerIdentity | { token: string; expiresAt: number }> {
  const key = runtime.config.WORKER_AUTH_PRIVATE_JWK;
  if (!key) denied();
  const { db, kv } = runtime.drivers;
  const stored = await kvTake(kv, challengeKey(request.challengeId));
  if (!stored) denied();
  const challenge = JSON.parse(stored) as Challenge;
  await verifyWorkerProof(
    request.proof,
    request.challengeId,
    challenge.material,
    runtime.config.API_URL,
  );
  if ((challenge.kind === "enroll") !== (request.token !== undefined)) denied();

  if (challenge.kind === "token") {
    const current = await verificationKey(db, challenge.workspace, challenge.keyId);
    if (
      !current ||
      current.workerId !== challenge.workerId ||
      current.identityEpoch !== challenge.identityEpoch ||
      current.material !== challenge.material
    ) {
      denied();
    }
    return await issueWorkerToken(
      {
        workerId: current.workerId,
        keyId: challenge.keyId,
        workspaceId: challenge.workspace,
        identityEpoch: current.identityEpoch,
      },
      key,
      runtime.config.API_URL,
    );
  }
  if (challenge.kind === "recover") return await recordedIdentity(db, challenge);
  return await completeEnrollment(db, challenge, await tokenDigest(request.token!));
}

type EnrollChallenge = Extract<Challenge, { kind: "enroll" | "recover" }>;

/** Rolls the completion transaction back without failing the request yet. */
class NotAdmitted extends Error {}

/**
 * First use of a setup code: one transaction inserts the Worker and its key (a key that already
 * names an identity is refused) and completes the enrollment with ONE conditional update
 * (`state = 'pending'`, matching token digest, unexpired), so of two concurrent completions
 * exactly one lands. Anything else, including the loser of that race, is answered from the
 * completed receipt: a retry with the same request id and key gets the recorded identity.
 */
async function completeEnrollment(
  db: Database,
  challenge: EnrollChallenge,
  tokenHash: string,
): Promise<WorkerIdentity> {
  const enrollment = await liveEnrollment(db, challenge.enrollmentId);
  if (!enrollment || enrollment.workspace !== challenge.workspace) denied();
  if (enrollment.tokenHash !== tokenHash) denied();
  if (enrollment.state === "pending") {
    try {
      return await db.transaction(async (tx) => {
        const [worker] = await tx
          .insert(workers)
          .values({
            workspace: enrollment.workspace,
            name: enrollment.name,
            capabilities: enrollment.capabilities,
            status: "active",
            identityEpoch: 1,
          })
          .returning({ id: workers.id });
        const [key] = await tx
          .insert(workerKeys)
          .values({
            worker: worker!.id,
            algorithm: challenge.algorithm,
            material: challenge.material,
            thumbprint: challenge.thumbprint,
          })
          .onConflictDoNothing({ target: workerKeys.thumbprint })
          .returning({ id: workerKeys.id });
        if (!key) throw new NotAdmitted();
        const [completed] = await tx
          .update(workerEnrollments)
          .set({
            state: "completed",
            completionWorker: worker!.id,
            completionKey: key.id,
            completionRequestId: challenge.requestId,
          })
          .where(
            and(
              eq(workerEnrollments.id, enrollment.id),
              eq(workerEnrollments.tokenHash, tokenHash),
              eq(workerEnrollments.state, "pending"),
              gt(workerEnrollments.expiresAt, sql`now()`),
            ),
          )
          .returning({ id: workerEnrollments.id });
        if (!completed) throw new NotAdmitted();
        return {
          workerId: worker!.id,
          keyId: key.id,
          workspaceId: enrollment.workspace,
          identityEpoch: 1,
        };
      });
    } catch (error) {
      if (!(error instanceof NotAdmitted)) throw error;
    }
  }
  return await recordedIdentity(db, challenge);
}

/**
 * The identity a completed setup produced, for proof of its original key: `recover` needs the
 * key's thumbprint, an enroll retry also the same request id and key material. The Worker must
 * still be active.
 */
async function recordedIdentity(db: Database, challenge: EnrollChallenge): Promise<WorkerIdentity> {
  const [row] = await db
    .select({
      enrollment: workerEnrollments,
      key: workerKeys,
      worker: { status: workers.status, identityEpoch: workers.identityEpoch },
    })
    .from(workerEnrollments)
    .innerJoin(workspaces, eq(workspaces.id, workerEnrollments.workspace))
    .innerJoin(workerKeys, eq(workerKeys.id, workerEnrollments.completionKey))
    .innerJoin(workers, eq(workers.id, workerEnrollments.completionWorker))
    .where(
      and(
        eq(workerEnrollments.id, challenge.enrollmentId),
        eq(workerEnrollments.workspace, challenge.workspace),
        eq(workerEnrollments.state, "completed"),
        isNull(workspaces.archivedAt),
      ),
    );
  if (
    !row ||
    row.key.thumbprint !== challenge.thumbprint ||
    row.worker.status !== "active" ||
    (challenge.kind === "enroll" &&
      (row.enrollment.completionRequestId !== challenge.requestId ||
        row.key.algorithm !== challenge.algorithm ||
        row.key.material !== challenge.material))
  ) {
    denied();
  }
  return {
    workerId: row.key.worker,
    keyId: row.key.id,
    workspaceId: challenge.workspace,
    identityEpoch: row.worker.identityEpoch,
  };
}
