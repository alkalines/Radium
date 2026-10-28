import { describe, expect, test } from "vitest";
import {
  DEFAULT_LIMIT_SETTINGS,
  evaluateAlerts,
  mergeMeters,
  periodEnd,
  periodStart,
  shouldSkipWrite,
  windowLabel,
  type AlertState,
  type Meter,
} from "./meters";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function percent(used: number, overrides: Partial<Meter> = {}): Meter {
  return {
    id: "codex:secondary",
    label: "Weekly",
    scope: "credential",
    unit: "percent",
    used,
    windowSeconds: 7 * 24 * 3600,
    resetsAt: NOW + 72 * HOUR,
    source: "header",
    observedAt: NOW,
    ...overrides,
  };
}

function balance(remaining: number): Meter {
  return {
    id: "openrouter:credits",
    label: "Account balance",
    scope: "account",
    unit: "usd",
    remaining,
    source: "poll",
    observedAt: NOW,
  };
}

/** Feed a sequence of meter values through the evaluator; returns the event kinds per step. */
function run(steps: Meter[]) {
  let previous: Meter[] = [];
  let alerts: AlertState[] = [];
  return steps.map((meter) => {
    const result = evaluateAlerts(previous, [meter], alerts, DEFAULT_LIMIT_SETTINGS);
    previous = [meter];
    alerts = result.alerts;
    return result.transitions.map((transition) => transition.kind);
  });
}

describe("threshold evaluation", () => {
  test("fires once per upward crossing and only the highest level crossed", () => {
    expect(run([percent(50), percent(81), percent(90), percent(96), percent(100)])).toEqual([
      [],
      ["limit_low"],
      [],
      ["limit_critical"],
      ["limit_exhausted"],
    ]);
    expect(run([percent(10), percent(100)])).toEqual([[], ["limit_exhausted"]]);
  });

  test("oscillating around the warning threshold does not re-fire until 5 points below", () => {
    expect(
      run([percent(81), percent(79), percent(81), percent(76), percent(74), percent(80)]),
    ).toEqual([["limit_low"], [], [], [], ["limit_reset"], ["limit_low"]]);
  });

  test("falling below a higher threshold re-arms only that level", () => {
    expect(run([percent(96), percent(89), percent(96)])).toEqual([
      ["limit_critical"],
      [],
      ["limit_critical"],
    ]);
  });

  test("a new window resets an alerted meter even when usage is still high", () => {
    const steps = run([
      percent(100),
      percent(100),
      percent(85, { resetsAt: NOW + 72 * HOUR + 7 * 24 * HOUR }),
    ]);
    expect(steps).toEqual([["limit_exhausted"], [], ["limit_reset", "limit_low"]]);
  });

  test("reset events carry the meter before and after and the re-armed threshold", () => {
    const result = evaluateAlerts(
      [percent(100)],
      [percent(3, { resetsAt: NOW + 200 * HOUR })],
      [{ meter: "codex:secondary", level: "exhausted", resetsAt: NOW + 72 * HOUR }],
      DEFAULT_LIMIT_SETTINGS,
    );
    expect(result.alerts).toEqual([]);
    expect(result.transitions).toEqual([
      expect.objectContaining({
        kind: "limit_reset",
        threshold: 100,
        previous: expect.objectContaining({ used: 100 }),
        meter: expect.objectContaining({ used: 3 }),
      }),
    ]);
  });

  test("balances alert below the low-balance amount, when exhausted, and reset when topped up", () => {
    expect(run([balance(20), balance(4), balance(0), balance(30)])).toEqual([
      [],
      ["limit_low"],
      ["limit_exhausted"],
      ["limit_reset"],
    ]);
  });

  test("limit meters use used/limit; non-USD balances only alert when exhausted", () => {
    const key: Meter = {
      ...balance(0),
      id: "openrouter:key",
      limit: 10,
      used: 8.5,
      remaining: 1.5,
    };
    expect(run([key])).toEqual([["limit_low"]]);
    const credits: Meter = { ...balance(1), id: "codex:credits", unit: "credits" };
    expect(run([credits, { ...credits, remaining: 0 }])).toEqual([[], ["limit_exhausted"]]);
  });
});

