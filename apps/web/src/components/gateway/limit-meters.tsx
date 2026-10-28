import { useSyncExternalStore } from "react";
import type { FunctionReturnType } from "convex/server";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "backend/convex/_generated/api";

/** One pooled credential's limits from `api.limits.list` (owner-only). */
export type CredentialLimits = FunctionReturnType<typeof api.limits.list>[number];
export type Meter = CredentialLimits["meters"][number];
export type LimitSettings = FunctionReturnType<typeof api.limits.getSettings>;
export type LimitEvent = FunctionReturnType<typeof api.limits.listEvents>[number];
export type BudgetPeriod = NonNullable<CredentialLimits["budget"]>["period"];

/**
 * How full a meter is against the workspace thresholds. `stale` is a meter whose window reset
 * after it was observed: its value no longer applies until fresh data arrives.
 */
export type MeterLevel = "ok" | "warn" | "critical" | "exhausted" | "stale";

// ---------------------------------------------------------------------------------------------
// Clock

// Countdowns read in minutes, so a 30 s tick keeps them close without re-rendering every second.
const clockIntervalMs = 30_000;
let clockNow = 0;
let clockTimer: number | undefined;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      for (const notify of clockListeners) notify();
    }, clockIntervalMs);
  }
  // Hydration renders with the server snapshot (0) and React does not re-read the client one, so
  // notify the new subscriber once; otherwise time text stays hidden until the first tick.
  queueMicrotask(listener);

  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/**
 * `Date.now()` shared by every limits view, refreshed every 30 seconds by one interval. Only the
 * components that call it re-render on a tick, so read it in the leaf that renders time text.
 * `0` during server render and hydration; callers render no time text until it is set.
 */
export function useLimitsClock(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow,
    () => 0,
  );
}

// ---------------------------------------------------------------------------------------------
// Meter math

/** A meter whose `resetsAt` passed: its window restarted after the value was observed. */
export function isMeterStale(meter: Meter, now: number): boolean {
  return meter.resetsAt !== undefined && now > 0 && meter.resetsAt <= now;
}

/**
 * Fraction used (0–1, may exceed 1 when over a cap): `used/100` for percent meters, `used/limit`
 * (or `1 - remaining/limit`) for capped amounts. `undefined` for balances without a cap. A stale
 * meter reads as reset (0).
 */
export function meterFraction(meter: Meter, now: number): number | undefined {
  if (isMeterStale(meter, now)) return 0;
  if (meter.unit === "percent") return meter.used === undefined ? undefined : meter.used / 100;
  if (meter.limit === undefined || meter.limit <= 0) return undefined;
  if (meter.used !== undefined) return meter.used / meter.limit;
  if (meter.remaining !== undefined) return 1 - meter.remaining / meter.limit;
  return undefined;
}

/**
 * Level against the workspace thresholds. Capped meters compare their fraction with the warn and
 * critical percents; uncapped balances are low under `lowBalance` (USD) and exhausted at zero.
 */
export function meterLevel(meter: Meter, settings: LimitSettings, now: number): MeterLevel {
  if (isMeterStale(meter, now)) return "stale";

  const fraction = meterFraction(meter, now);
  if (fraction !== undefined) {
    if (fraction >= 1) return "exhausted";
    if (fraction * 100 >= settings.criticalPercent) return "critical";
    if (fraction * 100 >= settings.warnPercent) return "warn";
    return "ok";
  }

  if (meter.remaining !== undefined) {
    if (meter.remaining <= 0) return "exhausted";
    if (meter.unit === "usd" && meter.remaining < settings.lowBalance) return "warn";
  }
  return "ok";
}

const levelRank: Record<MeterLevel, number> = {
  stale: 0,
  ok: 1,
  warn: 2,
  critical: 3,
  exhausted: 4,
};

/**
 * Fill for bars and ordering: the fraction used, or for an uncapped balance its level expressed
 * on the same scale (full when exhausted, at the warn threshold when low, empty otherwise).
 */
function meterFill(meter: Meter, settings: LimitSettings, now: number): number {
  const fraction = meterFraction(meter, now);
  if (fraction !== undefined) return fraction;

  const level = meterLevel(meter, settings, now);
  if (level === "exhausted") return 1;
  if (level === "warn") return settings.warnPercent / 100;
  return 0;
}

/**
 * Meters tightest first: highest fraction used, then soonest reset. Uncapped balances rank by
 * their level (`meterFill`); stale meters read as reset (0) and sort last among equals.
 */
