import { makeFunctionReference, type NamedTableInfo, type Query } from "convex/server";
import { v, type Infer } from "convex/values";
import type { DataModel, Doc, Id, TableNames } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import type { LegacyBox, LegacyRecipient } from "./legacy-contract";

/**
 * Singleton cutover state. `generation` changes on every freeze transition, so a verification proof
 * taken under one generation can never vouch for writes admitted under another. `custodyWrites` counts
 * custody sealing commits, serializing the custody-end proof against concurrent sealing.
 */
export const migrationStateFields = {
  key: v.literal("global"),
  frozen: v.boolean(),
  generation: v.number(),
  /** Set once by `finishCutover` after an exhaustive no-plaintext proof; never cleared. */
  cutoverComplete: v.optional(v.boolean()),
  custodyState: v.union(v.literal("none"), v.literal("active"), v.literal("ended")),
  custodyWrites: v.optional(v.number()),
  /** Coalesces proof refreshes; writes during a running chain request one fresh pass. */
  telemetryRefreshGeneration: v.optional(v.number()),
  telemetryRefreshPending: v.optional(v.boolean()),
  telemetryRefreshDirty: v.optional(v.boolean()),
  keyId: v.optional(v.string()),
  publicKey: v.optional(v.bytes()),
};

export const jobKindValidator = v.union(v.literal("seal"), v.literal("release"), v.literal("verify"));
export const jobStatusValidator = v.union(
  v.literal("running"), v.literal("paused"), v.literal("blocked"), v.literal("completed"), v.literal("failed"),
);
export const custodyScopeValidator = v.union(
  v.object({ userId: v.string() }),
  v.object({ workspace: v.id("workspaces") }),
  v.object({ chat: v.id("aisdk_chats") }),
);
/** Record id and adapter/core error message only; never row content. */
export const jobIssueValidator = v.object({ record: v.string(), reason: v.string() });

/**
 * Resumable bounded job over one source table (seal/verify) or the custody registry (release).
 * Real seal/release jobs hold their cursor on any conflict or blocked row, so no row is skipped.
 * `run` fences scheduler chains: resuming bumps it and stale chains stop at their next step.
 */
export const migrationJobFields = {
  kind: jobKindValidator,
  table: v.string(),
  scope: v.optional(custodyScopeValidator),
  status: jobStatusValidator,
  /** Seal/release dry runs only count; verify jobs are always read-only and stored as dry runs. */
  dryRun: v.boolean(),
  batchSize: v.number(),
  run: v.number(),
  cursor: v.optional(v.string()),
  retries: v.number(),
  generation: v.number(),
  custodyWrites: v.number(),
  scanned: v.number(),
  changed: v.number(),
  conflicts: v.number(),
  blocked: v.number(),
  pending: v.number(),
  plaintext: v.number(),
  custody: v.number(),
  issue: v.optional(jobIssueValidator),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
};

/** Index of custody-sealed rows; `workspace` is the AAD workspace used when sealing. */
export const legacyCustodyFields = {
  table: v.string(),
  record: v.string(),
  workspace: v.optional(v.id("workspaces")),
  userId: v.optional(v.string()),
  chat: v.optional(v.id("aisdk_chats")),
};

export type MigrationState = Doc<"e2ee_migration_state">;
export type MigrationJob = Doc<"e2ee_migration_jobs">;
export type CustodyScope = Infer<typeof custodyScopeValidator>;

/** Original File Storage bytes to embed into `value[field]` before sealing. */
export type LegacyStorageSource = { id: Id<"_storage">; field: string; encoding: "text" | "base64" };

/**
 * `value` holds only formerly plaintext fields (JSON values only); `patch` clears them or writes generic
 * required placeholders. `recipient` absent seals to deployment custody. `workspace` binds the AAD.
 */
export type LegacyInspection = {
  value: Record<string, unknown>;
  patch: Record<string, unknown>;
  recipient?: LegacyRecipient;
  workspace?: Id<"workspaces">;
  userId?: string;
  storage?: LegacyStorageSource;
  /** The single hidden chat that owns the row's audience; registers the custody entry for chat-key release. */
  chat?: Id<"aisdk_chats">;
};

/**
 * Domain adapter. Both methods run in queries and again inside the core CAS mutation, so reads must be
 * bounded and deterministic. Throw for ambiguous ownership or contradictory forms; never skip silently.
 */
