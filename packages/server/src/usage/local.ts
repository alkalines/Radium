import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  LOCAL_USAGE_DAY_PATTERN,
  LOCAL_USAGE_MODELS_MAX,
  LOCAL_USAGE_ROWS_PER_REPORT,
  localUsageModelValidator,
  localUsageRowValidator,
  type LocalUsageModel,
  type StoredLocalUsageModel,
} from "contracts/usage/local_contract";
import { z } from "zod";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { dispatchJobs, enqueueJob } from "../jobs/outbox";
import type { Runtime } from "../runtime";
import { PRICE_LOCAL_ROW_JOB } from "./prices";
import { localUsage, localUsageSyncs } from "./schema";

/**
 * Local CLI usage storage: Worker uploads of what ccusage read on the Worker's machine and each
 * Worker's sync state (`contracts/usage/local_contract`). The Worker identity is a parameter;
 * the caller (slice 6's Worker procedures) authenticated it.
 */

/** The authenticated Worker a local usage call acts for. */
export type LocalUsageWorker = { workerId: string; workspaceId: string };

/** Upper bound of a reported label before it is cut to its stored length. */
const LABEL_INPUT_MAX = 1024;
/** Models accepted per row before the stored ones are cut to `LOCAL_USAGE_MODELS_MAX`. */
const MODELS_INPUT_MAX = 256;

/** Wire bounds of {@link reportLocalUsage} for the Worker procedure (the contract plus `.max()`). */
export const localUsageReportInput = z.object({
  day: z.string().max(10),
  syncedAt: z.number(),
  rows: z
    .array(
      localUsageRowValidator.extend({
        agent: z.string().max(LABEL_INPUT_MAX),
        sessionId: z.string().max(LABEL_INPUT_MAX),
        models: z
          .array(localUsageModelValidator.extend({ model: z.string().max(LABEL_INPUT_MAX) }))
          .max(MODELS_INPUT_MAX),
      }),
    )
    .max(LOCAL_USAGE_ROWS_PER_REPORT),
});
export type LocalUsageReport = z.output<typeof localUsageReportInput>;

/** Wire bounds of {@link finishLocalUsageSync}. */
export const localUsageSyncInput = z.object({
  syncedThrough: z.string().max(10).optional(),
  error: z.string().max(LABEL_INPUT_MAX).optional(),
});
export type LocalUsageSync = z.output<typeof localUsageSyncInput>;

/** A `YYYY-MM-DD` UTC day that exists (the `date` column refuses `2026-02-30`). */
function isUsageDay(day: string) {
  if (!LOCAL_USAGE_DAY_PATTERN.test(day)) return false;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}

/** Whether stored models still match a report, ignoring Radium's own estimates. */
function sameModels(stored: StoredLocalUsageModel[], reported: LocalUsageModel[]) {
  // Field by field: `jsonb` does not keep key order, so serialized forms differ.
  return (
    stored.length === reported.length &&
    stored.every((model, index) => {
      const other = reported[index]!;
      return (
        model.model === other.model &&
        model.inputTokens === other.inputTokens &&
        model.outputTokens === other.outputTokens &&
        model.cacheReadTokens === other.cacheReadTokens &&
        model.cacheCreationTokens === other.cacheCreationTokens &&
        model.cost === other.cost
      );
    })
  );
}

/** The day this Worker has uploaded through, so it re-reads only from there. */
export async function localUsageCursor(
  db: Database,
  worker: LocalUsageWorker,
): Promise<string | null> {
  const [sync] = await db
    .select({ syncedThrough: localUsageSyncs.syncedThrough })
    .from(localUsageSyncs)
    .where(
      and(
        eq(localUsageSyncs.worker, worker.workerId),
        eq(localUsageSyncs.workspace, worker.workspaceId),
      ),
    );
  return sync?.syncedThrough ?? null;
}

/**
 * Upsert one day's session rows from the calling Worker. Unchanged rows keep their content and
 * only advance `syncedAt`: when ccusage started reading the logs, so turns that ended before it
 * are inside these rows (`isTurnCovered`). Every successful read moves it forward, so a turn whose
 * tokens were already read but ended after that read is covered by the next one. Models ccusage
 * could not price are priced by a queued job, in a transaction of its own; jobs are idempotent
 * (row lock, then the row's current models), so a job per report is harmless.
 *
 * Reports of one Worker are serialized by an advisory lock, so a retried or overlapping report
 * updates the rows the first one wrote instead of failing on the unique key.
 */
