import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import {
  CUSTODY_REGISTRY_TABLE, custodyEntries, errorReason, newJob, readMigrationState, RELEASE_BATCH_SIZE, runJobReference,
} from "./migration-contract";
import { advanceProofStep, proofVerdict, referrerAudience, startProof } from "./migration-telemetry-attribution";
import { PROOF_FORMAT, proofTableValidator, type ProofTable, type TelemetryAudience } from "./migration-telemetry-contract";

/** Source rows inspected per enqueue mutation. */
const ENQUEUE_PAGE = 50;
const LIST_PAGE = 100;

const refs = {
  enqueueProofs: makeFunctionReference<"mutation", { table: ProofTable; cursor?: string }, null>("e2ee_telemetry:enqueueProofs"),
  proveNext: makeFunctionReference<"mutation", { table: ProofTable }, null>("e2ee_telemetry:proveNext"),
};

type Row = Doc<"telemetry_blobs"> | Doc<"telemetry_nodes">;

/** Current proof graph revision of a workspace; no document yet means no change was ever recorded. */
export async function graphRevision(ctx: QueryCtx | MutationCtx, workspace: Id<"workspaces">): Promise<number> {
  const document = await ctx.db.query("e2ee_telemetry_revisions")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace)).unique();
  return document?.revision ?? 0;
}

/**
 * Finished attribution proof for a custody row, or `undefined` when none is valid. A tally is
 * only trusted while writers are frozen (or cutover is complete), the freeze generation is
 * unchanged, and the workspace graph revision is unchanged since the proof was taken.
 */
export async function persistedAudience(
  ctx: QueryCtx | MutationCtx,
  table: ProofTable,
  record: string,
): Promise<TelemetryAudience | undefined> {
  const state = await readMigrationState(ctx);
  if (!state || !(state.frozen || state.cutoverComplete)) return undefined;
  const proof = await ctx.db.query("e2ee_telemetry_proofs")
    .withIndex("by_table_and_record", (q) => q.eq("table", table).eq("record", record)).unique();
  if (!proof || proof.status !== "done" || proof.generation !== state.generation) return undefined;
  // A proof without the current format predates the dedicated revision counter: an absent
  // document reads as revision 0, which must never revive a proof taken against a workspace counter.
  if (proof.proofFormat !== PROOF_FORMAT || proof.graphRevision !== await graphRevision(ctx, proof.workspace)) return undefined;
  return proof.verdict;
}

async function requireFrozen(ctx: MutationCtx) {
  const migration = await readMigrationState(ctx);
  if (!migration || !(migration.frozen || migration.cutoverComplete)) {
    throw new Error("Attribution proofs require the cutover freeze.");
  }
  return migration;
}

/**
 * Phase 1 of the persisted proof, one paginated page of a source table per mutation: every custody
 * row gets a `running` proof row for the current freeze generation (a proof from an older
 * generation or graph revision restarts, finished same-generation proofs are kept, and a `failed`
 * proof is retried by every pass). The only paginated query of the function is the source scan;
 * opaque cursors carry the position, so rows created in the same instant are never skipped.
 * Chains itself to the end of the table, then starts phase 2.
 */
