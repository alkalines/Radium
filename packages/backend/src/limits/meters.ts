import { v, type Infer } from "convex/values";

/**
 * Usage-limit meters: every upstream signal (response headers, usage polls, error bodies) and the
 * owner's metered budget normalizes to this shape. Fraction used is derived, never stored.
 */

export const meterUnitValidator = v.union(
  v.literal("percent"),
  v.literal("usd"),
  v.literal("requests"),
  /** Upstream credit balance that is not USD (ChatGPT Codex credits). */
  v.literal("credits"),
);

export const meterSourceValidator = v.union(
  v.literal("header"),
  v.literal("poll"),
  v.literal("error"),
  v.literal("metered"),
);

export const meterValidator = v.object({
  /** Stable per adapter, e.g. `codex:primary`, `openrouter:key`, `budget`. */
  id: v.string(),
  label: v.string(),
  /** `account` meters are shared by every key of the upstream account. */
  scope: v.union(v.literal("credential"), v.literal("account")),
  unit: meterUnitValidator,
  /** Percent meters: 0–100; other units: amount used. */
  used: v.optional(v.number()),
  /** Absent for percent meters and uncapped balances. */
  limit: v.optional(v.number()),
  /** Balances without a cap. */
  remaining: v.optional(v.number()),
  /** Window length; absent means the meter never resets. */
  windowSeconds: v.optional(v.number()),
  /** ms epoch. */
  resetsAt: v.optional(v.number()),
  source: meterSourceValidator,
  /** ms epoch. */
  observedAt: v.number(),
});

/** Meters and plan learned from one response, error body, or poll. */
export const limitObservationValidator = v.object({
  meters: v.array(meterValidator),
  plan: v.optional(v.string()),
});

export const limitSettingsValidator = v.object({
  warnPercent: v.number(),
  criticalPercent: v.number(),
  /** USD balance under which a remaining-only USD meter alerts. */
  lowBalance: v.number(),
});

export const budgetPeriodValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("month"),
);

export const credentialBudgetValidator = v.object({
  /** USD, > 0. */
  amount: v.number(),
  period: budgetPeriodValidator,
});

export const alertLevelValidator = v.union(
  v.literal("low"),
  v.literal("critical"),
  v.literal("exhausted"),
);

/** Highest alert already fired for a meter; cleared (re-armed) by a reset or hysteresis. */
export const alertStateValidator = v.object({
  meter: v.string(),
  level: alertLevelValidator,
  resetsAt: v.optional(v.number()),
});

export type MeterUnit = Infer<typeof meterUnitValidator>;
export type MeterSource = Infer<typeof meterSourceValidator>;
export type Meter = Infer<typeof meterValidator>;
export type LimitObservation = Infer<typeof limitObservationValidator>;
export type LimitSettings = Infer<typeof limitSettingsValidator>;
export type BudgetPeriod = Infer<typeof budgetPeriodValidator>;
export type CredentialBudget = Infer<typeof credentialBudgetValidator>;
export type AlertLevel = Infer<typeof alertLevelValidator>;
export type AlertState = Infer<typeof alertStateValidator>;

