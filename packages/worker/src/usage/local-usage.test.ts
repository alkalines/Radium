import { describe, expect, test } from "vitest";
import type { LocalUsageRow } from "backend/src/usage/local_contract";
import { sessionRows, startLocalUsageSync, type LocalUsageTransport } from "./local-usage";

const NOW = Date.parse("2026-11-05T12:00:00Z");

function session(id: string, tokens: number) {
  return {
    agent: "opencode",
    period: id,
    totalTokens: tokens,
    metadata: { lastActivity: "2026-11-05T11:00:00.000Z" },
    modelBreakdowns: [
      {
        modelName: "gpt-6-luna",
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cost: 0.01,
      },
    ],
  };
}

function fakeTransport(cursor: string | null) {
  const reports: Array<{ day: string; rows: LocalUsageRow[] }> = [];
  const finishes: Array<{ syncedThrough?: string; error?: string }> = [];
  const transport: LocalUsageTransport = {
    cursor: async () => cursor,
    report: async (args) => reports.push(args),
    finish: async (args) => finishes.push(args),
  };
  return { transport, reports, finishes };
}

describe("startLocalUsageSync", () => {
  test("a new Worker backfills 90 days and uploads only days with usage", async () => {
    const calls: string[][] = [];
    const { transport, reports, finishes } = fakeTransport(null);
    const sync = startLocalUsageSync(
      transport,
      async (args) => {
        calls.push(args);
        if (args[0] === "daily")
          return { daily: [{ period: "2026-10-01" }, { period: "2026-11-05" }] };
        return { session: [session(`s-${args[2]}`, 10)] };
      },
      () => NOW,
    );
    sync.setAvailable(true);
    await sync.idle();
    sync.close();

    expect(calls[0]).toEqual(["daily", "--since", "20260808", "--until", "20261105"]);
    expect(reports.map((report) => report.day)).toEqual(["2026-10-01", "2026-11-05"]);
    // Finished days use ccusage's bundled prices; today and yesterday fetch current ones.
    expect(calls[1]).toContain("--offline");
    expect(calls[2]).not.toContain("--offline");
    expect(finishes).toEqual([{ syncedThrough: "2026-11-05" }]);
  });

  test("an unchanged day is not uploaded again, a changed one is", async () => {
    let tokens = 10;
    const { transport, reports } = fakeTransport("2026-11-05");
    const sync = startLocalUsageSync(
      transport,
      async (args) =>
        args[0] === "daily"
          ? { daily: [{ period: "2026-11-05" }] }
          : { session: [session("s", tokens)] },
      () => NOW,
    );
    sync.setAvailable(true);
    await sync.idle();
    // A reconnect starts a new sync, like the next interval would.
    sync.setAvailable(false);
    sync.setAvailable(true);
    await sync.idle();
    expect(reports).toHaveLength(1);

    tokens = 20;
    sync.setAvailable(false);
    sync.setAvailable(true);
    await sync.idle();
    sync.close();
    expect(reports).toHaveLength(2);
    expect(reports[1]!.rows[0]!.totalTokens).toBe(20);
  });

  test("a failed ccusage run records the error and keeps the cursor", async () => {
    const { transport, reports, finishes } = fakeTransport("2026-11-01");
    const sync = startLocalUsageSync(
      transport,
      async () => {
        throw new Error("ccusage failed: no binary");
      },
      () => NOW,
    );
    sync.setAvailable(true);
    await sync.idle();
    sync.close();
    expect(reports).toEqual([]);
    expect(finishes).toEqual([{ error: "ccusage failed: no binary" }]);
  });
});

test("an unpriced model keeps no cost instead of a free zero", () => {
  const [row] = sessionRows({
    session: [
      {
        ...session("s", 5),
        modelBreakdowns: [
          {
            modelName: "glm-5.3-flash-free",
            inputTokens: 5,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: 0,
            missingPricing: true,
          },
        ],
      },
    ],
  });
  expect(row!.models[0]).not.toHaveProperty("cost");
  expect(row!.lastActivity).toBe(Date.parse("2026-11-05T11:00:00.000Z"));
});