export async function enqueueProofsPage(ctx: MutationCtx, args: { table: ProofTable; cursor?: string }) {
  const migration = await requireFrozen(ctx);
  const page = await ctx.db.query(args.table).paginate({ numItems: ENQUEUE_PAGE, cursor: args.cursor ?? null });
  const revisions = new Map<Id<"workspaces">, number>();
  for (const row of page.page as Row[]) {
    if (row.legacyContent?.kind !== "custody") continue;
    const existing = await ctx.db.query("e2ee_telemetry_proofs")
      .withIndex("by_table_and_record", (q) => q.eq("table", args.table).eq("record", row._id)).unique();
    let revision = revisions.get(row.workspace);
    if (revision === undefined) {
      revision = await graphRevision(ctx, row.workspace);
      revisions.set(row.workspace, revision);
    }
    const trusted = existing && existing.status !== "failed" && existing.proofFormat === PROOF_FORMAT;
    if (trusted && existing.generation === migration.generation && existing.graphRevision === revision) continue;
    const fields = {
      table: args.table, record: row._id as string, workspace: row.workspace, generation: migration.generation,
      graphRevision: revision, proofFormat: PROOF_FORMAT, status: "running" as const,
      state: startProof({ table: args.table, id: row._id }), updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace("e2ee_telemetry_proofs", existing._id, fields);
    else await ctx.db.insert("e2ee_telemetry_proofs", fields);
  }
  if (page.isDone) await ctx.scheduler.runAfter(0, refs.proveNext, { table: args.table });
  else await ctx.scheduler.runAfter(0, refs.enqueueProofs, { table: args.table, cursor: page.continueCursor });
}

/**
 * Whether the workspace still holds any custodial telemetry blob or node, i.e. whether a persisted
 * proof of its graph can matter at all. Reachability memos are fenced to the migration generation,
 * since a later freeze can add new custody even after a previous cutover.
 */
export async function holdsTelemetryCustody(ctx: QueryCtx | MutationCtx, workspace: Id<"workspaces">): Promise<boolean> {
  const held = await ctx.db.query("e2ee_legacy_custody")
    .withIndex("by_workspace_and_table", (q) => q.eq("workspace", workspace).eq("table", "telemetry_blobs")).first()
    ?? await ctx.db.query("e2ee_legacy_custody")
      .withIndex("by_workspace_and_table", (q) => q.eq("workspace", workspace).eq("table", "telemetry_nodes")).first();
  return held !== null;
}

/**
 * Hook for `finishCutover` (and any later freeze/unfreeze transition that bumps the generation):
 * custody blobs and nodes lost their finished proofs when the generation moved, so they are
 * re-proven under the current one and a release follows (see `proveNextStep`). Without it, key
 * creation after cutover could only use the bounded in-transaction proof and would leave every
 * over-budget row custodial until an operator happened to rerun `advanceProofs`. A no-op, returning
 * false, when custody is not active or no telemetry blob/node is in custody.
 */
export async function scheduleProofRefresh(ctx: MutationCtx): Promise<boolean> {
  const state = await readMigrationState(ctx);
  if (!state || state.custodyState !== "active" || !(state.frozen || state.cutoverComplete)) return false;
  const held = await ctx.db.query("e2ee_legacy_custody").withIndex("by_source", (q) => q.eq("table", "telemetry_blobs")).first()
    ?? await ctx.db.query("e2ee_legacy_custody").withIndex("by_source", (q) => q.eq("table", "telemetry_nodes")).first();
  if (!held) return false;
  if (state.telemetryRefreshPending && state.telemetryRefreshGeneration === state.generation) return false;
  await ctx.db.patch("e2ee_migration_state", state._id, {
    telemetryRefreshGeneration: state.generation, telemetryRefreshPending: true, telemetryRefreshDirty: false,
  });
  await ctx.scheduler.runAfter(0, refs.enqueueProofs, { table: "telemetry_blobs" });
  return true;
}

/**
 * Something that can change a finished proof of this workspace happened: a chat audience change,
 * a deleted referrer, or a native request that reaches custodial history (see
 * `migration-telemetry-reach.ts`, which filters unrelated captures out). Bumps the workspace graph
 * revision and coalesces a fresh proof pass, during freeze as well as after cutover.
 */
export async function invalidateTelemetryProofs(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const state = await readMigrationState(ctx);
  if (!state || state.custodyState !== "active" || !(state.frozen || state.cutoverComplete)) return;
  if (!await holdsTelemetryCustody(ctx, workspaceId)) return;
  const document = await ctx.db.query("e2ee_telemetry_revisions")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspaceId)).unique();
  const revision = (document?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("Historical telemetry revision overflow");
  if (document) await ctx.db.patch("e2ee_telemetry_revisions", document._id, { revision });
  else await ctx.db.insert("e2ee_telemetry_revisions", { workspace: workspaceId, revision });
  if (state.telemetryRefreshPending && state.telemetryRefreshGeneration === state.generation) {
    if (!state.telemetryRefreshDirty) await ctx.db.patch("e2ee_migration_state", state._id, { telemetryRefreshDirty: true });
  } else {
    await scheduleProofRefresh(ctx);
  }
}

/**
 * A chat-audience verdict is recorded on the custody index entry (a blob or node carries no chat
 * of its own), so the chat key hook `requestCustodyRelease({ chat })` finds it. Any other verdict
 * clears an earlier hint, since the audience may have changed.
 */
async function recordChatHint(ctx: MutationCtx, table: ProofTable, record: string, verdict: TelemetryAudience) {
  const entry = await ctx.db.query("e2ee_legacy_custody")
    .withIndex("by_source", (q) => q.eq("table", table).eq("record", record)).first();
  const chat = verdict.kind === "chat" ? verdict.chat : undefined;
  if (entry && entry.chat !== chat) await ctx.db.patch("e2ee_legacy_custody", entry._id, { chat });
}