export function tightestMeters(meters: Meter[], settings: LimitSettings, now: number): Meter[] {
  const keyed = meters.map((meter) => ({
    meter,
    rank: levelRank[meterLevel(meter, settings, now)],
    fill: meterFill(meter, settings, now),
    resetsAt: meter.resetsAt ?? Number.MAX_SAFE_INTEGER,
  }));

  keyed.sort((a, b) => b.fill - a.fill || b.rank - a.rank || a.resetsAt - b.resetsAt);
  return keyed.map((entry) => entry.meter);
}

// ---------------------------------------------------------------------------------------------
// Formatting

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const countFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatUsd(amount: number): string {
  return usdFormat.format(amount);
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** USD as currency; requests and credits as plain counts. */
function formatAmount(meter: Meter, amount: number): string {
  if (meter.unit === "usd") return formatUsd(amount);
  return countFormat.format(amount);
}

/** Unit word after a count; USD amounts carry their own `$`. */
function unitSuffix(meter: Meter): string {
  if (meter.unit === "requests") return " requests";
  if (meter.unit === "credits") return " credits";
  return "";
}

/**
 * The meter's headline value: `62%` for capped meters, `$4.20 left` or `120 credits left` for
 * uncapped balances, `Reset` once stale.
 */
export function formatMeterHeadline(meter: Meter, now: number): string {
  if (isMeterStale(meter, now)) return "Reset";

  const fraction = meterFraction(meter, now);
  if (fraction !== undefined) return formatPercent(fraction);
  if (meter.remaining !== undefined) {
    return `${formatAmount(meter, meter.remaining)}${unitSuffix(meter)} left`;
  }
  if (meter.used !== undefined)
    return `${formatAmount(meter, meter.used)}${unitSuffix(meter)} used`;
  return "No data";
}

/**
 * Amounts behind a capped meter (`$12.40 / $20.00 · $7.60 left`, `12 / 50 requests`);
 * `undefined` for percent meters and uncapped balances, whose headline already says it all.
 */
export function formatMeterAmounts(meter: Meter, now: number): string | undefined {
  if (meter.unit === "percent" || meter.limit === undefined || isMeterStale(meter, now)) {
    return undefined;
  }

  const used =
    meter.used ?? (meter.remaining !== undefined ? meter.limit - meter.remaining : undefined);
  const suffix = unitSuffix(meter);
  const parts: string[] = [];
  if (used !== undefined) {
    parts.push(`${formatAmount(meter, used)} / ${formatAmount(meter, meter.limit)}${suffix}`);
  }
  const remaining = meter.remaining ?? (used !== undefined ? meter.limit - used : undefined);
  if (remaining !== undefined) {
    parts.push(`${formatAmount(meter, Math.max(0, remaining))}${suffix} left`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Compact duration for countdowns: `<1m`, `12m`, `1h 40m`, `3d 4h`. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes < 1) return "<1m";
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

/**
 * Reset text: `resets in 1h 40m` while the window runs, `reset, awaiting fresh data` once it
 * passed, `undefined` for meters that never reset or before the clock is set.
 */
export function formatResetsIn(meter: Meter, now: number): string | undefined {
  if (meter.resetsAt === undefined || now === 0) return undefined;
  if (meter.resetsAt <= now) return "reset, awaiting fresh data";
  return `resets in ${formatDuration(meter.resetsAt - now)}`;
}

/** Age of a timestamp: `just now`, `3 min ago`, `2 h ago`, `4 d ago`. */
export function formatAge(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const sourceLabels: Record<Meter["source"], string> = {
  header: "response headers",
  poll: "usage poll",
  error: "a limit error",
  metered: "Radium usage",
};

/**
 * When a credential's upstream data is from: `Updated 3 min ago from usage poll`, after its
 * newest meter. Metered budgets are computed on every read, so they never date the data.
 */
export function formatUpdated(meters: Meter[], now: number): string | undefined {
  let latest: Meter | undefined;
  for (const meter of meters) {
    if (meter.source === "metered") continue;
    if (!latest || meter.observedAt > latest.observedAt) latest = meter;
  }
  if (!latest || now === 0) return undefined;
  return `Updated ${formatAge(latest.observedAt, now)} from ${sourceLabels[latest.source]}`;
}

/** Upstream plan IDs as labels: `plus` → `Plus`, `free_workspace` → `Free workspace`. */
export function formatPlan(plan: string): string {
  const words = plan.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Poll failure line: `Poll failed (429): Too many requests · 3 min ago`. */
export function formatPollError(
  pollError: NonNullable<CredentialLimits["pollError"]>,
  now: number,
): string {
  const status = pollError.status !== undefined ? ` (${pollError.status})` : "";
  const age = now > 0 ? ` · ${formatAge(pollError.at, now)}` : "";
  return `Poll failed${status}: ${pollError.message}${age}`;
}

// ---------------------------------------------------------------------------------------------
// Presentation

const levelFill: Record<MeterLevel, string> = {
  ok: "bg-primary",
  warn: "bg-signal-awaiting",
  critical: "bg-destructive",
  exhausted: "bg-destructive",
  stale: "bg-signal-idle",
};

/** Text color for a headline value; `ok` keeps the surrounding color. */
export const levelText: Record<MeterLevel, string | undefined> = {
  ok: undefined,
  warn: "text-signal-awaiting",
  critical: "text-destructive",
  exhausted: "text-destructive",
  stale: "text-muted-foreground",
};

/**
 * Horizontal meter bar colored by level. Uncapped balances have no fraction: the bar fills to
 * their level (`meterFill`) so the color and length still carry it.
 */
export function MeterBar({
  meter,
  settings,
  now,
  className,
}: {
  meter: Meter;
  settings: LimitSettings;
  now: number;
  className?: string;
}) {
  const level = meterLevel(meter, settings, now);
  const percent = Math.min(100, Math.max(0, meterFill(meter, settings, now) * 100));

  return (
    <div
      role="meter"
      aria-label={meter.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={formatMeterHeadline(meter, now)}
      data-level={level}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
          levelFill[level],
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** Every meter of a credential with its value and reset, under the plan and data age, for tooltips. */
function MeterDetailsList({
  limits,
  settings,
  now,
}: {
  limits: CredentialLimits;
  settings: LimitSettings;
  now: number;
}) {
  const updated = formatUpdated(limits.meters, now);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {limits.plan || updated ? (
        <p className="opacity-70">
          {[limits.plan && `${formatPlan(limits.plan)} plan`, updated].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {tightestMeters(limits.meters, settings, now).map((meter) => {
        const details = [
          formatMeterAmounts(meter, now),
          formatResetsIn(meter, now),
          meter.scope === "account" ? "Shared by the account" : undefined,
          meter.source === "metered" ? "Radium usage only" : undefined,
        ].filter(Boolean);
        return (
          <span key={meter.id} className="tabular-nums">
            <span className="font-medium">{meter.label}</span> {formatMeterHeadline(meter, now)}
            {details.length > 0 ? ` · ${details.join(" · ")}` : null}
          </span>
        );
      })}
      {limits.pollError ? <p>{formatPollError(limits.pollError, now)}</p> : null}
    </div>
  );
}

/**
 * Up to two compact bars for a credential's tightest meters (`5-hour ▰▰▱ 62% · resets in 1h 40m`)
 * for credential rows. Hovering or focusing shows the plan, data age, and every meter, plus the
 * last poll error. Renders nothing for a credential without meters or poll errors.
 */
export function CompactCredentialMeters({
  limits,
  settings,
}: {
  limits: CredentialLimits;
  settings: LimitSettings;
}) {
  const now = useLimitsClock();
  if (limits.meters.length === 0 && !limits.pollError) return null;

  const shown = tightestMeters(limits.meters, settings, now).slice(0, 2);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          role="group"
          aria-label={`Usage limits for ${limits.credentialName}`}
          // The Row description clips overflow, so focus shows as a fill instead of a ring.
          className="flex w-fit max-w-full min-w-0 flex-col gap-1 rounded-sm pt-1 outline-none focus-visible:bg-muted"
        >
          {shown.map((meter) => {
            const level = meterLevel(meter, settings, now);
            const reset = formatResetsIn(meter, now);
            return (
              <div key={meter.id} className="flex min-w-0 items-center gap-2 text-xs">
                <span className="w-16 shrink-0 truncate">{meter.label}</span>
                <MeterBar meter={meter} settings={settings} now={now} className="w-20 shrink-0" />
                <span className={cn("shrink-0 tabular-nums", levelText[level])}>
                  {formatMeterHeadline(meter, now)}
                </span>
                {reset && level !== "stale" ? (
                  <span className="truncate tabular-nums">· {reset}</span>
                ) : null}
              </div>
            );
          })}
          {limits.pollError ? (
            <span className="truncate text-xs text-destructive">
              {formatPollError(limits.pollError, now)}
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-sm">
        <MeterDetailsList limits={limits} settings={settings} now={now} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Self-updating age text (`3 min ago`) for one timestamp; only this text re-renders on a tick. */
export function RelativeTime({ at, className }: { at: number; className?: string }) {
  const now = useLimitsClock();
  if (now === 0) return null;

  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
      className={className}
    >
      {formatAge(at, now)}
    </time>
  );
}
