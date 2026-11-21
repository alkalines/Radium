import {
  getFunctionName,
  paginationOptsValidator,
  type FunctionReference,
  type PaginationOptions,
} from "convex/server";
import { internal } from "../convex/_generated/api";
import { internalAction, internalQuery, type ActionCtx } from "../convex/_generated/server";
import { migrations } from "../convex/migrations";
import { secrets } from "../convex/secrets";
import { custody } from "./e2ee/migration-core";
import { UNFINISHED_RELAY_STATUSES } from "./e2ee/migration-relay-abandon";
import { maintenanceMode, type MaintenanceMode } from "./maintenance";
import { OWNERSHIP_MIGRATION_STEPS } from "./workspaces/migration";

/**
 * Read-only readiness report of the last Convex version for the final export
 * (docs/Backend_Migration/Convex_Import.md#preconditions). Every gate Convex can check is
 * evaluated in its own bounded query, so no single function approaches Convex's read limits;
 * the gates the export itself or the operator must check (secrets held, backup kept) are not here.
 */

/** Rows read per verifier page; verifiers that fan out per row get smaller pages. */
const VERIFIER_PAGE_SIZE = 100;
const VERIFIER_PAGE_SIZES: Partial<Record<VerifierName, number>> = {
  // Each balance checks every catalogue provider's legacy and current secrets.
  verifyProviderSecrets: 5,
  verifyCompletions: 50,
  // Payload documents carry telemetry content; keep a page well under the 8 MiB read limit.
  verifyTelemetryPayloads: 20,
};
/** Sample record ids kept per issue code (ids only, never content). */
const SAMPLES_PER_CODE = 3;
/** Rows counted per queue status; a full bucket reads as "at least this many". */
const QUEUE_COUNT_CAP = 25;
/** Scheduled functions read per page; documents include arguments, so pages stay small. */
const SCHEDULER_PAGE_SIZE = 200;
/** Upper bound on scheduled-function pages; reaching it reports the scan incomplete. */
const SCHEDULER_MAX_PAGES = 100;
/** Distinct function names reported for unfinished scheduled functions. */
const SCHEDULER_NAME_SAMPLES = 5;

type VerificationPage = {
  checked: number;
  continueCursor: string;
  isDone: boolean;
  pageClean: boolean;
  issues: Record<string, number>;
  samples: Record<string, string[]>;
};

type VerifierReference = FunctionReference<
  "query",
  "internal",
  { paginationOpts: PaginationOptions },
  VerificationPage
>;

const VERIFIERS = {
  verifyBalances: internal.migrations.verifyBalances,
  verifyWorkspaces: internal.migrations.verifyWorkspaces,
  verifyWorkspaceConfigurations: internal.migrations.verifyWorkspaceConfigurations,
  verifyWorkspaceCredentials: internal.migrations.verifyWorkspaceCredentials,
  verifyProviderConfigurations: internal.migrations.verifyProviderConfigurations,
  verifyKeys: internal.migrations.verifyKeys,
  verifyApiKeys: internal.migrations.verifyApiKeys,
  verifyWorkspaceSettings: internal.migrations.verifyWorkspaceSettings,
  verifyProviderSecrets: internal.migrations.verifyProviderSecrets,
  verifyMcpServers: internal.migrations.verifyMcpServers,
  verifyChatroomSettings: internal.migrations.verifyChatroomSettings,
  verifyChats: internal.migrations.verifyChats,
  verifyCompletions: internal.migrations.verifyCompletions,
  verifyTraces: internal.migrations.verifyTraces,
  verifySpans: internal.migrations.verifySpans,
  verifyTelemetryPayloads: internal.migrations.verifyTelemetryPayloads,
} satisfies Record<string, VerifierReference>;

type VerifierName = keyof typeof VERIFIERS;

/** Every Convex data migration the import requires finished, in runner order. */
const REQUIRED_MIGRATIONS = [
  ...OWNERSHIP_MIGRATION_STEPS.map((step) => internal.migrations[step]),
  internal.migrations.credentialLimits,
  internal.migrations.chatMessagesToTable,
  internal.migrations.telemetryTracesToRequests,
];

export type MigrationReport = {
  name: string;
  state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
  isDone: boolean;
  processed: number;
  error?: string;
};

export type VerifierReport = {
  checked: number;
  issues: Record<string, number>;
  samples: Record<string, string[]>;
  /** Set when a page failed; the verifier then counts as not exhausted. */
  error?: string;
};

export type E2eeReport = {
  state: {
    cutoverComplete: boolean;
    frozen: boolean;
    custodyState: "none" | "active" | "ended";
    generation: number;
  } | null;
  proof: {
    complete: boolean;
    missing: string[];
    plaintext: number;
    custody: number;
    blocked: number;
  } | null;
  latestVerify: {
    table: string;
    status: string;
    plaintext: number;
    custody: number;
    blocked: number;
  } | null;
  runningJob: boolean;
  custodyRows: boolean;
  custodySecret: boolean;
};

