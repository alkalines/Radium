import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { ConvexClient } from "convex/browser";
import { api } from "backend/convex/_generated/api";
import {
  LOCAL_USAGE_BACKFILL_DAYS,
  LOCAL_USAGE_MODELS_MAX,
  LOCAL_USAGE_ROWS_PER_REPORT,
  LOCAL_USAGE_SYNC_INTERVAL_MS,
  utcDay,
  type LocalUsageRow,
} from "backend/src/usage/local_contract";

const DAY_MS = 24 * 60 * 60 * 1000;
const CCUSAGE_TIMEOUT_MS = 120_000;

/** The Convex calls local usage needs; replaceable by an in-memory transport in tests. */
export interface LocalUsageTransport {
  cursor(): Promise<string | null>;
  report(args: { day: string; syncedAt: number; rows: LocalUsageRow[] }): Promise<unknown>;
  finish(args: { syncedThrough?: string; error?: string }): Promise<unknown>;
}

/** Runs one ccusage report and returns its parsed JSON. */
export type CcusageRunner = (args: string[]) => Promise<unknown>;

/** Bind local usage to the machine-authorized Convex functions. */
export function convexLocalUsageTransport(client: ConvexClient): LocalUsageTransport {
  return {
    cursor: () => client.query(api.agent_usage.localUsageCursor, {}),
    report: (args) => client.mutation(api.agent_usage.reportLocalUsage, args),
    finish: (args) => client.mutation(api.agent_usage.finishLocalUsageSync, args),
  };
}

/**
 * Run the bundled ccusage (a direct dependency; its launcher picks the platform binary) with a
 * JSON report. Days are grouped in UTC so rows line up with Activity's daily buckets.
 */
export const runCcusage: CcusageRunner = async (args) => {
  const launcher = createRequire(import.meta.url).resolve("ccusage/src/cli.js");
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      process.execPath,
      [launcher, ...args, "--json", "--timezone", "UTC"],
      { maxBuffer: 64 * 1024 * 1024, timeout: CCUSAGE_TIMEOUT_MS },
    ));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`ccusage failed: ${reason}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("ccusage returned invalid JSON");
  }
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Days with any usage in a unified `daily` report (`period`, or `date` in older shapes). */
export function activeDays(report: unknown): string[] {
  const rows = record(report)?.daily;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const entry = record(row);
    const day = entry?.period ?? entry?.date;
    return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? [day] : [];
  });
}

/**
 * Session rows of a unified `session` report. Malformed entries are skipped; a model ccusage could
 * not price (`missingPricing`) keeps no cost, so Radium shows it as unknown rather than free.
 */
export function sessionRows(report: unknown): LocalUsageRow[] {
  const rows = record(report)?.session;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw): LocalUsageRow[] => {
    const row = record(raw);
    if (!row || typeof row.agent !== "string" || typeof row.period !== "string") return [];
    const lastActivity = Date.parse(String(record(row.metadata)?.lastActivity ?? ""));
    const breakdowns = Array.isArray(row.modelBreakdowns) ? row.modelBreakdowns : [];
    const models = breakdowns.slice(0, LOCAL_USAGE_MODELS_MAX).flatMap((rawModel) => {
      const model = record(rawModel);
      if (!model || typeof model.modelName !== "string") return [];
      const cost = model.missingPricing === true ? undefined : count(model.cost);
      return [
        {
          model: model.modelName,
          inputTokens: count(model.inputTokens),
          outputTokens: count(model.outputTokens),
          cacheReadTokens: count(model.cacheReadTokens),
          cacheCreationTokens: count(model.cacheCreationTokens),
          ...(cost !== undefined ? { cost } : {}),
        },
      ];
    });
    return [
      {
        agent: row.agent,
        sessionId: row.period,
        lastActivity: Number.isFinite(lastActivity) ? lastActivity : 0,
        totalTokens: count(row.totalTokens),
        models,
      },
    ];
  });
}

/** Local usage sync lifecycle, driven by the control connection like presence. */
export interface LocalUsageSync {
  setAvailable(available: boolean): void;
  /** Resolves when any sync in progress has finished; for shutdown and tests. */
  idle(): Promise<void>;
  close(): void;
}

/**
 * Upload this machine's coding-CLI usage while connected: once on connect, then every
 * `LOCAL_USAGE_SYNC_INTERVAL_MS`. Each sync reads only from the backend's cursor day (a new Worker
 * backfills `LOCAL_USAGE_BACKFILL_DAYS`), finds the days with usage in one `daily` report, and
 * reads sessions day by day. A day whose rows equal the last upload is not sent, so a quiet
 * machine costs one ccusage run and no writes. Failures (no supported CLI data, missing binary)
 * are recorded on the Worker's sync row and retried on the next interval, never thrown.
 */
export function startLocalUsageSync(
  transport: LocalUsageTransport,
  runner: CcusageRunner = runCcusage,
  now: () => number = Date.now,
): LocalUsageSync {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let running: Promise<void> = Promise.resolve();
  let syncing = false;
  const uploaded = new Map<string, string>();

  async function sync() {
    const today = utcDay(now());
    const yesterday = utcDay(now() - DAY_MS);
    const earliest = utcDay(now() - (LOCAL_USAGE_BACKFILL_DAYS - 1) * DAY_MS);
    try {
      const cursor = await transport.cursor();
      const from = cursor && cursor > earliest ? cursor : earliest;
      const days = activeDays(
        await runner([
          "daily",
          "--since",
          from.replaceAll("-", ""),
          "--until",
          today.replaceAll("-", ""),
        ]),
      ).filter((day) => day >= from && day <= today);

      for (const day of days.sort()) {
        if (closed) return;
        const syncedAt = now();
        const compact = day.replaceAll("-", "");
        // Older days are final; their prices come from ccusage's bundled table without a fetch.
        const offline = day < yesterday ? ["--offline"] : [];
        const rows = sessionRows(
          await runner(["session", "--since", compact, "--until", compact, ...offline]),
        );
        const digest = JSON.stringify(rows);
        if (uploaded.get(day) === digest) continue;
        for (let start = 0; start < rows.length; start += LOCAL_USAGE_ROWS_PER_REPORT) {
          await transport.report({
            day,
            syncedAt,
            rows: rows.slice(start, start + LOCAL_USAGE_ROWS_PER_REPORT),
          });
        }
        uploaded.set(day, digest);
      }
      // Today stays open: the next sync re-reads it (and yesterday's late writes) from here.
      await transport.finish({ syncedThrough: today });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local usage sync failed";
      await transport.finish({ error: message }).catch(() => undefined);
    }
  }

  function trigger() {
    if (closed || syncing) return;
    syncing = true;
    running = sync().finally(() => {
      syncing = false;
    });
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
  }

  return {
    setAvailable(available) {
      if (closed) return;
      if (!available) {
        stop();
        return;
      }
      if (timer) return;
      trigger();
      timer = setInterval(trigger, LOCAL_USAGE_SYNC_INTERVAL_MS);
    },
    idle: () => running,
    close() {
      closed = true;
      stop();
    },
  };
}