export async function reportLocalUsage(
  runtime: Runtime,
  worker: LocalUsageWorker,
  report: LocalUsageReport,
  now = Date.now(),
): Promise<void> {
  const parsed = localUsageReportInput.safeParse(report);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "Invalid usage report");
  const input = parsed.data;
  if (!isUsageDay(input.day)) throw new AppError("BAD_REQUEST", "Invalid usage day");
  for (const row of input.rows) {
    if (
      !Number.isSafeInteger(row.totalTokens) ||
      row.totalTokens < 0 ||
      !Number.isFinite(row.lastActivity)
    ) {
      throw new AppError("BAD_REQUEST", "Invalid usage row");
    }
  }
  if (!Number.isFinite(input.syncedAt)) throw new AppError("BAD_REQUEST", "Invalid usage sync");
  const syncedAt = new Date(Math.min(input.syncedAt, now));
  const workspace = worker.workspaceId;

  // Bounded: these are machine-reported labels and counts, never content.
  const rows = input.rows.map((row) => ({
    agent: row.agent.slice(0, 64),
    sessionId: row.sessionId.slice(0, 256),
    lastActivity: new Date(row.lastActivity),
    totalTokens: row.totalTokens,
    models: row.models.slice(0, LOCAL_USAGE_MODELS_MAX).map((model) => ({
      ...model,
      model: model.model.slice(0, 200),
    })),
  }));

  const jobs = await runtime.drivers.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`usage.local:${worker.workerId}`}, 0))`,
    );
    const stored =
      rows.length === 0
        ? []
        : await tx
            .select()
            .from(localUsage)
            .where(
              and(
                eq(localUsage.worker, worker.workerId),
                eq(localUsage.day, input.day),
                inArray(localUsage.sessionId, [...new Set(rows.map((row) => row.sessionId))]),
              ),
            )
            .for("update");
    const existing = new Map(stored.map((row) => [`${row.agent}\0${row.sessionId}`, row]));

    const queued: (string | null)[] = [];
    for (const row of rows) {
      const key = `${row.agent}\0${row.sessionId}`;
      const current = existing.get(key);
      let written: typeof localUsage.$inferSelect;
      let unpriced = row.models.some((model) => model.cost === undefined);
      if (!current) {
        [written] = (await tx
          .insert(localUsage)
          .values({
            workspace,
            worker: worker.workerId,
            agent: row.agent,
            sessionId: row.sessionId,
            day: input.day,
            syncedAt,
            lastActivity: row.lastActivity,
            totalTokens: row.totalTokens,
            models: row.models,
          })
          .returning()) as [typeof localUsage.$inferSelect];
      } else if (current.totalTokens !== row.totalTokens || !sameModels(current.models, row.models)) {
        [written] = (await tx
          .update(localUsage)
          .set({
            syncedAt,
            lastActivity: row.lastActivity,
            totalTokens: row.totalTokens,
            models: row.models,
          })
          .where(eq(localUsage.id, current.id))
          .returning()) as [typeof localUsage.$inferSelect];
      } else {
        written = current;
        if (syncedAt > current.syncedAt) {
          await tx.update(localUsage).set({ syncedAt }).where(eq(localUsage.id, current.id));
          written = { ...current, syncedAt };
        }
        // Unchanged: price again only models never estimated (a failed or older pricing run).
        unpriced =
          current.priceKey === null &&
          current.models.some(
            (model) => model.cost === undefined && model.estimatedCost === undefined,
          );
      }
      existing.set(key, written);
      if (unpriced) {
        queued.push(
          await enqueueJob(tx, { kind: PRICE_LOCAL_ROW_JOB, payload: { row: written.id } }),
        );
      }
    }
    return queued;
  });
  runtime.defer(dispatchJobs(runtime, jobs));
}

/** Record the end of a sync: advance the cursor, or keep it and store a short error. */
export async function finishLocalUsageSync(
  db: Database,
  worker: LocalUsageWorker,
  sync: LocalUsageSync,
  now = Date.now(),
): Promise<void> {
  const parsed = localUsageSyncInput.safeParse(sync);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "Invalid usage sync");
  const input = parsed.data;
  if (input.syncedThrough !== undefined && !isUsageDay(input.syncedThrough)) {
    throw new AppError("BAD_REQUEST", "Invalid usage day");
  }
  const lastSyncAt = new Date(now);
  const error = input.error?.slice(0, 300) ?? null;
  await db
    .insert(localUsageSyncs)
    .values({
      workspace: worker.workspaceId,
      worker: worker.workerId,
      syncedThrough: input.syncedThrough || null,
      lastSyncAt,
      error,
    })
    .onConflictDoUpdate({
      target: localUsageSyncs.worker,
      set: {
        lastSyncAt,
        error,
        ...(input.syncedThrough ? { syncedThrough: input.syncedThrough } : {}),
      },
    });
}

/** Sync state of one Worker that has uploaded local usage (owner Activity). */
export type LocalUsageSyncState = {
  worker: string;
  /** ms since epoch. */
  lastSyncAt: number;
  syncedThrough: string | null;
  error: string | null;
};

/** The sync state of each Worker of `workspace` that uploaded local usage; owners only. */
export async function listLocalUsageSyncs(
  db: Database,
  workspace: string,
): Promise<LocalUsageSyncState[]> {
  const rows = await db
    .select()
    .from(localUsageSyncs)
    .where(eq(localUsageSyncs.workspace, workspace))
    .orderBy(asc(localUsageSyncs.worker))
    .limit(100);
  return rows.map((row) => ({
    worker: row.worker,
    lastSyncAt: row.lastSyncAt.getTime(),
    syncedThrough: row.syncedThrough,
    error: row.error,
  }));
}
