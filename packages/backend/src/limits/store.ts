import { internal } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { isWorkspaceProviderEnabled } from "../../convex/provider_records";
import { credentialDisplayName } from "../workspaces/credentials";
import { providerSnapshotFromCatalog, type ProviderSnapshot } from "../workspaces/provider";
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
  type LimitObservation,
  type LimitSettings,
  type Meter,
} from "./meters";

/** Meter ID of the owner's metered budget. */
export const BUDGET_METER = "budget";
/** Completions summed per budget recompute; bounds the read set of one mutation. */
const BUDGET_SCAN_LIMIT = 4000;
/** Completions within this window share one budget recompute. */
const BUDGET_DEBOUNCE_MS = 5_000;
/** A pending recompute older than this is assumed lost and rescheduled. */
const BUDGET_PENDING_TIMEOUT_MS = 60_000;

/** A workspace provider's snapshot and whether routing may use it. */
export type ProviderContext = { snapshot: ProviderSnapshot; enabled: boolean };

/** Secret Store name of a credential's limit key, next to the credential's own secret. */
export function limitKeySecretName(credential: Id<"workspace_credentials">) {
  return `${credential}:limit-key`;
}

export async function limitRowFor(ctx: QueryCtx, credential: Id<"workspace_credentials">) {
  return await ctx.db
    .query("credential_limits")
    .withIndex("by_credential", (q) => q.eq("credential", credential))
    .first();
}

export async function limitSettingsFor(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
): Promise<LimitSettings> {
  const row = await ctx.db
    .query("workspace_settings")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
    .first();
  return resolveLimitSettings(row?.limits);
}

/**
 * A workspace provider's snapshot: its local configuration, else (legacy workspaces only) the
 * catalogue row. `null` when deleted or not configured.
 */
export async function providerContextFor(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  slug: string,
): Promise<ProviderContext | null> {
  const configuration = await ctx.db
    .query("workspace_configurations")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace).eq("provider", slug),
    )
    .first();
  if (configuration?.deletedAt !== undefined) return null;

  let snapshot = configuration?.snapshot;
  let catalogEnabled = true;
  if (!snapshot) {
    const catalog = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!catalog) return null;
    if (!configuration) {
      const owner = await ctx.db.get("workspaces", workspace);
      if (!owner?.legacyBalance) return null;
    }
    snapshot = providerSnapshotFromCatalog(catalog);
    catalogEnabled = catalog.enabled;
  }
  const enabled = configuration
    ? isWorkspaceProviderEnabled({ configuration, provider: snapshot, catalog: null })
    : catalogEnabled;
  return { snapshot, enabled };
}

export function adapterFor(provider: ProviderContext | null): LimitAdapter | undefined {
  return provider ? limitAdapter(provider.snapshot) : undefined;
}

/** The credential's snapshot row, created on first use; pollable rows are due immediately. */
export async function ensureLimitRow(
  ctx: MutationCtx,
  credential: Doc<"workspace_credentials">,
  adapter: LimitAdapter | undefined,
  now: number,
): Promise<Doc<"credential_limits">> {
  const existing = await limitRowFor(ctx, credential._id);
  if (existing) return existing;
  const id = await ctx.db.insert("credential_limits", {
    workspace: credential.workspace,
    provider: credential.provider,
    credential: credential._id,
    meters: [],
    alerts: [],
    updatedAt: now,
    ...(adapter?.poll ? { nextPollAt: now } : {}),
  });
  return (await ctx.db.get("credential_limits", id))!;
}

/** The credential, its provider, and the workspace thresholds a snapshot update needs. */
export type SnapshotTarget = {
  row: Doc<"credential_limits">;
  credential: Doc<"workspace_credentials">;
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
  /** Other row fields to write; any field forces the write. */
  fields?: Partial<Omit<Doc<"credential_limits">, "_id" | "_creationTime">>;
};

/**
 * Apply one observation to a credential snapshot: merge meters, evaluate thresholds with
 * hysteresis, track credential expiry, and record the resulting events. Passive-only updates
 * are throttled (see {@link shouldSkipWrite}) unless an alert or other state changed.
 */
export async function updateSnapshot(
  ctx: MutationCtx,
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
  if (update.health?.ok && expiredAt !== undefined) {
    expiredAt = undefined;
    healthEvents.push({ kind: "credential_restored" });
  } else if (update.health && !update.health.ok && expiredAt === undefined) {
    expiredAt = now;
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
    shouldSkipWrite({ previous, next: meters, lastWriteAt: row.updatedAt, now, stateChanged })
  ) {
    return;
  }

  await ctx.db.patch("credential_limits", row._id, {
    meters,
    plan,
    alerts,
    expiredAt,
    updatedAt: now,
    ...(observation?.passive ? { passiveAt: now } : {}),
    ...update.fields,
  });

  const base = eventBase(target, { meters, plan }, now);
  for (const transition of transitions) {
    await recordLimitEvent(ctx, { ...base, ...transition });
  }
  for (const event of healthEvents) {
    await recordLimitEvent(ctx, { ...base, ...event });
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
    credential: { id: target.credential._id, name: credentialDisplayName(target.credential) },
    snapshot: {
      meters: snapshot.meters,
      ...(snapshot.plan !== undefined ? { plan: snapshot.plan } : {}),
    },
    settings: target.settings,
    occurredAt: now,
  };
}