describe("meter merging", () => {
  const budget: Meter = { ...balance(0), id: "budget", limit: 10, used: 2, source: "metered" };

  test("a complete poll drops vanished upstream meters but keeps budgets and retained IDs", () => {
    const merged = mergeMeters(
      [percent(10), balance(5), budget, percent(20, { id: "codex:primary" })],
      [percent(30, { source: "poll" })],
      { complete: true, retain: ["openrouter:credits"] },
    );
    expect(merged.map((meter) => meter.id)).toEqual([
      "codex:secondary",
      "openrouter:credits",
      "budget",
    ]);
    expect(merged[0]!.used).toBe(30);
  });

  test("an error meter exhausts the stored meter and keeps its limit and window", () => {
    const key: Meter = {
      ...balance(3),
      id: "openrouter:key",
      scope: "credential",
      limit: 10,
      used: 7,
      windowSeconds: 86400,
      resetsAt: NOW + HOUR,
    };
    const [merged] = mergeMeters(
      [key],
      [
        {
          ...balance(0),
          id: "openrouter:key",
          label: "Key limit",
          scope: "credential",
          source: "error",
        },
      ],
    );
    expect(merged).toMatchObject({
      limit: 10,
      used: 10,
      remaining: 0,
      windowSeconds: 86400,
      resetsAt: NOW + HOUR,
      source: "error",
    });
  });

  test("an unknown error window marks the stored window that resets at the same time", () => {
    const merged = mergeMeters(
      [percent(40, { id: "codex:primary", label: "5-hour", resetsAt: NOW + 2 * HOUR })],
      [
        percent(100, {
          id: "codex:usage-limit",
          label: "Usage limit",
          resetsAt: NOW + 2 * HOUR + 5000,
          source: "error",
        }),
      ],
    );
    expect(merged).toEqual([
      expect.objectContaining({ id: "codex:primary", label: "5-hour", used: 100, source: "error" }),
    ]);
  });
});

describe("write throttling", () => {
  test("skips writes for sub-point moves within a minute unless state changed", () => {
    const base = {
      previous: [percent(40)],
      lastWriteAt: NOW - 10_000,
      now: NOW,
      stateChanged: false,
    };
    expect(shouldSkipWrite({ ...base, next: [percent(40.5)] })).toBe(true);
    expect(shouldSkipWrite({ ...base, next: [percent(41)] })).toBe(false);
    expect(shouldSkipWrite({ ...base, next: [percent(40.5)], stateChanged: true })).toBe(false);
    expect(shouldSkipWrite({ ...base, next: [percent(40.5)], lastWriteAt: NOW - 61_000 })).toBe(
      false,
    );
    expect(shouldSkipWrite({ ...base, next: [percent(40), balance(3)] })).toBe(false);
  });
});

describe("periods and windows", () => {
  test("UTC day, ISO week (Monday), and month boundaries", () => {
    // Sunday 2026-11-01 23:59 UTC belongs to the week that started Monday 2026-10-26.
    const sunday = Date.UTC(2026, 10, 1, 23, 59);
    expect(periodStart("day", sunday)).toBe(Date.UTC(2026, 10, 1));
    expect(periodEnd("day", sunday)).toBe(Date.UTC(2026, 10, 2));
    expect(periodStart("week", sunday)).toBe(Date.UTC(2026, 9, 26));
    expect(periodEnd("week", sunday)).toBe(Date.UTC(2026, 10, 2));
    // Monday 00:00 starts a new week.
    expect(periodStart("week", Date.UTC(2026, 10, 2))).toBe(Date.UTC(2026, 10, 2));
    expect(periodStart("month", Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2026, 11, 1));
    expect(periodEnd("month", Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2027, 0, 1));
    expect(periodEnd("month", Date.UTC(2028, 1, 10))).toBe(Date.UTC(2028, 2, 1));
  });

  test("labels windows by length", () => {
    expect(windowLabel(5 * 3600)).toBe("5-hour");
    expect(windowLabel(7 * 86400)).toBe("Weekly");
    expect(windowLabel(30 * 86400)).toBe("30-day");
    expect(windowLabel(2 * 86400)).toBe("2d");
    expect(windowLabel(3 * 3600)).toBe("3h");
  });
});
