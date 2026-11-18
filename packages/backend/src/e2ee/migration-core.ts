import {
  paginationOptsValidator,
  type GenericDatabaseReader,
  type GenericDatabaseWriter,
  type GenericDataModel,
  type GenericDocument,
} from "convex/server";
import { v, type GenericId, type Value } from "convex/values";
import { fromBase64Url, sha256, toBase64Url, utf8 } from "radium-crypto";
import type { Doc, Id, TableNames } from "../../convex/_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../../convex/_generated/server";
import { secrets } from "../../convex/secrets";
import { resumeNotificationSealingReference } from "../notifications/contract";
import { resumeDeferredCleanupReference } from "../acp/deferred-contract";
import { legacyBoxValidator, type LegacyBox, type LegacyRecipient } from "./legacy-contract";
import { domain as chat } from "./migration-chat";
import {
  CUSTODY_REGISTRY_TABLE,
  custodyScopeValidator,
  custodyEntries,
  errorReason,
  isLegacyStorage,
  jobIssueValidator,
  jobKindValidator,
  MAX_SEAL_ENVELOPE_BYTES,
  MAX_SEAL_SOURCE_BYTES,
  newJob,
  readMigrationState,
  runJobReference,
  type CommitOutcome,
  type JobIssue,
  type JobPage,
  type JobTally,
  type LegacyAdapter,
  type LegacyInspection,
  type LegacyStorageSource,
  type MigrationJob,
  type MigrationState,
  type ReleaseCandidate,
  type SealCandidate,
} from "./migration-contract";
import { domain as names } from "./migration-names";
import { domain as relay } from "./migration-relay";
import { domain as telemetry } from "./migration-telemetry";
import { scheduleProofRefresh } from "./migration-telemetry-proofs";

const custody = { namespace: "e2ee:custody" as const, name: "seed" };

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;
const MAX_CONFLICT_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const PROOF_JOB_LOOKBACK = 20;

// Every table with historical plaintext has exactly one owning adapter; a duplicate is a programming error.
const adapters: readonly LegacyAdapter[] = [chat, telemetry, relay, names];
const adapterByTable = new Map<string, LegacyAdapter>();
for (const adapter of adapters) {
  for (const table of adapter.tables) {
    if (adapterByTable.has(table)) throw new Error(`Legacy table ${table} has two adapters.`);
    adapterByTable.set(table, adapter);
  }
}

/** Every source table the exhaustive verification must cover. */
export const legacyTables: readonly TableNames[] = adapters.flatMap((adapter) => adapter.tables);

function adapterFor(table: string): LegacyAdapter {
  const adapter = adapterByTable.get(table);
  if (!adapter) throw new Error(`No legacy adapter owns table ${table}.`);
  return adapter;
}

// Registered tables are runtime strings checked against the adapter registry; only per-table typing is dropped.
function readerOf(ctx: QueryCtx | MutationCtx): GenericDatabaseReader<GenericDataModel> {
  return ctx.db as unknown as GenericDatabaseReader<GenericDataModel>;
}

function writerOf(ctx: MutationCtx): GenericDatabaseWriter<GenericDataModel> {
  return ctx.db as unknown as GenericDatabaseWriter<GenericDataModel>;
}

/** A registered source row whose `_id` is the id `normalizeId` validated for its table. */
type SourceRow = GenericDocument & { _id: GenericId<string> };

async function loadSource(ctx: QueryCtx | MutationCtx, table: string, record: string): Promise<SourceRow | null> {
  const db = readerOf(ctx);
  const id = db.normalizeId(table, record);
  if (!id) return null;
  const row = await db.get(table, id);
  return row ? { ...row, _id: id } : null;
}

function sidecarOf(row: GenericDocument): LegacyBox | undefined {
  // Every adapter table declares `legacyContent: v.optional(legacyBoxValidator)` in the schema.
  return row.legacyContent as LegacyBox | undefined;
}

/** Core-level guard: a sidecar is never overwritten by sealing, whatever an adapter reports. */
async function inspectRow(ctx: QueryCtx | MutationCtx, table: string, row: GenericDocument): Promise<LegacyInspection | null> {
  const inspection = await adapterFor(table).inspect(ctx, table, row);
  if (inspection && sidecarOf(row)) throw new Error("Row has both a legacy sidecar and plaintext.");
  return inspection;
}