export type QueueReport = {
  /** `table.status` → unfinished rows, capped at {@link QUEUE_COUNT_CAP}. */
  unfinished: Record<string, number>;
  /** Code Mode approvals or questions whose deadline has not passed. */
  codeModeInteractions: boolean;
};

export type SchedulerReport = {
  /** Scheduled functions still `pending` or `inProgress`. */
  unfinished: number;
  /** Counts per function name for up to {@link SCHEDULER_NAME_SAMPLES} names; never arguments. */
  names: Record<string, number>;
  /** False when the scan stopped at {@link SCHEDULER_MAX_PAGES}. */
  complete: boolean;
};

export type MigrationStatus = {
  ready: boolean;
  failing: string[];
  maintenance: { mode: MaintenanceMode };
  migrations: MigrationReport[];
  verifiers: Record<VerifierName, VerifierReport>;
  e2ee: E2eeReport;
  queues: QueueReport;
  scheduler: SchedulerReport;
};

/**
 * E2EE residue the phase 9 `status` query does not cover: custody index rows, the custody seed
 * in the Secret Store (metadata listing only, nothing is decrypted) and any running job.
 */
export const e2eeResidue = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<Pick<E2eeReport, "runningJob" | "custodyRows" | "custodySecret">> => {
    const running = await ctx.db
      .query("e2ee_migration_jobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .first();
    const custodyRow = await ctx.db.query("e2ee_legacy_custody").first();
    const seed = await secrets.list(ctx, {
      namespace: custody.namespace,
      paginationOpts: { numItems: 1, cursor: null },
    });
    return {
      runningJob: running !== null,
      custodyRows: custodyRow !== null,
      custodySecret: seed.page.length > 0,
    };
  },
});

/** Unfinished queue rows by status index, each read bounded by {@link QUEUE_COUNT_CAP}. */
export const queueResidue = internalQuery({
  args: {},
  handler: async (ctx): Promise<QueueReport> => {
    const unfinished: Record<string, number> = {};

    for (const status of UNFINISHED_RELAY_STATUSES.acp_commands) {
      const rows = await ctx.db
        .query("acp_commands")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(QUEUE_COUNT_CAP);
      unfinished[`acp_commands.${status}`] = rows.length;
    }
    for (const status of UNFINISHED_RELAY_STATUSES.acp_interactions) {
      const rows = await ctx.db
        .query("acp_interactions")
        .withIndex("by_status_and_resolvedAt", (q) => q.eq("status", status))
        .take(QUEUE_COUNT_CAP);
      unfinished[`acp_interactions.${status}`] = rows.length;
    }
    for (const status of UNFINISHED_RELAY_STATUSES.worker_tasks) {
      const rows = await ctx.db
        .query("worker_tasks")
        .withIndex("by_status_terminalAt", (q) => q.eq("status", status))
        .take(QUEUE_COUNT_CAP);
      unfinished[`worker_tasks.${status}`] = rows.length;
    }

    const openInteraction = await ctx.db
      .query("codemode_interactions")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", Date.now()))
      .first();

    return { unfinished, codeModeInteractions: openInteraction !== null };
  },
});

/**
 * One page of this deployment's scheduled functions (a system table `convex export` leaves out).
 * Returns counts and function names of unfinished entries only, never their arguments.
 */
export const scheduledPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (
    ctx,
    args,
  ): Promise<{
    unfinished: Record<string, number>;
    continueCursor: string;
    isDone: boolean;
  }> => {
    const result = await ctx.db.system.query("_scheduled_functions").paginate(args.paginationOpts);
    const unfinished: Record<string, number> = {};
    for (const scheduled of result.page) {
      const kind = scheduled.state.kind;
      if (kind !== "pending" && kind !== "inProgress") continue;
      unfinished[scheduled.name] = (unfinished[scheduled.name] ?? 0) + 1;
    }
    return { unfinished, continueCursor: result.continueCursor, isDone: result.isDone };
  },
});

