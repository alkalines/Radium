import { eq } from "drizzle-orm";
import type { LimitObservation, LimitSettings, Meter } from "contracts/limits/meters";
import type { Database } from "../../drivers/types";
import { enqueueJob } from "../../jobs/outbox";
import type { Runtime } from "../../runtime";
import { credentialSpendSince } from "../../usage/completions";
import { readWorkspaceSettings } from "../../workspaces/settings";
import { credentialDisplayName, type CredentialRow } from "../credentials";
import { providerContextFor, type ProviderContext } from "../providers";
import { credentialLimits, workspaceCredentials } from "../schema";
import type { LimitAdapter } from "./adapter";
import { limitAdapter } from "./adapters";
import { recordLimitEvent, type LimitEvent } from "./events";
import {
  evaluateAlerts,
  mergeMeters,
  periodEnd,
  periodStart,
  resolveLimitSettings,
  shouldSkipWrite,
} from "./meters";

/** Meter ID of the owner's metered budget. */
export const BUDGET_METER = "budget";
/** Outbox job kind that recomputes one credential's budget meter (`payload: { credential }`). */
export const BUDGET_JOB = "limits.budget";
/** Completions arriving within this window share one budget recompute. */
const BUDGET_DEBOUNCE_MS = 5_000;
/**
 * A budget mark older than this without its recompute having run means the job was lost (a
 * completion that arrived while the recompute ran, or a parked job); the poll task recomputes it.
 */
export const BUDGET_PENDING_TIMEOUT_MS = 60_000;

/** One credential's usage-limit snapshot row. */
export type LimitRow = typeof credentialLimits.$inferSelect;

/**
 * A credential's snapshot row, locked for the rest of the transaction, with everything a
 * snapshot update needs: the credential, its provider and the workspace thresholds.
 */
export type SnapshotTarget = {
  row: LimitRow;
  credential: CredentialRow;
  provider: ProviderContext | null;
  adapter: LimitAdapter | undefined;
  providerName: string;
  settings: LimitSettings;
};

export type SnapshotUpdate = {
  observation?: LimitObservation & {
    /** A poll: drop upstream meters it no longer reports (except `retain`). */
    complete?: boolean;
    retain?: string[];
    /** From real traffic: subject to write throttling and marks `passiveAt`. */
    passive?: boolean;
  };
  /** Meter IDs to drop (budget cleared, limit key removed). */
  removeMeters?: string[];
  /** Credential health learned from an attempt or poll. */
  health?: { ok: true } | { ok: false; status: number; detail?: string };
  /** Other row fields to write (`null` clears one); any field forces the write. */
  fields?: Partial<Omit<LimitRow, "id" | "credential" | "createdAt">>;
};

/** A new snapshot row; the poll job picks pollable ones up immediately. */
async function insertLimitRow(
  db: Database,
  credential: string,
  adapter: LimitAdapter | undefined,
  now: number,
) {
  await db
    .insert(credentialLimits)
    .values({
      credential,
      updatedAt: new Date(now),
      nextPollAt: adapter?.poll ? new Date(now) : null,
    })
    .onConflictDoNothing({ target: credentialLimits.credential });
}

/**
 * Creates the snapshot row of a new credential (a pollable provider's row is due for polling
 * now). Call it in the transaction that inserts the credential; repeating it changes nothing.
 */
export async function ensureCredentialLimits(
  db: Database,
  credential: CredentialRow,
  now = Date.now(),
) {
  const provider = await providerContextFor(db, credential.workspace, credential.provider);
  const adapter = provider ? limitAdapter(provider.snapshot) : undefined;
  await insertLimitRow(db, credential.id, adapter, now);
}

/**
 * Loads the credential and locks its snapshot row (`for update`) for the transaction, creating
 * the row when missing. Every writer of a snapshot goes through here: the lock serializes
 * passive reports, polls, budget recomputes and owner changes of one credential, so none loses
 * another's meters. The credential row is held `for key share` so a concurrent delete cannot
 * orphan the row; `null` when the credential is gone.
 */
export async function lockSnapshot(
  tx: Database,
  credentialId: string,
  now: number,
): Promise<SnapshotTarget | null> {
  const [credential] = await tx
    .select()
    .from(workspaceCredentials)
    .where(eq(workspaceCredentials.id, credentialId))
    .for("key share");
  if (!credential) {
    return null;
  }

  const provider = await providerContextFor(tx, credential.workspace, credential.provider);
  const adapter = provider ? limitAdapter(provider.snapshot) : undefined;
  const lockRow = () =>
    tx
      .select()
      .from(credentialLimits)
      .where(eq(credentialLimits.credential, credentialId))
      .for("update");
  let [row] = await lockRow();
  if (!row) {
    await insertLimitRow(tx, credentialId, adapter, now);
    [row] = await lockRow();
  }

  const settings = await readWorkspaceSettings(tx, credential.workspace);
  return {
    row: row!,
    credential,
    provider,
    adapter,
    providerName: provider?.snapshot.name ?? credential.provider,
    settings: resolveLimitSettings(settings?.limits),
  };
}