/**
 * Deterministic JSON with sorted keys. Rejects values JSON cannot round-trip (bytes, non-finite numbers,
 * array holes), so sealing can never silently drop historical content.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Legacy content contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Legacy content is not plain JSON.");
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new Error("Legacy content is not plain JSON.");
}

async function fingerprint(parts: unknown): Promise<string> {
  return toBase64Url(await sha256(utf8(canonicalJson(parts))));
}

function recipientPart(recipient: LegacyRecipient | undefined) {
  if (!recipient) return null;
  const { kind, keyId, epoch } = recipient;
  return { kind, keyId, epoch, publicKey: toBase64Url(new Uint8Array(recipient.publicKey)) };
}

/** Binds a sealed copy to the exact extracted content, File Storage source, AAD workspace and recipient key. */
async function sealFingerprint(table: string, record: string, inspection: LegacyInspection, chat: Id<"aisdk_chats"> | undefined): Promise<string> {
  return await fingerprint({
    v: 1, table, record,
    value: inspection.value,
    storage: inspection.storage ?? null,
    workspace: inspection.workspace ?? null,
    userId: inspection.userId ?? null,
    chat: chat ?? null,
    recipient: recipientPart(inspection.recipient),
  });
}

/** Binds a release to the exact custody envelope being replaced and the exact new recipient key. */
async function releaseFingerprint(entry: Doc<"e2ee_legacy_custody">, sealed: LegacyBox, recipient: LegacyRecipient): Promise<string> {
  return await fingerprint({
    v: 1, entry: entry._id, table: entry.table, record: entry.record,
    workspace: entry.workspace ?? null,
    sealed: {
      kind: sealed.kind, keyId: sealed.keyId, epoch: sealed.epoch,
      box: toBase64Url(new Uint8Array(sealed.box)), storageId: sealed.storageId ?? null,
    },
    recipient: recipientPart(recipient),
  });
}

/** The committed envelope must address the recipient the fresh transaction resolved, or active custody. */
function sealedFor(sealed: LegacyBox, recipient: LegacyRecipient | undefined, state: MigrationState): boolean {
  if (!recipient) {
    return sealed.kind === "custody" && sealed.epoch === 1
      && state.custodyState === "active" && sealed.keyId === state.keyId;
  }
  return sealed.kind === recipient.kind && sealed.keyId === recipient.keyId && sealed.epoch === recipient.epoch;
}

/**
 * The chat whose key creation may release a custody row. Telemetry spans and payloads carry no chat of
 * their own; their parent trace does, so the registry entry is attributed through it. Only ids that
 * normalize to this table are used, and a trace that vanished attributes to no chat.
 */
async function chatOf(ctx: QueryCtx | MutationCtx, table: string, row: GenericDocument): Promise<Id<"aisdk_chats"> | undefined> {
  let raw: unknown = table === "aisdk_chats" ? row._id : row.chat ?? row.chatId;
  if (raw === undefined && (table === "telemetry_spans" || table === "telemetry_payloads")) {
    const traceId = typeof row.trace === "string" ? ctx.db.normalizeId("telemetry_traces", row.trace) : null;
    const trace = traceId ? await ctx.db.get("telemetry_traces", traceId) : null;
    raw = trace?.chatId;
  }
  if (typeof raw !== "string") return undefined;
  return ctx.db.normalizeId("aisdk_chats", raw) ?? undefined;
}

/** Source File Storage metadata a real seal needs; throws (blocking the row) when it cannot succeed. */
async function probeSourceStorage(ctx: QueryCtx | MutationCtx, storage: LegacyStorageSource | undefined): Promise<number | undefined> {
  if (!storage) return undefined;
  const metadata = await ctx.db.system.get("_storage", storage.id);
  if (!metadata) throw new Error("Legacy source storage is missing.");
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw new Error("Legacy source storage has invalid size metadata.");
  if (metadata.size > MAX_SEAL_SOURCE_BYTES) {
    throw new Error(`Legacy source storage is ${metadata.size} bytes, above the ${MAX_SEAL_SOURCE_BYTES} byte sealing bound.`);
  }
  return metadata.size;
}

/** A custody envelope kept in File Storage must still exist and be small enough to open and reseal. */
async function probeEnvelopeStorage(ctx: QueryCtx | MutationCtx, sealed: LegacyBox): Promise<void> {
  if (!sealed.storageId) return;
  const metadata = await ctx.db.system.get("_storage", sealed.storageId);
  if (!metadata) throw new Error("Historical envelope storage is missing.");
  if (metadata.size > MAX_SEAL_ENVELOPE_BYTES) {
    throw new Error(`Historical envelope is ${metadata.size} bytes, above the ${MAX_SEAL_ENVELOPE_BYTES} byte release bound.`);
  }
}

/** Hooks run in the unfreezing transaction and carry no content: ids and cursors only. */
async function scheduleUnfreezeHooks(ctx: MutationCtx): Promise<void> {
  await ctx.scheduler.runAfter(0, resumeNotificationSealingReference, {});
  await ctx.scheduler.runAfter(0, resumeDeferredCleanupReference, {});
}