export const DEFAULT_LIMIT_SETTINGS: LimitSettings = {
  warnPercent: 80,
  criticalPercent: 95,
  lowBalance: 5,
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Writes are skipped while every meter moved less than this many points… */
const THROTTLE_POINTS = 1;
/** Float tolerance so a move of exactly one point counts as one point. */
const POINT_EPSILON = 1e-9;
/** …and the last write is younger than this. */
export const THROTTLE_WINDOW_MS = 60 * SECOND;
/** Reset deadlines closer than this are the same window (header rounding, latency). */
const RESET_TOLERANCE_MS = 60 * SECOND;
/** Points a percent/limit meter must fall below a threshold before that alert re-arms. */
export const HYSTERESIS_POINTS = 5;

export function resolveLimitSettings(stored: LimitSettings | undefined): LimitSettings {
  return stored ?? DEFAULT_LIMIT_SETTINGS;
}

export function assertValidLimitSettings(settings: LimitSettings) {
  const { warnPercent, criticalPercent, lowBalance } = settings;
  if (![warnPercent, criticalPercent, lowBalance].every(Number.isFinite)) {
    throw new Error("Limit thresholds must be numbers.");
  }
  if (!(warnPercent > 0 && warnPercent < criticalPercent && criticalPercent <= 100)) {
    throw new Error("Thresholds must satisfy 0 < warning < critical ≤ 100.");
  }
  if (lowBalance < 0) throw new Error("The low balance threshold cannot be negative.");
}

export function assertValidBudget(budget: CredentialBudget) {
  if (!Number.isFinite(budget.amount) || budget.amount <= 0) {
    throw new Error("Budget amount must be greater than 0 USD.");
  }
}

/** Fraction used (0–1+), or `undefined` for meters judged only by `remaining` or unknown. */
export function meterFraction(meter: Meter): number | undefined {
  if (meter.unit === "percent") {
    return meter.used === undefined ? undefined : Math.max(0, meter.used / 100);
  }
  if (meter.limit === undefined || meter.limit <= 0) return undefined;
  if (meter.used !== undefined) return Math.max(0, meter.used / meter.limit);
  if (meter.remaining !== undefined)
    return Math.max(0, (meter.limit - meter.remaining) / meter.limit);
  return undefined;
}

const LEVEL_RANK: Record<AlertLevel | "none", number> = {
  none: 0,
  low: 1,
  critical: 2,
  exhausted: 3,
};

function levelForPoints(points: number, settings: LimitSettings): AlertLevel | undefined {
  if (points >= 100) return "exhausted";
  if (points >= settings.criticalPercent) return "critical";
  if (points >= settings.warnPercent) return "low";
  return undefined;
}

function levelForBalance(
  meter: Meter,
  remaining: number,
  settings: LimitSettings,
): AlertLevel | undefined {
  if (remaining <= 0) return "exhausted";
  // The low-balance threshold is in USD; other balances alert only when exhausted.
  if (meter.unit === "usd" && remaining < settings.lowBalance) return "low";
  return undefined;
}

/** Alert level a meter is at now. */
export function meterAlertLevel(meter: Meter, settings: LimitSettings): AlertLevel | undefined {
  const fraction = meterFraction(meter);
  if (fraction !== undefined) return levelForPoints(fraction * 100, settings);
  if (meter.remaining !== undefined) return levelForBalance(meter, meter.remaining, settings);
  return undefined;
}

/**
 * Level an armed alert may stay at: the meter must fall `HYSTERESIS_POINTS` below a threshold
 * (or a balance rise 5 % of the low-balance amount above it) before that alert re-arms.
 */
function hysteresisLevel(meter: Meter, settings: LimitSettings): AlertLevel | undefined {
  const fraction = meterFraction(meter);
  if (fraction !== undefined) return levelForPoints(fraction * 100 + HYSTERESIS_POINTS, settings);
  if (meter.remaining !== undefined) {
    const margin = Math.max(settings.lowBalance * 0.05, 0.01);
    return levelForBalance(meter, meter.remaining - margin, settings);
  }
  return undefined;
}

/** Threshold crossed by an alert level: percent points, or USD for balance meters. */
export function alertThreshold(meter: Meter, level: AlertLevel, settings: LimitSettings) {
  const byFraction = meterFraction(meter) !== undefined;
  if (level === "exhausted") return byFraction ? 100 : 0;
  if (level === "critical") return settings.criticalPercent;
  return byFraction ? settings.warnPercent : settings.lowBalance;
}

export type AlertTransition = {
  kind: "limit_low" | "limit_critical" | "limit_exhausted" | "limit_reset";
  meter: Meter;
  previous?: Meter;
  threshold: number;
};

const LEVEL_EVENT: Record<AlertLevel, AlertTransition["kind"]> = {
  low: "limit_low",
  critical: "limit_critical",
  exhausted: "limit_exhausted",
};

/**
 * Compare a meter set with the armed alerts. One event per upward crossing (only the highest
 * level crossed); an armed alert re-arms after its window resets (a new `resetsAt`) or after the
 * meter falls below its threshold minus the hysteresis, firing `limit_reset` once it is fully
 * re-armed. Alerts of meters that disappeared are dropped silently.
 */
export function evaluateAlerts(
  previous: Meter[],
  next: Meter[],
  alerts: AlertState[],
  settings: LimitSettings,
): { alerts: AlertState[]; transitions: AlertTransition[] } {
  const previousById = new Map(previous.map((meter) => [meter.id, meter]));
  const armed = new Map(alerts.map((alert) => [alert.meter, alert]));
  const nextAlerts: AlertState[] = [];
  const transitions: AlertTransition[] = [];

  for (const meter of next) {
    const before = previousById.get(meter.id);
    let state = armed.get(meter.id);

    if (state) {
      const windowReset =
        state.resetsAt !== undefined &&
        meter.resetsAt !== undefined &&
        meter.resetsAt > state.resetsAt + RESET_TOLERANCE_MS;
      const allowed = windowReset ? undefined : hysteresisLevel(meter, settings);
      const kept = LEVEL_RANK[allowed ?? "none"] < LEVEL_RANK[state.level] ? allowed : state.level;
      if (!kept) {
        transitions.push({
          kind: "limit_reset",
          meter,
          previous: before,
          threshold: alertThreshold(before ?? meter, state.level, settings),
        });
        state = undefined;
      } else {
        state = { ...state, level: kept };
      }
    }

    const level = meterAlertLevel(meter, settings);
    if (level && LEVEL_RANK[level] > LEVEL_RANK[state?.level ?? "none"]) {
      transitions.push({
        kind: LEVEL_EVENT[level],
        meter,
        previous: before,
        threshold: alertThreshold(meter, level, settings),
      });
      state = { meter: meter.id, level };
    }

    if (state) {
      nextAlerts.push({
        meter: meter.id,
        level: state.level,
        ...(meter.resetsAt !== undefined ? { resetsAt: meter.resetsAt } : {}),
      });
    }
  }

  return { alerts: nextAlerts, transitions };
}

/**
 * Merge an observation into stored meters. Same-ID meters are replaced. A `complete` source (a
 * poll) also drops upstream meters it no longer reports, except `retain`ed IDs; metered budgets
 * are never touched by upstream observations. Error meters mean "exhausted": they keep what the
 * stored meter knew (limit, window) and mark it used up. An error meter with an unknown ID and a
 * reset deadline marks the stored percent meter of the same adapter whose window ends then.
 */
export function mergeMeters(
  existing: Meter[],
  incoming: Meter[],
  options: { complete?: boolean; retain?: string[] } = {},
): Meter[] {
  const incomingIds = new Set(incoming.map((meter) => meter.id));
  const retain = new Set(options.retain ?? []);
  const merged = new Map<string, Meter>();
  for (const meter of existing) {
    const dropped =
      options.complete &&
      meter.source !== "metered" &&
      !incomingIds.has(meter.id) &&
      !retain.has(meter.id);
    if (!dropped) merged.set(meter.id, meter);
  }

  for (const meter of incoming) {
    if (meter.source !== "error") {
      merged.set(meter.id, meter);
      continue;
    }
    const target = merged.get(meter.id) ?? windowMatch([...merged.values()], meter);
    const exhausted = exhaust(target, meter);
    merged.set(exhausted.id, exhausted);
  }
  return [...merged.values()];
}

function windowMatch(meters: Meter[], error: Meter) {
  if (error.unit !== "percent" || error.resetsAt === undefined) return undefined;
  const adapter = error.id.split(":")[0];
  return meters.find(
    (meter) =>
      meter.unit === "percent" &&
      meter.source !== "metered" &&
      meter.id.split(":")[0] === adapter &&
      meter.resetsAt !== undefined &&
      Math.abs(meter.resetsAt - error.resetsAt!) <= 2 * RESET_TOLERANCE_MS,
  );
}

function exhaust(target: Meter | undefined, error: Meter): Meter {
  const { used: _used, remaining: _remaining, resetsAt: _resetsAt, ...base } = target ?? error;
  const limit = error.limit ?? target?.limit;
  const used = error.unit === "percent" ? 100 : (error.used ?? limit ?? target?.used);
  const resetsAt = error.resetsAt ?? target?.resetsAt;
  return {
    ...base,
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(error.unit === "percent" ? {} : { remaining: error.remaining ?? 0 }),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    source: "error",
    observedAt: error.observedAt,
  };
}

/** Merge two observations of one attempt: later meters replace earlier ones by ID. */
export function combineObservations(
  first: LimitObservation | undefined,
  second: LimitObservation | undefined,
): LimitObservation | undefined {
  if (!first) return second;
  if (!second) return first;
  const meters = new Map(first.meters.map((meter) => [meter.id, meter]));
  for (const meter of second.meters) meters.set(meter.id, meter);
  const plan = second.plan ?? first.plan;
  return { meters: [...meters.values()], ...(plan !== undefined ? { plan } : {}) };
}

/**
 * Whether a merged meter set differs enough from the stored one to be worth a write: a meter
 * appeared or vanished, moved at least one point (balances: 1 %), changed limit, or got a new
 * reset deadline.
 */
export function metersChanged(previous: Meter[], next: Meter[]): boolean {
  if (previous.length !== next.length) return true;
  const previousById = new Map(previous.map((meter) => [meter.id, meter]));
  for (const meter of next) {
    const before = previousById.get(meter.id);
    if (!before) return true;
    if (before.limit !== meter.limit || before.unit !== meter.unit) return true;
    if (before.source !== meter.source) return true;
    if ((before.resetsAt === undefined) !== (meter.resetsAt === undefined)) return true;
    if (
      before.resetsAt !== undefined &&
      Math.abs(before.resetsAt - meter.resetsAt!) > RESET_TOLERANCE_MS
    ) {
      return true;
    }
    const fractionBefore = meterFraction(before);
    const fractionNow = meterFraction(meter);
    if ((fractionBefore === undefined) !== (fractionNow === undefined)) return true;
    if (
      fractionBefore !== undefined &&
      Math.abs(fractionNow! - fractionBefore) * 100 >= THROTTLE_POINTS - POINT_EPSILON
    ) {
      return true;
    }
    if (fractionBefore === undefined && before.remaining !== meter.remaining) {
      if (before.remaining === undefined || meter.remaining === undefined) return true;
      const scale = Math.max(Math.abs(before.remaining), 1);
      const moved = Math.abs(meter.remaining - before.remaining) / scale;
      if (moved >= THROTTLE_POINTS / 100 - POINT_EPSILON) return true;
    }
  }
  return false;
}

/** Skip a snapshot write when meters barely moved, nothing else changed, and it was written recently. */
export function shouldSkipWrite(input: {
  previous: Meter[];
  next: Meter[];
  lastWriteAt: number | undefined;
  now: number;
  stateChanged: boolean;
}) {
  if (input.stateChanged || input.lastWriteAt === undefined) return false;
  if (input.now - input.lastWriteAt >= THROTTLE_WINDOW_MS) return false;
  return !metersChanged(input.previous, input.next);
}

/** Display label of a window by its length: `5-hour`, `Weekly`, `30-day`, else `<n>h` / `<n>d`. */
export function windowLabel(windowSeconds: number) {
  const minutes = Math.round(windowSeconds / 60);
  if (minutes === 300) return "5-hour";
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes === 30 * 24 * 60) return "30-day";
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  return `${Math.max(1, Math.round(minutes / 60))}h`;
}

/** Start of the UTC period containing `now`: midnight, ISO-week Monday, or the 1st. */
export function periodStart(period: BudgetPeriod, now: number) {
  const date = new Date(now);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === "day") return day;
  if (period === "week") return day - ((date.getUTCDay() + 6) % 7) * DAY;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Start of the next UTC period after the one containing `now`. */
export function periodEnd(period: BudgetPeriod, now: number) {
  const start = periodStart(period, now);
  if (period === "day") return start + DAY;
  if (period === "week") return start + 7 * DAY;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** Finite number from a header, JSON number, or numeric string; otherwise `undefined`. */
export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** ms epoch from unix seconds, ms, or an ISO date string. */
export function epochMs(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined) return numeric < 1e12 ? numeric * SECOND : numeric;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