/**
 * Applies one observation to a locked snapshot: merges meters, evaluates thresholds with
 * hysteresis, tracks credential expiry and records the resulting events. Passive-only updates
 * are throttled (see `shouldSkipWrite`) unless an alert or other state changed.
 */
export async function updateSnapshot(
  tx: Database,
  target: SnapshotTarget,
  update: SnapshotUpdate,
  now: number,
) {
  const { row, settings } = target;
  const previous = row.meters;
  let meters = previous;
  if (update.removeMeters?.length) {
    const removed = new Set(update.removeMeters);
    meters = meters.filter((meter) => !removed.has(meter.id));
  }
  const observation = update.observation;
  if (observation) {
    meters = mergeMeters(meters, observation.meters, {
      complete: observation.complete,
      retain: observation.retain,
    });
  }
  const plan = observation?.plan ?? row.plan;
  const { alerts, transitions } = evaluateAlerts(previous, meters, row.alerts, settings);

  let expiredAt = row.expiredAt;
  const healthEvents: Array<Pick<LimitEvent, "kind" | "status" | "detail">> = [];
  if (update.health?.ok && expiredAt !== null) {
    expiredAt = null;
    healthEvents.push({ kind: "credential_restored" });
  } else if (update.health && !update.health.ok && expiredAt === null) {
    expiredAt = new Date(now);
    healthEvents.push({
      kind: "credential_expired",
      status: update.health.status,
      detail: update.health.detail,
    });
  }

  const stateChanged =
    transitions.length > 0 ||
    healthEvents.length > 0 ||
    plan !== row.plan ||
    meters.length !== previous.length ||
    JSON.stringify(alerts) !== JSON.stringify(row.alerts) ||
    update.fields !== undefined;
  if (
    observation?.passive &&
    shouldSkipWrite({
      previous,
      next: meters,
      lastWriteAt: row.updatedAt.getTime(),
      now,
      stateChanged,
    })
  ) {
    return;
  }

  await tx
    .update(credentialLimits)
    .set({
      meters,
      plan,
      alerts,
      expiredAt,
      updatedAt: new Date(now),
      ...(observation?.passive ? { passiveAt: new Date(now) } : {}),
      ...update.fields,
    })
    .where(eq(credentialLimits.id, row.id));

  const base = eventBase(target, { meters, plan: plan ?? undefined }, now);
  for (const transition of transitions) {
    await recordLimitEvent(tx, { ...base, ...transition });
  }
  for (const event of healthEvents) {
    await recordLimitEvent(tx, { ...base, ...event });
  }
}

/** Identity and snapshot fields shared by every event of one credential. */
export function eventBase(
  target: SnapshotTarget,
  snapshot: { meters: Meter[]; plan?: string },
  now: number,
) {
  return {
    workspace: target.credential.workspace,
    provider: { slug: target.credential.provider, name: target.providerName },
    credential: { id: target.credential.id, name: credentialDisplayName(target.credential) },
    snapshot: {
      meters: snapshot.meters,
      ...(snapshot.plan !== undefined ? { plan: snapshot.plan } : {}),
    },
    settings: target.settings,
    occurredAt: now,
  };
}

/** Stores the plan an OAuth login reported; later headers and polls replace it with live data. */
export async function recordLoginPlan(db: Database, credentialId: string, plan: string) {
  await db.transaction(async (tx) => {
    const target = await lockSnapshot(tx, credentialId, Date.now());
    if (target && target.row.plan !== plan) {
      await tx.update(credentialLimits).set({ plan }).where(eq(credentialLimits.id, target.row.id));
    }
  });
}

/**
 * Records the limit side of one routed attempt (from routing's report): meters captured from the
 * upstream response, and credential health (401 expires it, a success restores it). The first
 * attempt of a credential creates its row, so idle credentials are polled afterwards. Events and
 * notifications it causes commit with the snapshot.
 */