/** Registers external envelope storage atomically with the row write; false when the blob vanished. */
async function attachSidecarStorage(ctx: MutationCtx, sealed: LegacyBox, table: string, record: string): Promise<boolean> {
  if (!sealed.storageId) {
    if (sealed.box.byteLength === 0) throw new Error("Legacy envelope is empty.");
    return true;
  }
  if (sealed.box.byteLength !== 0) throw new Error("Ambiguous legacy envelope storage.");
  if (!await ctx.db.system.get("_storage", sealed.storageId)) return false;
  await ctx.db.insert("e2ee_legacy_storage", { storageId: sealed.storageId, table, record });
  return true;
}

/** Drops a replaced envelope blob of this source only. */
async function dropSidecarStorage(ctx: MutationCtx, table: string, record: string, storageId: Id<"_storage">): Promise<void> {
  const entries = await ctx.db.query("e2ee_legacy_storage")
    .withIndex("by_source", (q) => q.eq("table", table).eq("record", record)).collect();
  for (const entry of entries) {
    if (entry.storageId === storageId) await ctx.db.delete("e2ee_legacy_storage", entry._id);
  }
  if (!await isLegacyStorage(ctx, storageId) && await ctx.db.system.get("_storage", storageId)) {
    await ctx.storage.delete(storageId);
  }
}

/** Original plaintext blobs may be shared (forks, deduplicated telemetry); delete after the last reference migrates. */
async function deleteSourceStorageIfUnreferenced(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  const file = await ctx.db.query("chat_files").withIndex("by_storageId", (q) => q.eq("storageId", storageId)).first();
  if (file) return;
  const blob = await ctx.db.query("telemetry_blobs").withIndex("by_storage", (q) => q.eq("storage", storageId)).first();
  if (blob) return;
  if (await isLegacyStorage(ctx, storageId)) return;
  if (await ctx.db.system.get("_storage", storageId)) await ctx.storage.delete(storageId);
}

/** Why the current state forbids a real (writing) job, or null when it is admissible. */
function realRunRefusal(kind: MigrationJob["kind"], state: MigrationState | null): string | null {
  if (kind === "verify") return null;
  if (!state) return "Cutover state is not initialized.";
  if (state.custodyState !== "active") return "Custody is not active.";
  if (kind === "seal" && !state.frozen) return "Sealing requires an explicit freeze.";
  if (kind === "release" && !state.frozen && !state.cutoverComplete) return "Release requires a started cutover.";
  return null;
}

/** Fences commits to the current chain of a running real job under the state it was started or resumed with. */
async function liveRealJob(
  ctx: MutationCtx,
  input: { job: Id<"e2ee_migration_jobs">; run: number },
  kind: "seal" | "release",
): Promise<{ job: MigrationJob; state: MigrationState } | null> {
  const job = await ctx.db.get("e2ee_migration_jobs", input.job);
  if (!job || job.kind !== kind || job.dryRun || job.run !== input.run || job.status !== "running") return null;
  const state = await readMigrationState(ctx);
  if (!state || realRunRefusal(kind, state)) return null;
  if (kind === "seal" && state.generation !== job.generation) return null;
  return { job, state };
}

const tallyValidator = v.object({
  scanned: v.number(),
  changed: v.number(),
  blocked: v.number(),
  pending: v.number(),
  plaintext: v.number(),
  custody: v.number(),
});