export type LegacyAdapter = {
  readonly tables: readonly TableNames[];
  /** Null means the row holds no legacy plaintext. A row with `legacyContent` must never inspect as plaintext. */
  inspect(ctx: QueryCtx | MutationCtx, table: string, row: Record<string, unknown>): Promise<LegacyInspection | null>;
  /** Exact current audience for a custody sidecar; undefined keeps custody until a later release run. */
  releaseRecipient(ctx: QueryCtx | MutationCtx, table: string, row: Record<string, unknown>): Promise<LegacyRecipient | undefined>;
};

/**
 * Largest legacy File Storage source one action seals. Legacy attachments are capped at 20 MiB
 * (`MAX_CHAT_FILE_BYTES`); the bound leaves headroom and keeps the roughly 10 simultaneous copies of the
 * seal pipeline [INFERENCE: estimate] inside the 512 MiB Node action. A larger source blocks its row with
 * an explicit reason, in dry runs and verification as well, and is never truncated or skipped.
 */
export const MAX_SEAL_SOURCE_BYTES = 24 * 1024 * 1024;
/** Largest serialized plaintext an action seals or reseals; text sources can grow when JSON-escaped. */
export const MAX_SEAL_PLAINTEXT_BYTES = 48 * 1024 * 1024;
/** Largest stored custody envelope a release opens: the plaintext bound plus capsule, framing and padding. */
export const MAX_SEAL_ENVELOPE_BYTES = MAX_SEAL_PLAINTEXT_BYTES + 64 * 1024;

export type JobTally = { scanned: number; changed: number; blocked: number; pending: number; plaintext: number; custody: number };
export type JobIssue = { record: string; reason: string };
export type JobRef = { job: Id<"e2ee_migration_jobs">; run: number };

/** `sourceSize` is the File Storage metadata size the page read proved; the action must read exactly that. */
export type SealCandidate = {
  record: string;
  digest: string;
  value: Record<string, unknown>;
  storage?: LegacyStorageSource;
  sourceSize?: number;
  workspace?: Id<"workspaces">;
  recipient?: LegacyRecipient;
};

export type ReleaseCandidate = {
  entry: Id<"e2ee_legacy_custody">;
  table: string;
  record: string;
  digest: string;
  workspace?: Id<"workspaces">;
  sealed: LegacyBox;
  recipient: LegacyRecipient;
};

/** Read-only action probe of a legacy source, including its physical bytes and text encoding. */
export type StorageProbe = {
  record: string;
  storage: LegacyStorageSource;
  sourceSize: number;
  countsChange: boolean;
};

/** One bounded page. Plaintext candidates exist only for real seal runs and only in action memory. */
export type JobPage = {
  table: string;
  cursor: string | null;
  continueCursor: string;
  isDone: boolean;
  tally: JobTally;
  issue?: JobIssue;
  seal: SealCandidate[];
  release: ReleaseCandidate[];
  probes: StorageProbe[];
  stale: Id<"e2ee_legacy_custody">[];
};

export type CommitOutcome = "committed" | "stale" | "conflict";
export type StepOutcome = CommitOutcome | { issue: JobIssue };

/** Error text only, bounded; callers never put row content into an error. */
export function errorReason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
}

export async function readMigrationState(ctx: QueryCtx | MutationCtx): Promise<MigrationState | null> {
  return await ctx.db.query("e2ee_migration_state").withIndex("by_key", (q) => q.eq("key", "global")).unique();
}

/** Freeze gate for app writers; the frozen window must keep data stable while sealing and verifying. */
export async function assertLegacyWritesAllowed(ctx: MutationCtx): Promise<void> {
  const state = await readMigrationState(ctx);
  if (state?.frozen) throw new Error("Writes are frozen for encryption cutover.");
}

/** Plaintext is admissible only before cutover starts; after it, plaintext writers stay disabled forever. */
export async function legacyPlaintextAllowed(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const state = await readMigrationState(ctx);
  return !state || (!state.frozen && !state.cutoverComplete);
}

export async function assertLegacyPlaintextAllowed(ctx: MutationCtx): Promise<void> {
  if (!await legacyPlaintextAllowed(ctx)) throw new Error("Plaintext writes are disabled by encryption cutover.");
}

