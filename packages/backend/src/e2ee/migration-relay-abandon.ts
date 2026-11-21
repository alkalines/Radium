import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../../convex/_generated/server";
import { ACP_BUSY_STATUSES } from "../acp/contract";
import { readMigrationState } from "./migration-contract";
import { activeWorkBlocker } from "./migration-relay";

/**
 * Operator-only remediation for stale legacy relay rows that block sealing (`LEGACY_RELAY_QUIESCE_*`).
 *
 * Unfinished plaintext work (pending/claimed commands, open interactions, unfinished tasks) and busy
 * or warm sessions can only be drained by the Worker that owns them, and a frozen deployment lets even
 * a live Worker do nothing. Nothing else ever ends them, so one stale row holds a seal job (and every
 * later row of its table, and the frames of its chat) forever.
 *
 * The workflow is deliberately narrow and never inferred from age or inactivity:
 * - The operator names exact rows (from `staleRelayBlockers` or a dry-run job's blocked records) and
 *   runs `abandonRelayRows` once frozen (dry runs, which write nothing, work at any time).
 * - A row qualifies only when its Worker identity is revoked or no longer exists. A Worker that is
 *   still active must be revoked first (`workers.revoke`); an active Worker is never declared dead.
 * - Qualifying rows move to a terminal state with a fixed status and code. Their content stays in
 *   place for the next seal; nothing is replayed, delivered, executed, deleted, signed or decrypted.
 * - The host-side outcome of work that was already handed to a Worker is unknown, and this workflow
 *   makes no claim about it: `ACP_ABANDONED` means "closed by an operator", not "did not run".
 */

const TABLES = ["acp_commands", "acp_interactions", "worker_tasks", "acp_sessions"] as const;
type Table = (typeof TABLES)[number];

const tableValidator = v.union(
  v.literal("acp_commands"),
  v.literal("acp_interactions"),
  v.literal("worker_tasks"),
  v.literal("acp_sessions"),
);

/**
 * Statuses of work that only its Worker can finish. Shared with `migrationStatus`
 * (`src/migration_status.ts`), whose queue gate requires none of them before the final export.
 */
export const UNFINISHED_RELAY_STATUSES = {
  acp_commands: ["pending", "claimed"],
  acp_interactions: ["pending", "answered"],
  worker_tasks: ["sent", "processing", "retrying"],
} as const;

/** Scan keys of each table; sessions have no status index, so they are paged as one `all` scan. */
const SCANS: Readonly<Record<Table, readonly string[]>> = {
  ...UNFINISHED_RELAY_STATUSES,
  acp_sessions: ["all"],
};

/** Rows per real run and rows per discovery page; both bound the Worker lookups of one call. */
export const RELAY_ABANDON_MAX_ROWS = 25;
const PAGE_MAX = 50;

type WorkerState = "active" | "revoked" | "absent";
type Blocker = "unfinished_work" | "busy_session" | "warm_session";

/** Content-free description of one blocking row and what an operator may do about it. */
export type StaleRelayBlocker = {
  table: Table;
  record: string;
  status: string;
  workspace: Id<"workspaces">;
  worker: string;
  chat?: Id<"aisdk_chats">;
  blocker: Blocker;
  workerState: WorkerState;
  /** `abandon` is allowed now; `revoke_worker_first` means the Worker identity is still active. */
  remediation: "abandon" | "revoke_worker_first";
};

type Loaded =
  | { table: "acp_commands"; doc: Doc<"acp_commands"> }
  | { table: "acp_interactions"; doc: Doc<"acp_interactions"> }
  | { table: "worker_tasks"; doc: Doc<"worker_tasks"> }
  | { table: "acp_sessions"; doc: Doc<"acp_sessions"> };

type Context = QueryCtx | MutationCtx;

function isWorkerNotFound(error: unknown): boolean {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    return typeof data === "object" && data !== null && "code" in data && data.code === "WORKER_NOT_FOUND";
  }
  // Component errors can surface as plain errors carrying the stable code in the message.
  return error instanceof Error && error.message.includes("WORKER_NOT_FOUND");
}

/** Only an identity the component confirms revoked, or reports unknown in the workspace, is dead. */
async function workerState(
  ctx: Context,
  cache: Map<string, WorkerState>,
  workspace: Id<"workspaces">,
  worker: string,
): Promise<WorkerState> {
  const key = `${workspace}:${worker}`;
  const known = cache.get(key);
  if (known) return known;
  let state: WorkerState;
  try {
    const metadata = await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId: workspace,
      workerId: worker,
    });
    state = metadata.status === "active" ? "active" : "revoked";
  } catch (error) {
    // Anything but a definite "no such Worker" (for example an unavailable component) is not proof.
    if (!isWorkerNotFound(error)) throw error;
    state = "absent";
  }
  cache.set(key, state);
  return state;
}