/** Reads the next page of a running job; dry runs and verification only count. */
export const loadPage = internalQuery({
  args: { job: v.id("e2ee_migration_jobs"), run: v.number() },
  handler: async (ctx, args): Promise<JobPage | null> => {
    const job = await ctx.db.get("e2ee_migration_jobs", args.job);
    if (!job || job.run !== args.run || job.status !== "running") return null;
    if (!job.dryRun) {
      const refusal = realRunRefusal(job.kind, await readMigrationState(ctx));
      if (refusal) throw new Error(refusal);
    }

    const cursor = job.cursor ?? null;
    const tally: JobTally = { scanned: 0, changed: 0, blocked: 0, pending: 0, plaintext: 0, custody: 0 };
    const seal: SealCandidate[] = [];
    const release: ReleaseCandidate[] = [];
    const probes: JobPage["probes"] = [];
    const stale: Id<"e2ee_legacy_custody">[] = [];
    let issue: JobIssue | undefined;
    const block = (record: string, error: unknown) => {
      tally.blocked += 1;
      issue ??= { record, reason: errorReason(error) };
    };

    if (job.kind === "release") {
      const result = await custodyEntries(ctx, job.scope).paginate({ cursor, numItems: job.batchSize });
      for (const entry of result.page) {
        tally.scanned += 1;
        try {
          const row = await loadSource(ctx, entry.table, entry.record);
          const sealed = row ? sidecarOf(row) : undefined;
          if (!row || sealed?.kind !== "custody") {
            stale.push(entry._id);
            continue;
          }
          await probeEnvelopeStorage(ctx, sealed);
          const recipient = await adapterFor(entry.table).releaseRecipient(ctx, entry.table, row);
          if (!recipient) {
            tally.pending += 1;
            continue;
          }
          if (job.dryRun) {
            tally.changed += 1;
            continue;
          }
          release.push({
            entry: entry._id, table: entry.table, record: entry.record,
            ...(entry.workspace ? { workspace: entry.workspace } : {}),
            sealed, recipient,
            digest: await releaseFingerprint(entry, sealed, recipient),
          });
        } catch (error) {
          block(entry.record, error);
        }
      }
      return { table: job.table, cursor, continueCursor: result.continueCursor, isDone: result.isDone, tally, issue, seal, release, probes, stale };
    }

    const result = await readerOf(ctx).query(job.table).paginate({ cursor, numItems: job.batchSize });
    for (const row of result.page) {
      tally.scanned += 1;
      const record = String(row._id);
      if (job.kind === "verify" && sidecarOf(row)?.kind === "custody") tally.custody += 1;
      try {
        const inspection = await inspectRow(ctx, job.table, row);
        if (!inspection) continue;
        if (job.kind === "verify") tally.plaintext += 1;
        // Every job kind reports what a real seal would trip over: missing or oversized source storage.
        const sourceSize = await probeSourceStorage(ctx, inspection.storage);
        const probe = inspection.storage && sourceSize !== undefined
          ? { record, storage: inspection.storage, sourceSize, countsChange: job.kind === "seal" }
          : undefined;
        if (job.kind === "verify") {
          if (probe) probes.push(probe);
          continue;
        }
        if (inspection.storage && Object.hasOwn(inspection.value, inspection.storage.field)) {
          throw new Error("Legacy storage field collides with extracted content.");
        }
        // Also proves the value is plain JSON before anything is sealed.
        const digest = await sealFingerprint(job.table, record, inspection, inspection.chat ?? await chatOf(ctx, job.table, row));
        if (job.dryRun) {
          tally.changed += 1;
          if (probe) probes.push(probe);
          continue;
        }
        seal.push({
          record, digest, value: inspection.value,
          ...(inspection.storage ? { storage: inspection.storage } : {}),
          ...(sourceSize !== undefined ? { sourceSize } : {}),
          ...(inspection.workspace ? { workspace: inspection.workspace } : {}),
          ...(inspection.recipient ? { recipient: inspection.recipient } : {}),
        });
      } catch (error) {
        block(record, error);
      }
    }
    return { table: job.table, cursor, continueCursor: result.continueCursor, isDone: result.isDone, tally, issue, seal, release, probes, stale };
  },
});

/**
 * Atomic seal commit: re-inspects the row, requires the identical extraction and recipient key, writes the
 * sidecar with the adapter patch, registers external envelope storage, and only then releases the source blob.
 */
export const commitSeal = internalMutation({
  args: {
    job: v.id("e2ee_migration_jobs"),
    run: v.number(),
    table: v.string(),
    record: v.string(),
    digest: v.string(),
    sealed: legacyBoxValidator,
  },
  handler: async (ctx, args): Promise<CommitOutcome> => {
    const live = await liveRealJob(ctx, args, "seal");
    if (!live || live.job.table !== args.table) return "conflict";
    const row = await loadSource(ctx, args.table, args.record);
    if (!row) return "stale";
    const inspection = await inspectRow(ctx, args.table, row);
    if (!inspection) return "stale";
    if (await sealFingerprint(args.table, args.record, inspection, inspection.chat ?? await chatOf(ctx, args.table, row)) !== args.digest) return "conflict";
    if (!sealedFor(args.sealed, inspection.recipient, live.state)) return "conflict";
    for (const field of Object.keys(inspection.patch)) {
      if (field === "legacyContent" || field.startsWith("_")) throw new Error("Legacy adapter patch touches a reserved field.");
    }
    if (!await attachSidecarStorage(ctx, args.sealed, args.table, args.record)) return "conflict";

    // Adapter patches hold the row's own field values or undefined; the schema validates them on write.
    const patch = { ...inspection.patch, legacyContent: args.sealed } as Record<string, Value | undefined>;
    await writerOf(ctx).patch(args.table, row._id, patch);
    const after = await loadSource(ctx, args.table, args.record);
    if (!after || await inspectRow(ctx, args.table, after)) throw new Error("Legacy adapter left plaintext after sealing.");

    if (inspection.storage) await deleteSourceStorageIfUnreferenced(ctx, inspection.storage.id);
    if (args.sealed.kind === "custody") {
      const chatId = inspection.chat ?? await chatOf(ctx, args.table, row);
      await ctx.db.insert("e2ee_legacy_custody", {
        table: args.table,
        record: args.record,
        ...(inspection.workspace ? { workspace: inspection.workspace } : {}),
        ...(inspection.userId ? { userId: inspection.userId } : {}),
        ...(chatId ? { chat: chatId } : {}),
      });
      // Invalidates every custody-end proof taken before this write.
      await ctx.db.patch("e2ee_migration_state", live.state._id, { custodyWrites: (live.state.custodyWrites ?? 0) + 1 });
    }
    return "committed";
  },
});

