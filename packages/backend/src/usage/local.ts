import { v } from "convex/values";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ownedWorkspaceQuery } from "../../convex/helpers";
import { workerMutation, workerQuery } from "../worker/machine";
import {
  LOCAL_USAGE_DAY_PATTERN,
  LOCAL_USAGE_MODELS_MAX,
  LOCAL_USAGE_ROWS_PER_REPORT,
  localUsageRowValidator,
  type LocalUsageModel,
  type StoredLocalUsageModel,
} from "./local_contract";

/** Local usage storage: Worker uploads and the owner's sync status (`local_contract.ts`). */

/** Whether stored models still match a report, ignoring Radium's own estimates. */
function sameModels(stored: StoredLocalUsageModel[], reported: LocalUsageModel[]) {
  const withoutEstimates = stored.map(({ estimatedCost: _, ...model }) => model);
  return JSON.stringify(withoutEstimates) === JSON.stringify(reported);
}

/** The day this Worker has uploaded through, so it re-reads only from there. */
export const localUsageCursor = workerQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const sync = await ctx.db
      .query("local_usage_syncs")
      .withIndex("by_worker", (q) =>
        q.eq("workspace", ctx.worker.workspaceId).eq("worker", ctx.worker.workerId),
      )
      .first();
    return sync?.syncedThrough ?? null;
  },
});

/**
 * Upsert one day's session rows from the calling Worker. Unchanged rows are not rewritten, so a
 * quiet machine costs no writes. `syncedAt` is when ccusage started reading the logs: turns that
 * ended before it are inside these rows (`isTurnCovered`).
 */
export const reportLocalUsage = workerMutation({
  args: {
    day: v.string(),
    syncedAt: v.number(),
    rows: v.array(localUsageRowValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!LOCAL_USAGE_DAY_PATTERN.test(args.day)) throw new Error("Invalid usage day");
    if (args.rows.length > LOCAL_USAGE_ROWS_PER_REPORT) throw new Error("Too many usage rows");
    const workspace = ctx.worker.workspaceId;
    const worker = ctx.worker.workerId;
    const syncedAt = Math.min(args.syncedAt, Date.now());

    for (const row of args.rows) {
      // Bounded: these are machine-reported labels and counts, never content.
      const models = row.models.slice(0, LOCAL_USAGE_MODELS_MAX).map((model) => ({
        ...model,
        model: model.model.slice(0, 200),
      }));
      const agent = row.agent.slice(0, 64);
      const sessionId = row.sessionId.slice(0, 256);
      const existing = await ctx.db
        .query("local_usage")
        .withIndex("by_worker_and_sessionId_and_day", (q) =>
          q
            .eq("workspace", workspace)
            .eq("worker", worker)
            .eq("sessionId", sessionId)
            .eq("day", args.day),
        )
        .filter((q) => q.eq(q.field("agent"), agent))
        .first();
      let written: Id<"local_usage"> | undefined;
      let unpriced = models.some((model) => model.cost === undefined);
      if (existing) {
        if (existing.totalTokens !== row.totalTokens || !sameModels(existing.models, models)) {
          await ctx.db.patch(existing._id, {
            syncedAt,
            lastActivity: row.lastActivity,
            totalTokens: row.totalTokens,
            models,
          });
        } else {
          // Unchanged: price again only models never estimated (a failed or older pricing run).
          unpriced =
            !existing.priceKey &&
            existing.models.some(
              (model) => model.cost === undefined && model.estimatedCost === undefined,
            );
        }
        written = existing._id;
      } else {
        written = await ctx.db.insert("local_usage", {
          workspace,
          worker,
          agent,
          sessionId,
          day: args.day,
          syncedAt,
          lastActivity: row.lastActivity,
          totalTokens: row.totalTokens,
          models,
        });
      }
      // Models ccusage could not price get Radium's rates in a separate transaction.
      if (unpriced)
        await ctx.scheduler.runAfter(0, internal.agent_usage.priceLocalRow, { row: written });
    }
    return null;
  },
});

/** Record the end of a sync: advance the cursor, or keep it and store a short error. */
export const finishLocalUsageSync = workerMutation({
  args: { syncedThrough: v.optional(v.string()), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.syncedThrough !== undefined && !LOCAL_USAGE_DAY_PATTERN.test(args.syncedThrough))
      throw new Error("Invalid usage day");
    const workspace = ctx.worker.workspaceId;
    const worker = ctx.worker.workerId;
    const existing = await ctx.db
      .query("local_usage_syncs")
      .withIndex("by_worker", (q) => q.eq("workspace", workspace).eq("worker", worker))
      .first();
    const fields = {
      lastSyncAt: Date.now(),
      ...(args.syncedThrough ? { syncedThrough: args.syncedThrough } : {}),
      error: args.error?.slice(0, 300),
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("local_usage_syncs", { workspace, worker, ...fields });
    return null;
  },
});

/** Owner-only sync state of each Worker that has uploaded local usage, for Activity. */
export const LocalUsageSyncs = ownedWorkspaceQuery({
  args: {},
  returns: v.array(
    v.object({
      worker: v.string(),
      lastSyncAt: v.number(),
      syncedThrough: v.optional(v.string()),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("local_usage_syncs")
      .withIndex("by_worker", (q) => q.eq("workspace", ctx.workspace._id))
      .take(100);
    return rows.map(({ worker, lastSyncAt, syncedThrough, error }) => ({
      worker,
      lastSyncAt,
      ...(syncedThrough ? { syncedThrough } : {}),
      ...(error ? { error } : {}),
    }));
  },
});