/** Why the row blocks sealing, or null when it does not (sealed, finished, or no plaintext). */
async function blockerOf(ctx: Context, loaded: Loaded): Promise<Blocker | null> {
  if (loaded.table === "acp_sessions") {
    const { doc } = loaded;
    if (ACP_BUSY_STATUSES.includes(doc.status)) return "busy_session";
    return doc.warm ? "warm_session" : null;
  }
  return (await activeWorkBlocker(ctx, loaded.table, loaded.doc)) ? "unfinished_work" : null;
}

async function describe(
  ctx: Context,
  cache: Map<string, WorkerState>,
  loaded: Loaded,
): Promise<StaleRelayBlocker | null> {
  const blocker = await blockerOf(ctx, loaded);
  if (!blocker) return null;
  const worker = loaded.table === "worker_tasks" ? loaded.doc.workerId : loaded.doc.worker;
  const state = await workerState(ctx, cache, loaded.doc.workspace, worker);
  const chat = loaded.table === "worker_tasks" ? loaded.doc.chatId : loaded.doc.chat;
  return {
    table: loaded.table,
    record: loaded.doc._id,
    status: loaded.doc.status,
    workspace: loaded.doc.workspace,
    worker,
    ...(chat ? { chat } : {}),
    blocker,
    workerState: state,
    remediation: state === "active" ? "revoke_worker_first" : "abandon",
  };
}

async function load(ctx: Context, table: Table, record: string): Promise<Loaded | null> {
  switch (table) {
    case "acp_commands": {
      const id = ctx.db.normalizeId("acp_commands", record);
      const doc = id ? await ctx.db.get("acp_commands", id) : null;
      return doc ? { table, doc } : null;
    }
    case "acp_interactions": {
      const id = ctx.db.normalizeId("acp_interactions", record);
      const doc = id ? await ctx.db.get("acp_interactions", id) : null;
      return doc ? { table, doc } : null;
    }
    case "worker_tasks": {
      const id = ctx.db.normalizeId("worker_tasks", record);
      const doc = id ? await ctx.db.get("worker_tasks", id) : null;
      return doc ? { table, doc } : null;
    }
    case "acp_sessions": {
      const id = ctx.db.normalizeId("acp_sessions", record);
      const doc = id ? await ctx.db.get("acp_sessions", id) : null;
      return doc ? { table, doc } : null;
    }
  }
}

/**
 * Close one qualifying row. Content fields are never read for writing or cleared: only status and
 * fixed code fields change, so the next seal still captures every byte of history.
 */
async function close(ctx: MutationCtx, loaded: Loaded, now: number): Promise<void> {
  switch (loaded.table) {
    case "acp_commands": {
      const { doc } = loaded;
      await ctx.db.patch("acp_commands", doc._id, {
        status: "failed",
        // Never overwrite an existing error: free text there is content the seal must keep.
        ...(doc.error === undefined ? { error: "ACP_ABANDONED" } : {}),
        finishedAt: now,
      });
      return;
    }
    case "acp_interactions":
      await ctx.db.patch("acp_interactions", loaded.doc._id, { status: "cancelled", resolvedAt: now });
      return;
    case "worker_tasks":
      // No `result`: a result would claim an outcome nobody observed. The revision fences any stale update.
      await ctx.db.patch("worker_tasks", loaded.doc._id, {
        status: "failed",
        revision: loaded.doc.revision + 1,
        updatedAt: now,
        terminalAt: now,
      });
      return;
    case "acp_sessions": {
      const { doc } = loaded;
      const busy = ACP_BUSY_STATUSES.includes(doc.status);
      await ctx.db.patch("acp_sessions", doc._id, {
        ...(busy ? { status: "failed" as const } : {}),
        warm: false,
        // Cooling without `clearColdChat`: the unsealed frames stay, to be sealed rather than deleted.
        cooledEpoch: Math.max(doc.cooledEpoch ?? -1, doc.epoch),
        updatedAt: now,
      });
      const chat = await ctx.db.get("aisdk_chats", doc.chat);
      if (chat) {
        await ctx.db.patch("aisdk_chats", chat._id, {
          activeStream: false,
          // A pending interruption message is content the seal must keep.
          ...(busy && !chat.interruption ? { interruption: { kind: "failed" as const } } : {}),
        });
      }
      return;
    }
  }
}

/** The status values `staleRelayBlockers` pages through, per table. */
export const relayAbandonScans = internalQuery({
  args: {},
  handler: async () => TABLES.map((table) => ({ table, statuses: SCANS[table] })),
});

/**
 * Dry-run discovery: one opaque-cursor page of rows that block sealing, with their Worker identity
 * state and remediation. Read-only and content-free (ids, statuses and counts only). Page through every
 * `relayAbandonScans` entry; cursors are returned by the pagination, never derived from timestamps.
 */