/** Atomic release commit: the custody envelope and resolved recipient must be exactly those the action used. */
export const commitRelease = internalMutation({
  args: {
    job: v.id("e2ee_migration_jobs"),
    run: v.number(),
    entry: v.id("e2ee_legacy_custody"),
    digest: v.string(),
    sealed: legacyBoxValidator,
  },
  handler: async (ctx, args): Promise<CommitOutcome> => {
    const live = await liveRealJob(ctx, args, "release");
    if (!live) return "conflict";
    const entry = await ctx.db.get("e2ee_legacy_custody", args.entry);
    if (!entry) return "stale";
    const row = await loadSource(ctx, entry.table, entry.record);
    const current = row ? sidecarOf(row) : undefined;
    if (!row || current?.kind !== "custody") {
      await ctx.db.delete("e2ee_legacy_custody", entry._id);
      return "stale";
    }
    const recipient = await adapterFor(entry.table).releaseRecipient(ctx, entry.table, row);
    if (!recipient) return "conflict";
    if (await releaseFingerprint(entry, current, recipient) !== args.digest) return "conflict";
    if (!sealedFor(args.sealed, recipient, live.state)) return "conflict";
    if (!await attachSidecarStorage(ctx, args.sealed, entry.table, entry.record)) return "conflict";

    await writerOf(ctx).patch(entry.table, row._id, { legacyContent: args.sealed });
    if (current.storageId) await dropSidecarStorage(ctx, entry.table, entry.record, current.storageId);
    await ctx.db.delete("e2ee_legacy_custody", entry._id);
    return "committed";
  },
});

/** Deletes an uncommitted envelope blob unless a committed row registered it. */
export const discardSidecar = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<null> => {
    if (await isLegacyStorage(ctx, args.storageId)) return null;
    if (await ctx.db.system.get("_storage", args.storageId)) await ctx.storage.delete(args.storageId);
    return null;
  },
});

/** Drops a custody index entry only after rechecking that its row no longer holds custody content. */
async function dropStaleCustodyEntry(ctx: MutationCtx, id: Id<"e2ee_legacy_custody">): Promise<void> {
  const entry = await ctx.db.get("e2ee_legacy_custody", id);
  if (!entry) return;
  const row = await loadSource(ctx, entry.table, entry.record);
  if (row && sidecarOf(row)?.kind === "custody") return;
  await ctx.db.delete("e2ee_legacy_custody", entry._id);
}

/**
 * Records a processed page. Real seal/release pages with conflicts or blocked rows keep their cursor, so the
 * page is retried (conflicts, bounded) or held for the operator (blocked rows) and no row is ever skipped.
 */
export const advance = internalMutation({
  args: {
    job: v.id("e2ee_migration_jobs"),
    run: v.number(),
    cursor: v.union(v.string(), v.null()),
    next: v.string(),
    isDone: v.boolean(),
    tally: tallyValidator,
    conflicts: v.number(),
    stale: v.array(v.id("e2ee_legacy_custody")),
    issue: v.optional(jobIssueValidator),
  },
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.db.get("e2ee_migration_jobs", args.job);
    if (!job || job.run !== args.run || job.status !== "running") return null;
    if ((job.cursor ?? null) !== args.cursor) return null;
    if (!job.dryRun) {
      for (const id of args.stale) await dropStaleCustodyEntry(ctx, id);
    }

    const now = Date.now();
    const { tally } = args;
    const holdsCursor = !job.dryRun && job.kind !== "verify" && (args.conflicts > 0 || tally.blocked > 0);
    if (holdsCursor) {
      const retry = tally.blocked === 0 && job.retries < MAX_CONFLICT_RETRIES;
      await ctx.db.patch("e2ee_migration_jobs", job._id, {
        status: retry ? "running" : "blocked",
        retries: retry ? job.retries + 1 : job.retries,
        changed: job.changed + tally.changed,
        conflicts: job.conflicts + args.conflicts,
        issue: args.issue,
        updatedAt: now,
      });
      if (retry) await ctx.scheduler.runAfter(RETRY_DELAY_MS * (job.retries + 1), runJobReference, { job: job._id, run: job.run });
      return null;
    }

    await ctx.db.patch("e2ee_migration_jobs", job._id, {
      cursor: args.next,
      retries: 0,
      scanned: job.scanned + tally.scanned,
      changed: job.changed + tally.changed,
      conflicts: job.conflicts + args.conflicts,
      blocked: job.blocked + tally.blocked,
      pending: job.pending + tally.pending,
      plaintext: job.plaintext + tally.plaintext,
      custody: job.custody + tally.custody,
      issue: job.issue ?? args.issue,
      updatedAt: now,
      ...(args.isDone ? { status: "completed" as const, completedAt: now } : {}),
    });
    if (!args.isDone) await ctx.scheduler.runAfter(0, runJobReference, { job: job._id, run: job.run });
    return null;
  },
});