/** Load everything {@link updateSnapshot} needs, creating the row when missing. */
export async function loadSnapshotTarget(
  ctx: MutationCtx,
  credential: Doc<"workspace_credentials">,
  now: number,
): Promise<SnapshotTarget & { provider: ProviderContext | null; adapter?: LimitAdapter }> {
  const provider = await providerContextFor(ctx, credential.workspace, credential.provider);
  const adapter = adapterFor(provider);
  const row = await ensureLimitRow(ctx, credential, adapter, now);
  return {
    row,
    credential,
    provider,
    adapter,
    providerName: provider?.snapshot.name ?? credential.provider,
    settings: await limitSettingsFor(ctx, credential.workspace),
  };
}

/** Store the plan an OAuth login reported; later headers and polls replace it with live data. */
export async function recordLoginPlan(
  ctx: MutationCtx,
  credentialId: Id<"workspace_credentials">,
  plan: string,
) {
  const credential = await ctx.db.get("workspace_credentials", credentialId);
  if (!credential) return;
  const adapter = adapterFor(
    await providerContextFor(ctx, credential.workspace, credential.provider),
  );
  const row = await ensureLimitRow(ctx, credential, adapter, Date.now());
  if (row.plan !== plan) await ctx.db.patch("credential_limits", row._id, { plan });
}

/**
 * Record the limit side of one routed attempt (from `routing.reportResult`): meters captured from
 * the upstream response, and credential health (401 → expired, success → restored). The first
 * attempt of a credential creates its row so idle credentials are polled afterwards.
 */
export async function recordAttemptLimits(
  ctx: MutationCtx,
  args: {
    credential: Id<"workspace_credentials">;
    observation?: LimitObservation;
    outcome: { type: "success" } | { type: "failure"; status?: number; message: string };
  },
  now: number,
) {
  const unauthorized = args.outcome.type === "failure" && args.outcome.status === 401;
  const row = await limitRowFor(ctx, args.credential);
  const healthChange =
    row === null ||
    (args.outcome.type === "success" && row.expiredAt !== undefined) ||
    (unauthorized && row.expiredAt === undefined);
  if (!args.observation?.meters.length && !args.observation?.plan && !healthChange) return;

  const credential = await ctx.db.get("workspace_credentials", args.credential);
  if (!credential) return;
  const target = await loadSnapshotTarget(ctx, credential, now);
  const outcome = args.outcome;
  await updateSnapshot(
    ctx,
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
}

/** The metered budget meter: Radium's recorded cost for the credential in the current period. */
export async function budgetMeter(
  ctx: QueryCtx,
  credential: Doc<"workspace_credentials">,
  now: number,
): Promise<Meter | undefined> {
  const budget = credential.budget;
  if (!budget) return undefined;
  const start = periodStart(budget.period, now);
  const end = periodEnd(budget.period, now);
  const completions = await ctx.db
    .query("chat_completions")
    .withIndex("by_credential", (q) =>
      q.eq("request.credential", credential._id).gte("_creationTime", start),
    )
    .take(BUDGET_SCAN_LIMIT);
  const used = completions.reduce(
    (total, completion) => total + completion.response.pricing.cost,
    0,
  );
  return {
    id: BUDGET_METER,
    label: `Budget (${budget.period})`,
    scope: "credential",
    unit: "usd",
    used,
    limit: budget.amount,
    windowSeconds: (end - start) / 1000,
    resetsAt: end,
    source: "metered",
    observedAt: now,
  };
}

/** Recompute (or, without a budget, remove) the credential's budget meter and fire thresholds. */
export async function refreshBudget(
  ctx: MutationCtx,
  credential: Doc<"workspace_credentials">,
  now: number,
) {
  const target = await loadSnapshotTarget(ctx, credential, now);
  const meter = await budgetMeter(ctx, credential, now);
  await updateSnapshot(
    ctx,
    target,
    meter
      ? {
          observation: { meters: [meter] },
          fields: { budgetResetsAt: meter.resetsAt, budgetPendingAt: undefined },
        }
      : {
          removeMeters: [BUDGET_METER],
          fields: { budgetResetsAt: undefined, budgetPendingAt: undefined },
        },
    now,
  );
}

/**
 * Schedule a budget recompute after a completion was recorded for a budgeted credential.
 * Completions arriving while one is pending share it.
 */
export async function scheduleBudgetRefresh(
  ctx: MutationCtx,
  credential: Doc<"workspace_credentials">,
  now: number,
) {
  if (!credential.budget) return;
  const row = await limitRowFor(ctx, credential._id);
  if (row?.budgetPendingAt !== undefined && now - row.budgetPendingAt < BUDGET_PENDING_TIMEOUT_MS) {
    return;
  }
  if (row) await ctx.db.patch("credential_limits", row._id, { budgetPendingAt: now });
  await ctx.scheduler.runAfter(BUDGET_DEBOUNCE_MS, internal.limits.refreshBudget, {
    credential: credential._id,
  });
}

/** Remove a credential's snapshot row (events stay; they captured the credential name). */
export async function removeLimitRow(ctx: MutationCtx, credential: Id<"workspace_credentials">) {
  const row = await limitRowFor(ctx, credential);
  if (row) await ctx.db.delete("credential_limits", row._id);
}