export async function recordAttemptLimits(
  runtime: Runtime,
  args: {
    credential: string;
    observation?: LimitObservation;
    outcome: { type: "success" } | { type: "failure"; status?: number; message: string };
  },
  now = Date.now(),
) {
  const { db } = runtime.drivers;
  const outcome = args.outcome;
  const unauthorized = outcome.type === "failure" && outcome.status === 401;

  // Most attempts change nothing; skip the transaction and its row lock for them.
  const [stored] = await db
    .select({ expiredAt: credentialLimits.expiredAt })
    .from(credentialLimits)
    .where(eq(credentialLimits.credential, args.credential));
  const healthChange =
    stored === undefined ||
    (outcome.type === "success" && stored.expiredAt !== null) ||
    (unauthorized && stored.expiredAt === null);
  if (!args.observation?.meters.length && !args.observation?.plan && !healthChange) {
    return;
  }

  await db.transaction(async (tx) => {
    const target = await lockSnapshot(tx, args.credential, now);
    if (!target) {
      return;
    }
    await updateSnapshot(
      tx,
      target,
      {
        ...(args.observation ? { observation: { ...args.observation, passive: true } } : {}),
        ...(outcome.type === "success"
          ? { health: { ok: true } }
          : unauthorized
            ? { health: { ok: false, status: 401, detail: outcome.message } }
            : {}),
      },
      now,
    );
  });
}

/**
 * The metered budget meter: Radium's recorded cost for the credential in the current period.
 * `undefined` without a budget, or while any completion of the period has an unknown cost (a
 * partial sum must not pass for the budget).
 */
async function budgetMeter(
  db: Database,
  credential: CredentialRow,
  now: number,
): Promise<Meter | undefined> {
  if (credential.budgetAmount === null || credential.budgetPeriod === null) {
    return undefined;
  }
  const start = periodStart(credential.budgetPeriod, now);
  const end = periodEnd(credential.budgetPeriod, now);
  const used = await credentialSpendSince(db, credential.id, new Date(start));
  if (used === null) {
    return undefined;
  }
  return {
    id: BUDGET_METER,
    label: `Budget (${credential.budgetPeriod})`,
    scope: "credential",
    unit: "usd",
    used,
    limit: credential.budgetAmount,
    windowSeconds: (end - start) / 1000,
    resetsAt: end,
    source: "metered",
    observedAt: now,
  };
}

/**
 * Recomputes (or, without a budget, removes) the credential's budget meter, fires thresholds and
 * clears the pending mark. Reads the credential fresh, so call it after changing the budget in
 * the same transaction. A credential that is gone is skipped.
 */
export async function refreshBudget(tx: Database, credentialId: string, now = Date.now()) {
  const target = await lockSnapshot(tx, credentialId, now);
  if (!target) {
    return;
  }
  const meter = await budgetMeter(tx, target.credential, now);
  await updateSnapshot(
    tx,
    target,
    meter
      ? {
          observation: { meters: [meter] },
          fields: { budgetResetsAt: new Date(meter.resetsAt!), budgetPendingAt: null },
        }
      : {
          removeMeters: [BUDGET_METER],
          fields: { budgetResetsAt: null, budgetPendingAt: null },
        },
    now,
  );
}

/**
 * Schedules a budget recompute for a budgeted credential; call it in the transaction that
 * records a completion of that credential. Completions within 5 s share one outbox job (one
 * queued job per credential), so a burst costs one recompute.
 *
 * The mark on the snapshot row is the safety net for the one case the job key cannot cover: a
 * completion that commits while the job runs is dropped as a duplicate, yet its cost is not in
 * the sum the running job read. The mark stays, and the poll task recomputes it
 * (`BUDGET_PENDING_TIMEOUT_MS`). Updating the row also queues this transaction behind a running
 * recompute, which holds the row lock.
 *
 * @returns the queued job's id (dispatch it after commit), or `null` when the credential has no
 * budget or a recompute is already queued.
 */
export async function scheduleBudgetRefresh(
  tx: Database,
  credential: CredentialRow,
  now = Date.now(),
): Promise<string | null> {
  if (credential.budgetAmount === null) {
    return null;
  }
  await tx
    .update(credentialLimits)
    .set({ budgetPendingAt: new Date(now) })
    .where(eq(credentialLimits.credential, credential.id));
  return await enqueueJob(tx, {
    kind: BUDGET_JOB,
    payload: { credential: credential.id },
    runAt: new Date(now + BUDGET_DEBOUNCE_MS),
    dedupeKey: `${BUDGET_JOB}:${credential.id}`,
  });
}

/** Outbox handler of {@link BUDGET_JOB}. */
export async function runBudgetJob(runtime: Runtime, credentialId: string) {
  await runtime.drivers.db.transaction((tx) => refreshBudget(tx, credentialId));
}