/**
 * End of a proof run: one real release over the whole custody registry hands every row whose
 * audience is now proven (owner or a single chat) to its recipient; rows without a key yet, mixed
 * and unknown audiences stay custodial (`pending`). Concurrent release jobs are safe: each commit
 * re-checks the row and recipient, so the loser reports stale. The registry-wide scope is needed
 * because the keys may have been created before the proofs existed, when no hook could release.
 */
async function releaseProven(ctx: MutationCtx) {
  const state = await readMigrationState(ctx);
  if (!state || state.custodyState !== "active") return;
  if (state.telemetryRefreshPending && state.telemetryRefreshGeneration === state.generation) {
    if (state.telemetryRefreshDirty) {
      await ctx.db.patch("e2ee_migration_state", state._id, { telemetryRefreshDirty: false });
      await ctx.scheduler.runAfter(0, refs.enqueueProofs, { table: "telemetry_blobs" });
      return;
    }
    await ctx.db.patch("e2ee_migration_state", state._id, { telemetryRefreshPending: false });
  }
  if (!await custodyEntries(ctx, undefined).first()) return;
  const job = await ctx.db.insert("e2ee_migration_jobs", newJob({
    kind: "release", table: CUSTODY_REGISTRY_TABLE, dryRun: false, batchSize: RELEASE_BATCH_SIZE, state, now: Date.now(),
  }));
  await ctx.scheduler.runAfter(0, runJobReference, { job, run: 1 });
}

/**
 * A chain step failed in a way no single proof row can carry (the freeze ended mid-chain, a page
 * scan failed). The chain stops, so the coalescing flags must not keep claiming a pass is running:
 * a stuck `pending` would turn every later invalidation into a lost dirty mark. Clearing them lets
 * the next invalidation or cutover hook start a fresh pass, and `advanceProofs` restarts it by hand.
 * Called from the scheduled continuations only, after catching the error, so the write commits.
 */
async function abandonRefresh(ctx: MutationCtx) {
  const state = await readMigrationState(ctx);
  if (!state?.telemetryRefreshPending || state.telemetryRefreshGeneration !== state.generation) return;
  await ctx.db.patch("e2ee_migration_state", state._id, { telemetryRefreshPending: false, telemetryRefreshDirty: false });
}

/**
 * Phase 2: advances the first `running` proof of a table by ONE paginated scan page, persisting
 * its frontier. A proof whose source row was deleted or already released is dropped. When none
 * is left, blobs hand over to the node table; nodes end the run with one registry-wide release.
 *
 * A proof whose scan throws (for example a referrer that crosses workspaces) is marked `failed`
 * and the chain moves on, so one unprovable row can neither stall the pass nor be retried in a
 * loop. The scan reads only, so nothing of the failed attempt is written; the row simply stays
 * custodial until a later pass or `advanceProofs` restarts it.
 */
