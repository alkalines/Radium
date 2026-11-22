import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../drivers/types";
import type { Runtime } from "../runtime";
import { jobs } from "./schema";

/**
 * Transactional outbox, the replacement for Convex `ctx.scheduler.runAfter`. A change writes its
 * follow-up work with {@link enqueueJob} in its own transaction, so the job exists exactly when
 * the change committed. After commit the request hands the ids to {@link dispatchJobs}
 * (through `runtime.defer`); the one-minute sweep ({@link sweepJobs}) runs whatever that missed
 * (crash, deploy, delayed `runAt`).
 *
 * Delivery is at least once: a runner that dies mid-job loses its claim after
 * {@link CLAIM_MS} and the job runs again. Handlers must be idempotent and finish well within
 * the claim.
 */

/** Runs one job. Throwing schedules a retry; the message is stored, so it must not hold secrets. */
export type JobHandler = (payload: unknown, runtime: Runtime) => Promise<void>;

/** Handlers by job kind. */
export type JobHandlers = Readonly<Record<string, JobHandler>>;

/** How long a claimed job is reserved for its runner. */
const CLAIM_MS = 5 * 60_000;
/** Attempts before a job is parked as failed. */
const MAX_ATTEMPTS = 8;
/** Jobs claimed (and run concurrently) per batch. */
const BATCH_SIZE = 20;
/** Batches per sweep, so one sweep stays bounded even with a large backlog. */
const MAX_SWEEP_BATCHES = 10;
/** Stored error text is cut to this length. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Queues a job in the caller's transaction. With `dedupeKey`, a job with the same key that is
 * still queued wins and this one is dropped (debounce).
 *
 * @returns the new job's id, or `null` when it was deduplicated.
 */
export async function enqueueJob(
  tx: Database,
  job: { kind: string; payload: unknown; runAt?: Date; dedupeKey?: string },
): Promise<string | null> {
  const [row] = await tx
    .insert(jobs)
    .values({ kind: job.kind, payload: job.payload, runAt: job.runAt, dedupeKey: job.dedupeKey })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

/** A job reserved for one runner by {@link claimJobs}; `attempts` includes this one. */
type ClaimedJob = { id: string; kind: string; payload: unknown; attempts: number };

/**
 * Claims up to `limit` due jobs, restricted to `ids` when given. Claiming takes a row lock with
 * `skip locked` and stamps `locked_until`, so concurrent runners (replicas, the sweep and an
 * after-commit dispatch) never get the same job.
 */
async function claimJobs(db: Database, limit: number, ids?: string[]): Promise<ClaimedJob[]> {
  const due = and(
    isNull(jobs.failedAt),
    lte(jobs.runAt, sql`now()`),
    or(isNull(jobs.lockedUntil), lte(jobs.lockedUntil, sql`now()`)),
    ids ? inArray(jobs.id, ids) : undefined,
  );
  const claimable = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(due)
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(limit)
    .for("update", { skipLocked: true });

  return await db
    .update(jobs)
    .set({
      lockedUntil: sql`now() + ${`${CLAIM_MS} milliseconds`}::interval`,
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(inArray(jobs.id, claimable))
    .returning({ id: jobs.id, kind: jobs.kind, payload: jobs.payload, attempts: jobs.attempts });
}

/** Runs one claimed job and records the outcome: deleted on success, retried or parked on failure. */
async function runJob(runtime: Runtime, job: ClaimedJob) {
  const { db } = runtime.drivers;
  try {
    const handler = runtime.jobs[job.kind];
    if (!handler) {
      throw new Error(`No handler for job kind "${job.kind}"`);
    }
    await handler(job.payload, runtime);
    await db.delete(jobs).where(eq(jobs.id, job.id));
  } catch (error) {
    const lastError = (error instanceof Error ? error.message : "Job failed").slice(
      0,
      MAX_ERROR_LENGTH,
    );
    if (job.attempts >= MAX_ATTEMPTS) {
      await db
        .update(jobs)
        .set({ lockedUntil: null, failedAt: sql`now()`, lastError })
        .where(eq(jobs.id, job.id));
      return;
    }
    // Exponential backoff from 10 s, capped at one hour.
    const delayMs = Math.min(10_000 * 2 ** (job.attempts - 1), 3_600_000);
    await db
      .update(jobs)
      .set({
        lockedUntil: null,
        runAt: sql`now() + ${`${delayMs} milliseconds`}::interval`,
        lastError,
      })
      .where(eq(jobs.id, job.id));
  }
}

/** Runs the given jobs now if they are due and unclaimed; called right after their commit. */
export async function dispatchJobs(runtime: Runtime, ids: readonly (string | null)[]) {
  const queued = ids.filter((id): id is string => id !== null);
  if (queued.length === 0) {
    return;
  }
  const claimed = await claimJobs(runtime.drivers.db, queued.length, queued);
  await Promise.all(claimed.map((job) => runJob(runtime, job)));
}

/**
 * Runs due jobs in bounded batches until none are left or the per-sweep cap is reached.
 *
 * @returns how many jobs ran (successfully or not).
 */
export async function sweepJobs(runtime: Runtime): Promise<number> {
  let ran = 0;
  for (let batch = 0; batch < MAX_SWEEP_BATCHES; batch++) {
    const claimed = await claimJobs(runtime.drivers.db, BATCH_SIZE);
    if (claimed.length === 0) {
      break;
    }
    await Promise.all(claimed.map((job) => runJob(runtime, job)));
    ran += claimed.length;
  }
  return ran;
}