export const failJob = internalMutation({
  args: { job: v.id("e2ee_migration_jobs"), run: v.number(), reason: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.db.get("e2ee_migration_jobs", args.job);
    if (!job || job.run !== args.run || job.status !== "running") return null;
    await ctx.db.patch("e2ee_migration_jobs", job._id, {
      status: "failed", issue: { record: "", reason: args.reason }, updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Operator entry point (`npx convex run e2ee_migration:startJobs`). Seal/release default to dry runs;
 * real seal requires an explicit freeze and active custody, real release a started cutover and active custody.
 * Verification is always read-only and defaults to every legacy table.
 */
export const startJobs = internalMutation({
  args: {
    kind: jobKindValidator,
    tables: v.optional(v.array(v.string())),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    scope: v.optional(custodyScopeValidator),
  },
  handler: async (ctx, args): Promise<Id<"e2ee_migration_jobs">[]> => {
    const state = await readMigrationState(ctx);
    const dryRun = args.kind === "verify" ? true : args.dryRun ?? true;
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new Error(`Batch size must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
    }
    if (!dryRun) {
      const refusal = realRunRefusal(args.kind, state);
      if (refusal) throw new Error(refusal);
    }

    let tables: string[];
    if (args.kind === "release") {
      if (args.tables) throw new Error("Release runs over the custody registry, not source tables.");
      tables = [CUSTODY_REGISTRY_TABLE];
    } else {
      if (args.scope) throw new Error("Only release jobs accept a scope.");
      tables = [...new Set(args.tables ?? legacyTables)];
      for (const table of tables) adapterFor(table);
    }

    const now = Date.now();
    const created: Id<"e2ee_migration_jobs">[] = [];
    for (const table of tables) {
      const recent = await ctx.db.query("e2ee_migration_jobs")
        .withIndex("by_kind_and_table", (q) => q.eq("kind", args.kind).eq("table", table))
        .order("desc").take(PROOF_JOB_LOOKBACK);
      const scope = canonicalJson(args.scope ?? null);
      const duplicate = recent.some((job) => job.status === "running" && job.dryRun === dryRun
        && canonicalJson(job.scope ?? null) === scope);
      if (duplicate) {
        throw new Error(`A ${args.kind} job for ${table} is already running.`);
      }
      const job = await ctx.db.insert("e2ee_migration_jobs", newJob({
        kind: args.kind, table, dryRun, batchSize, state, now, ...(args.scope ? { scope: args.scope } : {}),
      }));
      await ctx.scheduler.runAfter(0, runJobReference, { job, run: 1 });
      created.push(job);
    }
    return created;
  },
});

/** Stops a job's chain after its in-flight page; the cursor stays on the last fully processed page. */
export const pauseJob = internalMutation({
  args: { job: v.id("e2ee_migration_jobs") },
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.db.get("e2ee_migration_jobs", args.job);
    if (!job) throw new Error("Job not found.");
    if (job.status !== "running") throw new Error(`Job is ${job.status}.`);
    await ctx.db.patch("e2ee_migration_jobs", job._id, { status: "paused", updatedAt: Date.now() });
    return null;
  },
});

/**
 * Restarts a paused, blocked, failed or stuck job from its cursor. Bumping `run` fences any older chain;
 * real seal jobs re-pin the current freeze generation, which must still be frozen.
 */
export const resumeJob = internalMutation({
  args: { job: v.id("e2ee_migration_jobs") },
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.db.get("e2ee_migration_jobs", args.job);
    if (!job) throw new Error("Job not found.");
    if (job.status === "completed") throw new Error("Job is already completed.");
    const state = await readMigrationState(ctx);
    if (job.kind === "verify") {
      // A verification spans one state snapshot; a changed state needs a fresh job, not a resumed one.
      if ((state?.generation ?? 0) !== job.generation || (state?.custodyWrites ?? 0) !== job.custodyWrites) {
        throw new Error("Cutover state changed; start a new verification.");
      }
    } else if (!job.dryRun) {
      const refusal = realRunRefusal(job.kind, state);
      if (refusal) throw new Error(refusal);
    }
    const run = job.run + 1;
    await ctx.db.patch("e2ee_migration_jobs", job._id, {
      status: "running", run, retries: 0, issue: undefined, updatedAt: Date.now(),
      ...(job.kind === "seal" && state ? { generation: state.generation } : {}),
    });
    await ctx.scheduler.runAfter(0, runJobReference, { job: job._id, run });
    return null;
  },
});

type CutoverProof = {
  complete: boolean;
  missing: string[];
  plaintext: number;
  custody: number;
  blocked: number;
};

/**
 * Aggregates the latest completed verification of every legacy table. A table counts only when its proof
 * was taken under the current freeze generation and custody write count, so nothing admitted since can hide.
 */
async function currentProof(ctx: QueryCtx | MutationCtx, state: MigrationState): Promise<CutoverProof> {
  const proof: CutoverProof = { complete: true, missing: [], plaintext: 0, custody: 0, blocked: 0 };
  for (const table of legacyTables) {
    const recent = await ctx.db.query("e2ee_migration_jobs")
      .withIndex("by_kind_and_table", (q) => q.eq("kind", "verify").eq("table", table))
      .order("desc").take(PROOF_JOB_LOOKBACK);
    const latest = recent.find((job) => job.status === "completed");
    if (!latest || latest.generation !== state.generation || latest.custodyWrites !== (state.custodyWrites ?? 0)) {
      proof.complete = false;
      proof.missing.push(table);
      continue;
    }
    proof.plaintext += latest.plaintext;
    proof.custody += latest.custody;
    proof.blocked += latest.blocked;
  }
  return proof;
}

function describeProof(proof: CutoverProof): string {
  const missing = proof.missing.length ? ` unverified=${proof.missing.join(",")}` : "";
  return `plaintext=${proof.plaintext} custody=${proof.custody} blocked=${proof.blocked}${missing}`;
}

/**
 * Explicit cutover freeze switch. Every transition bumps the generation, invalidating earlier proofs and
 * pausing real seal commits until resumed. Unfreezing before cutover completes is the abort path.
 */
export const setFrozen = internalMutation({
  args: { frozen: v.boolean() },
  handler: async (ctx, args): Promise<{ frozen: boolean; generation: number }> => {
    const state = await readMigrationState(ctx);
    if (!state) {
      if (!args.frozen) return { frozen: false, generation: 0 };
      await ctx.db.insert("e2ee_migration_state", {
        key: "global", frozen: true, generation: 1, custodyState: "none", custodyWrites: 0, cutoverComplete: false,
      });
      return { frozen: true, generation: 1 };
    }
    if (state.frozen === args.frozen) return { frozen: state.frozen, generation: state.generation };
    const generation = state.generation + 1;
    await ctx.db.patch("e2ee_migration_state", state._id, { frozen: args.frozen, generation });
    if (!args.frozen) await scheduleUnfreezeHooks(ctx);
    return { frozen: args.frozen, generation };
  },
});

/**
 * Completes cutover once every legacy table verified plaintext-free under the current frozen generation.
 * Unfreezes normal encrypted writes; plaintext writers stay disabled permanently.
 */
export const finishCutover = internalMutation({
  args: {},
  handler: async (ctx): Promise<CutoverProof> => {
    const state = await readMigrationState(ctx);
    if (!state?.frozen) throw new Error("Cutover requires an explicit freeze.");
    if (state.cutoverComplete) throw new Error("Cutover is already complete.");
    const proof = await currentProof(ctx, state);
    if (!proof.complete || proof.plaintext !== 0 || proof.blocked !== 0) {
      throw new Error(`No exhaustive plaintext-free proof: ${describeProof(proof)}`);
    }
    await ctx.db.patch("e2ee_migration_state", state._id, {
      frozen: false, cutoverComplete: true, generation: state.generation + 1,
    });
    // The generation bump invalidated every persisted telemetry proof; held notification sealing resumes.
    await scheduleUnfreezeHooks(ctx);
    await scheduleProofRefresh(ctx);
    return proof;
  },
});

/**
 * Destroys the custody seed. Requires a current exhaustive proof of zero plaintext and zero custody rows
 * plus an empty custody index; reading the state document serializes this against concurrent custody writes.
 */
export const endCustody = internalMutation({
  args: {},
  handler: async (ctx): Promise<CutoverProof> => {
    const state = await readMigrationState(ctx);
    if (!state || state.custodyState !== "active") throw new Error("Custody is not active.");
    if (!state.frozen && !state.cutoverComplete) throw new Error("Custody can end only after cutover started.");
    const proof = await currentProof(ctx, state);
    if (!proof.complete || proof.plaintext !== 0 || proof.custody !== 0 || proof.blocked !== 0) {
      throw new Error(`No exhaustive custody-free proof: ${describeProof(proof)}`);
    }
    if (await ctx.db.query("e2ee_legacy_custody").first()) throw new Error("Custody index still lists envelopes.");
    await secrets.remove(ctx, custody);
    await ctx.db.patch("e2ee_migration_state", state._id, { custodyState: "ended", publicKey: undefined });
    return proof;
  },
});

/**
 * Operator custody inventory for one account, workspace or chat (or the whole registry), paginated over
 * the same index releases use. `pageCount` counts this page only; the exhaustive total comes from verify jobs.
 * Returns locators only, never envelopes or keys.
 */
export const custodialRows = internalQuery({
  args: { scope: v.optional(custodyScopeValidator), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<{
    page: { table: string; record: string; userId?: string; workspace?: Id<"workspaces">; chat?: Id<"aisdk_chats"> }[];
    pageCount: number;
    continueCursor: string;
    isDone: boolean;
  }> => {
    const result = await custodyEntries(ctx, args.scope).paginate(args.paginationOpts);
    const page = result.page.map((entry) => ({
      table: entry.table,
      record: entry.record,
      ...(entry.userId ? { userId: entry.userId } : {}),
      ...(entry.workspace ? { workspace: entry.workspace } : {}),
      ...(entry.chat ? { chat: entry.chat } : {}),
    }));
    return { page, pageCount: page.length, continueCursor: result.continueCursor, isDone: result.isDone };
  },
});

/** Operator summary: state, current proof and recent jobs. Contains counts and record ids only. */
export const status = internalQuery({
  args: {},
  handler: async (ctx): Promise<{
    state: Omit<MigrationState, "_id" | "_creationTime" | "publicKey"> | null;
    proof: CutoverProof | null;
    jobs: MigrationJob[];
  }> => {
    const state = await readMigrationState(ctx);
    const jobs = await ctx.db.query("e2ee_migration_jobs").order("desc").take(50);
    if (!state) return { state: null, proof: null, jobs };
    const { _id, _creationTime, publicKey, ...summary } = state;
    return { state: summary, proof: await currentProof(ctx, state), jobs };
  },
});

/** The state and Secret Store writes share a transaction, preventing concurrent replacement. */
export const installCustody = internalMutation({
  args: { keyId: v.string(), publicKey: v.bytes(), seed: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const state = await readMigrationState(ctx);
    if (state && state.custodyState !== "none") throw new Error("Custody has already been initialized or ended.");
    const existing = await secrets.get(ctx, custody);
    if (existing.ok || existing.reason !== "not_found") throw new Error("Custody secret already exists or is unavailable.");
    await secrets.put(ctx, { ...custody, value: args.seed, metadata: { kind: "e2ee" } });
    const fields = { custodyState: "active" as const, keyId: args.keyId, publicKey: args.publicKey };
    if (state) await ctx.db.patch("e2ee_migration_state", state._id, fields);
    else await ctx.db.insert("e2ee_migration_state", { key: "global", frozen: false, generation: 0, custodyWrites: 0, cutoverComplete: false, ...fields });
    return null;
  },
});

/** Public custody recipient used only by trusted backend actions. */
export const custodyPublicKey = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ keyId: string; publicKey: ArrayBuffer }> => {
    const state = await readMigrationState(ctx);
    if (!state || state.custodyState !== "active" || !state.keyId || !state.publicKey) throw new Error("Custody is unavailable.");
    return { keyId: state.keyId, publicKey: state.publicKey };
  },
});

/** Seed access is limited to internal actions and rejects stale or ended key IDs. */
export const custodySeed = internalQuery({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<ArrayBuffer> => {
    const state = await readMigrationState(ctx);
    if (!state || state.custodyState !== "active" || state.keyId !== args.keyId) throw new Error("Custody key is unavailable.");
    const secret = await secrets.get(ctx, custody);
    if (!secret.ok) throw new Error("Custody key is unavailable.");
    const seed = fromBase64Url(secret.value);
    if (seed.length !== 32) throw new Error("Custody key is invalid.");
    return seed.slice().buffer;
  },
});