export async function proveNextStep(ctx: MutationCtx, args: { table: ProofTable }) {
  const migration = await requireFrozen(ctx);
  const proof = await ctx.db.query("e2ee_telemetry_proofs")
    .withIndex("by_table_and_status", (q) => q.eq("table", args.table).eq("status", "running")).first();
  if (!proof) {
    if (args.table === "telemetry_blobs") await ctx.scheduler.runAfter(0, refs.enqueueProofs, { table: "telemetry_nodes" });
    else await releaseProven(ctx);
    return;
  }

  const row = (await ctx.db.get(args.table, proof.record as never)) as Row | null;
  const workspace = row ? await ctx.db.get("workspaces", row.workspace) : null;
  const revision = workspace ? await graphRevision(ctx, workspace._id) : 0;
  if (!row || row.legacyContent?.kind !== "custody" || !workspace) {
    await ctx.db.delete("e2ee_telemetry_proofs", proof._id);
  } else if (proof.proofFormat !== PROOF_FORMAT || proof.generation !== migration.generation || proof.graphRevision !== revision) {
    // Never combine referrers observed under different graph revisions or freeze generations, and
    // never continue a proof taken when the revision counter lived on the workspace document.
    await ctx.db.patch("e2ee_telemetry_proofs", proof._id, {
      generation: migration.generation, graphRevision: revision, proofFormat: PROOF_FORMAT,
      state: startProof({ table: args.table, id: row._id }), verdict: undefined, updatedAt: Date.now(),
    });
  } else {
    const state = proof.state;
    const fresh = state.seen === 0 && !state.work.some((item) => item.cursor !== undefined);
    let decided: TelemetryAudience | undefined;
    try {
      // Most rows have few referrers: a complete bounded proof settles them in one step. Only
      // `over_budget` means it was incomplete; every other custody reason is already decisive.
      const quick = fresh ? await referrerAudience(ctx, workspace, { table: args.table, id: row._id }) : undefined;
      decided = quick && !(quick.kind === "custody" && quick.reason === "over_budget")
        ? quick
        : (await advanceProofStep(ctx, workspace, state)) ?? proofVerdict(state);
    } catch (error) {
      await ctx.db.patch("e2ee_telemetry_proofs", proof._id, {
        status: "failed", failure: errorReason(error), verdict: undefined, updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, refs.proveNext, { table: args.table });
      return;
    }
    await ctx.db.patch("e2ee_telemetry_proofs", proof._id, {
      status: decided ? "done" : "running",
      state: decided ? { ...state, work: [] } : state,
      verdict: decided,
      updatedAt: Date.now(),
    });
    if (decided) await recordChatHint(ctx, args.table, row._id, decided);
  }
  await ctx.scheduler.runAfter(0, refs.proveNext, { table: args.table });
}

/**
 * Operator entry point, run after the cutover freeze and the sealing runs:
 * `advanceProofs({ table: "telemetry_blobs" })`. It chains enqueue and prove steps for blobs and
 * then nodes; it never writes sealed content, it only records who may receive each custody row.
 * Re-running is idempotent, restarts proofs from an older freeze generation and retries `failed`
 * proofs (see `listUnreleasable`).
 */
export const advanceProofs = internalMutation({
  args: { table: proofTableValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await enqueueProofsPage(ctx, args);
    return null;
  },
});

/** Scheduler continuation of phase 1. A failure stops the chain and releases the coalescing flags. */
export const enqueueProofs = internalMutation({
  args: { table: proofTableValidator, cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await enqueueProofsPage(ctx, args);
    } catch (error) {
      console.error("Telemetry proof enqueue stopped:", errorReason(error));
      await abandonRefresh(ctx);
    }
    return null;
  },
});

/** Scheduler continuation of phase 2. A failure stops the chain and releases the coalescing flags. */
export const proveNext = internalMutation({
  args: { table: proofTableValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await proveNextStep(ctx, args);
    } catch (error) {
      console.error("Telemetry proof step stopped:", errorReason(error));
      await abandonRefresh(ctx);
    }
    return null;
  },
});

/**
 * Proofs for operator remediation. By default (`status` absent or `done`): custody rows no single
 * audience may receive. Mixed audiences have no automatic release: leave them custodial until
 * retention deletes the requests (the user chose not to build multi-recipient copies). With
 * `status: "failed"`: proofs whose scan threw, with the bounded failure reason; fix the cause and
 * rerun `advanceProofs`. Pass `cursor` from the previous result to continue.
 */
export const listUnreleasable = internalQuery({
  args: {
    table: proofTableValidator,
    cursor: v.optional(v.string()),
    status: v.optional(v.union(v.literal("done"), v.literal("failed"))),
  },
  returns: v.object({
    rows: v.array(v.object({ record: v.string(), workspace: v.id("workspaces"), reason: v.string() })),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const status = args.status ?? "done";
    // Only proofs of the current generation are valid; older ones are re-proven by the next refresh.
    const generation = (await readMigrationState(ctx))?.generation;
    const page = await ctx.db.query("e2ee_telemetry_proofs")
      .withIndex("by_table_and_status", (q) => q.eq("table", args.table).eq("status", status))
      .paginate({ numItems: LIST_PAGE, cursor: args.cursor ?? null });
    const rows: Array<{ record: string; workspace: Id<"workspaces">; reason: string }> = [];
    for (const proof of page.page) {
      if (status === "failed") {
        rows.push({ record: proof.record, workspace: proof.workspace, reason: proof.failure ?? "unknown" });
        continue;
      }
      if (proof.verdict?.kind !== "custody" || proof.generation !== generation) continue;
      if (proof.proofFormat !== PROOF_FORMAT || proof.graphRevision !== await graphRevision(ctx, proof.workspace)) continue;
      rows.push({ record: proof.record, workspace: proof.workspace, reason: proof.verdict.reason });
    }
    return { rows, cursor: page.isDone ? null : page.continueCursor };
  },
});