async function exhaustVerifier(ctx: ActionCtx, name: VerifierName): Promise<VerifierReport> {
  const reference: VerifierReference = VERIFIERS[name];
  const numItems = VERIFIER_PAGE_SIZES[name] ?? VERIFIER_PAGE_SIZE;
  const report: VerifierReport = { checked: 0, issues: {}, samples: {} };
  let cursor: string | null = null;

  try {
    for (;;) {
      const page: VerificationPage = await ctx.runQuery(reference, {
        paginationOpts: { numItems, cursor },
      });
      report.checked += page.checked;
      for (const [code, count] of Object.entries(page.issues)) {
        report.issues[code] = (report.issues[code] ?? 0) + count;
      }
      for (const [code, ids] of Object.entries(page.samples)) {
        const kept = report.samples[code] ?? [];
        for (const id of ids) {
          if (kept.length < SAMPLES_PER_CODE && !kept.includes(id)) kept.push(id);
        }
        report.samples[code] = kept;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  } catch (error) {
    // A page over Convex's limits must not hide the other gates; the verifier stays failing.
    report.error = error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
  }
  return report;
}

async function scanScheduler(ctx: ActionCtx): Promise<SchedulerReport> {
  const counts: Record<string, number> = {};
  let cursor: string | null = null;
  let complete = false;

  for (let pages = 0; pages < SCHEDULER_MAX_PAGES; pages++) {
    const page: { unfinished: Record<string, number>; continueCursor: string; isDone: boolean } =
      await ctx.runQuery(internal.migration_status.scheduledPage, {
        paginationOpts: { numItems: SCHEDULER_PAGE_SIZE, cursor },
      });
    for (const [name, count] of Object.entries(page.unfinished)) {
      counts[name] = (counts[name] ?? 0) + count;
    }
    if (page.isDone) {
      complete = true;
      break;
    }
    cursor = page.continueCursor;
  }

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const unfinished = ranked.reduce((total, [, count]) => total + count, 0);
  return {
    unfinished,
    names: Object.fromEntries(ranked.slice(0, SCHEDULER_NAME_SAMPLES)),
    complete,
  };
}

async function e2eeReport(ctx: ActionCtx): Promise<E2eeReport> {
  const status = await ctx.runQuery(internal.e2ee_migration.status, {});
  const residue = await ctx.runQuery(internal.migration_status.e2eeResidue, {});
  // `status` lists jobs newest first.
  const verify = status.jobs.find((job) => job.kind === "verify");

  return {
    state: status.state && {
      cutoverComplete: status.state.cutoverComplete === true,
      frozen: status.state.frozen,
      custodyState: status.state.custodyState,
      generation: status.state.generation,
    },
    proof: status.proof,
    latestVerify: verify
      ? {
          table: verify.table,
          status: verify.status,
          plaintext: verify.plaintext,
          custody: verify.custody,
          blocked: verify.blocked,
        }
      : null,
    ...residue,
  };
}

/** Names of the gates `report` fails; empty means the export may start. */
function failingGates(report: Omit<MigrationStatus, "ready" | "failing">): string[] {
  const failing: string[] = [];

  if (report.maintenance.mode !== "on") failing.push("maintenance");

  for (const migration of report.migrations) {
    if (!migration.isDone) failing.push(migration.name);
  }

  for (const [name, verifier] of Object.entries(report.verifiers)) {
    if (verifier.error !== undefined || Object.keys(verifier.issues).length > 0) {
      failing.push(`verifiers:${name}`);
    }
  }

  const { state, proof } = report.e2ee;
  if (!state?.cutoverComplete) failing.push("e2ee:cutover");
  if (state?.frozen) failing.push("e2ee:frozen");
  if (!proof?.complete || proof.plaintext !== 0 || proof.custody !== 0 || proof.blocked !== 0) {
    failing.push("e2ee:verify");
  }
  // A deployment that never installed custody (`none`) has nothing to release.
  if (state?.custodyState === "active" || report.e2ee.custodyRows || report.e2ee.custodySecret) {
    failing.push("e2ee:custody");
  }
  if (report.e2ee.runningJob) failing.push("e2ee:jobs");

  for (const [queue, count] of Object.entries(report.queues.unfinished)) {
    if (count > 0) failing.push(`queues:${queue}`);
  }
  if (report.queues.codeModeInteractions) failing.push("queues:codemode_interactions");

  if (!report.scheduler.complete || report.scheduler.unfinished > 0) failing.push("scheduler");

  return failing;
}

/**
 * Operator report: `bunx convex run migration_status:migrationStatus '{}'`. Read-only; it only
 * runs queries. `ready` is true only when every gate passes, including maintenance mode `on`.
 * Results contain counts, states, function names and record ids, never content or secrets.
 *
 * Scheduled functions are a point-in-time read: crons keep running in maintenance mode and may
 * schedule follow-ups, so a failing `scheduler` gate is re-checked in a quiet window.
 */
export const migrationStatus = internalAction({
  args: {},
  handler: async (ctx): Promise<MigrationStatus> => {
    const migrationStates = await migrations.getStatus(ctx, { migrations: REQUIRED_MIGRATIONS });
    // The component does not promise input order; report in runner order.
    const stateByName = new Map(migrationStates.map((migration) => [migration.name, migration]));
    const migrationReports: MigrationReport[] = REQUIRED_MIGRATIONS.map((reference) => {
      const name = getFunctionName(reference);
      const migration = stateByName.get(name);
      if (!migration) return { name, state: "unknown", isDone: false, processed: 0 };
      return {
        name,
        state: migration.state,
        isDone: migration.isDone,
        processed: migration.processed,
        ...(migration.error ? { error: migration.error } : {}),
      };
    });

    const verifiers = {} as Record<VerifierName, VerifierReport>;
    for (const name of Object.keys(VERIFIERS) as VerifierName[]) {
      verifiers[name] = await exhaustVerifier(ctx, name);
    }

    const report = {
      maintenance: { mode: maintenanceMode() },
      migrations: migrationReports,
      verifiers,
      e2ee: await e2eeReport(ctx),
      queues: await ctx.runQuery(internal.migration_status.queueResidue, {}),
      scheduler: await scanScheduler(ctx),
    };
    const failing = failingGates(report);
    return { ready: failing.length === 0, failing, ...report };
  },
});