export const staleRelayBlockers = internalQuery({
  args: { table: tableValidator, status: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!SCANS[args.table].includes(args.status)) throw new Error("LEGACY_RELAY_ABANDON_UNKNOWN_SCAN");
    const opts = { ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, PAGE_MAX) };
    const loaded = await scan(ctx, args.table, args.status, opts);
    const cache = new Map<string, WorkerState>();
    const rows: (StaleRelayBlocker & { frames?: boolean })[] = [];
    for (const item of loaded.page) {
      const described = await describe(ctx, cache, item);
      if (!described) continue;
      rows.push(
        item.table === "acp_sessions"
          ? {
              ...described,
              // Frames of this chat stay blocked until the session is quiet; they are not selected directly.
              frames:
                (await ctx.db
                  .query("chat_frames")
                  .withIndex("by_chat", (q) => q.eq("chat", item.doc.chat))
                  .first()) !== null,
            }
          : described,
      );
    }
    return {
      rows,
      scanned: loaded.page.length,
      continueCursor: loaded.continueCursor,
      isDone: loaded.isDone,
    };
  },
});

type PaginationOpts = { numItems: number; cursor: string | null };

async function scan(
  ctx: QueryCtx,
  table: Table,
  status: string,
  opts: PaginationOpts,
): Promise<{ page: Loaded[]; continueCursor: string; isDone: boolean }> {
  switch (table) {
    case "acp_commands": {
      const result = await ctx.db
        .query("acp_commands")
        .withIndex("by_status", (q) => q.eq("status", status as Doc<"acp_commands">["status"]))
        .paginate(opts);
      return { ...result, page: result.page.map((doc) => ({ table, doc })) };
    }
    case "acp_interactions": {
      const result = await ctx.db
        .query("acp_interactions")
        .withIndex("by_status_and_resolvedAt", (q) =>
          q.eq("status", status as Doc<"acp_interactions">["status"]),
        )
        .paginate(opts);
      return { ...result, page: result.page.map((doc) => ({ table, doc })) };
    }
    case "worker_tasks": {
      const result = await ctx.db
        .query("worker_tasks")
        .withIndex("by_status_terminalAt", (q) =>
          q.eq("status", status as Doc<"worker_tasks">["status"]),
        )
        .paginate(opts);
      return { ...result, page: result.page.map((doc) => ({ table, doc })) };
    }
    case "acp_sessions": {
      // One session per ACP chat and no status-only index: an operator-run page of the whole table is
      // cheaper than an index every writer would pay for. `describe` keeps only busy or warm rows.
      const result = await ctx.db.query("acp_sessions").paginate(opts);
      return { ...result, page: result.page.map((doc) => ({ table, doc })) };
    }
  }
}

type Outcome =
  | "abandoned"
  | "would_abandon"
  | "missing"
  | "not_blocking"
  | "worker_active";

/**
 * Close the explicitly selected stale rows. Dry run is the default and reports the same outcomes
 * without writing. A real run requires the cutover freeze: frozen Workers cannot race it, and the
 * freeze also stops task pruning from deleting a just-closed row before it is sealed. Each row is
 * re-evaluated inside this transaction, so a row that finished, was sealed, or whose Worker is
 * still active is left untouched.
 */
export const abandonRelayRows = internalMutation({
  args: {
    rows: v.array(v.object({ table: tableValidator, record: v.string() })),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    if (args.rows.length > RELAY_ABANDON_MAX_ROWS) throw new Error("LEGACY_RELAY_ABANDON_TOO_MANY_ROWS");
    if (new Set(args.rows.map((row) => `${row.table}:${row.record}`)).size !== args.rows.length)
      throw new Error("LEGACY_RELAY_ABANDON_DUPLICATE_ROW");
    if (!dryRun) {
      const state = await readMigrationState(ctx);
      if (!state?.frozen || state.cutoverComplete) throw new Error("LEGACY_RELAY_ABANDON_REQUIRES_FREEZE");
    }

    const cache = new Map<string, WorkerState>();
    const now = Date.now();
    const results: { table: Table; record: string; outcome: Outcome; workerState?: WorkerState }[] = [];
    for (const { table, record } of args.rows) {
      const loaded = await load(ctx, table, record);
      if (!loaded) {
        results.push({ table, record, outcome: "missing" });
        continue;
      }
      const described = await describe(ctx, cache, loaded);
      if (!described) {
        results.push({ table, record, outcome: "not_blocking" });
        continue;
      }
      if (described.workerState === "active") {
        results.push({ table, record, outcome: "worker_active", workerState: "active" });
        continue;
      }
      if (!dryRun) await close(ctx, loaded, now);
      results.push({
        table,
        record,
        outcome: dryRun ? "would_abandon" : "abandoned",
        workerState: described.workerState,
      });
    }
    return { dryRun, results };
  },
});