/** True while a historical encrypted envelope owns the blob; orphan sweeps must keep it. */
export async function isLegacyStorage(ctx: QueryCtx | MutationCtx, storageId: Id<"_storage">): Promise<boolean> {
  const entry = await ctx.db.query("e2ee_legacy_storage").withIndex("by_storageId", (q) => q.eq("storageId", storageId)).first();
  return entry !== null;
}

/**
 * Removes every sidecar artifact of a source row: registered envelope storage and its custody index entry.
 * Callers deleting rows that may carry `legacyContent` must call this in the same transaction.
 */
export async function deleteLegacySidecar(ctx: MutationCtx, source: { table: string; record: string }): Promise<void> {
  const stored = await ctx.db.query("e2ee_legacy_storage")
    .withIndex("by_source", (q) => q.eq("table", source.table).eq("record", source.record)).collect();
  for (const entry of stored) {
    await ctx.db.delete("e2ee_legacy_storage", entry._id);
    // Retried cleanups may find the blob already gone; deleting a missing blob would abort the caller.
    if (await ctx.db.system.get("_storage", entry.storageId)) await ctx.storage.delete(entry.storageId);
  }
  const custody = await ctx.db.query("e2ee_legacy_custody")
    .withIndex("by_source", (q) => q.eq("table", source.table).eq("record", source.record)).collect();
  for (const entry of custody) await ctx.db.delete("e2ee_legacy_custody", entry._id);
}

/** Fields of a new job; counters start at zero and the state snapshot pins its proof generation. */
export function newJob(input: {
  kind: MigrationJob["kind"];
  table: string;
  dryRun: boolean;
  batchSize: number;
  state: MigrationState | null;
  scope?: CustodyScope;
  now: number;
}): Omit<MigrationJob, "_id" | "_creationTime"> {
  return {
    kind: input.kind,
    table: input.table,
    ...(input.scope ? { scope: input.scope } : {}),
    status: "running",
    dryRun: input.dryRun,
    batchSize: input.batchSize,
    run: 1,
    retries: 0,
    generation: input.state?.generation ?? 0,
    custodyWrites: input.state?.custodyWrites ?? 0,
    scanned: 0, changed: 0, conflicts: 0, blocked: 0, pending: 0, plaintext: 0, custody: 0,
    updatedAt: input.now,
  };
}

/** Only `e2ee_migration_node:runJob` (the 512 MiB Node action module) drives jobs; arguments are ids, never content. */
export const runJobReference = makeFunctionReference<"action", { job: Id<"e2ee_migration_jobs">; run: number }, null>(
  "e2ee_migration_node:runJob",
);

export const CUSTODY_REGISTRY_TABLE = "e2ee_legacy_custody";
export const RELEASE_BATCH_SIZE = 10;

/** Custody index entries for one release scope, or the whole index when unscoped. */
export function custodyEntries(ctx: QueryCtx | MutationCtx, scope: CustodyScope | undefined): Query<NamedTableInfo<DataModel, "e2ee_legacy_custody">> {
  const entries = ctx.db.query("e2ee_legacy_custody");
  if (!scope) return entries;
  if ("userId" in scope) return entries.withIndex("by_userId", (q) => q.eq("userId", scope.userId));
  if ("workspace" in scope) return entries.withIndex("by_workspace", (q) => q.eq("workspace", scope.workspace));
  return entries.withIndex("by_chat", (q) => q.eq("chat", scope.chat));
}

/**
 * Setup hook for identity activation, workspace key creation, and chat key creation. Schedules a scoped
 * real release only after cutover started, while custody is active, and when custody rows exist for the scope.
 */
export async function requestCustodyRelease(ctx: MutationCtx, scope: CustodyScope): Promise<Id<"e2ee_migration_jobs"> | null> {
  const state = await readMigrationState(ctx);
  if (!state || state.custodyState !== "active") return null;
  if (!state.frozen && !state.cutoverComplete) return null;

  const entry = await custodyEntries(ctx, scope).first();
  if (!entry) return null;

  const job = await ctx.db.insert("e2ee_migration_jobs", newJob({
    kind: "release", table: CUSTODY_REGISTRY_TABLE, dryRun: false, batchSize: RELEASE_BATCH_SIZE, state, scope, now: Date.now(),
  }));
  await ctx.scheduler.runAfter(0, runJobReference, { job, run: 1 });
  return job;
}
