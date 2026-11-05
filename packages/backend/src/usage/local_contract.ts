import { v, type Infer } from "convex/values";

/**
 * Local usage contract, shared by Convex and the Worker: what coding CLIs on a Worker's machine
 * logged, read by ccusage (https://ccusage.com) on the Worker and uploaded as one row per session
 * per UTC day. It covers every CLI ccusage supports, including sessions run outside Radium. Costs
 * are ccusage's estimates, kept as reported; a model ccusage cannot price has no cost (unknown,
 * not free). Rows hold token counts only, never conversation content.
 */

/** Days of history a new Worker uploads, matching Activity's longest range. */
export const LOCAL_USAGE_BACKFILL_DAYS = 90;
/** How often a connected Worker re-reads its logs. */
export const LOCAL_USAGE_SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** Rows per `reportLocalUsage` call. */
export const LOCAL_USAGE_ROWS_PER_REPORT = 100;
/** Models kept per row; more would be a malformed report. */
export const LOCAL_USAGE_MODELS_MAX = 32;
export const LOCAL_USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** One model's tokens in a session-day; `cost` is ccusage's USD estimate, absent when unpriced. */
export const localUsageModelValidator = v.object({
  model: v.string(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheReadTokens: v.number(),
  cacheCreationTokens: v.number(),
  cost: v.optional(v.number()),
});
export type LocalUsageModel = Infer<typeof localUsageModelValidator>;

/**
 * A model as stored: the Worker's report plus `estimatedCost`, Radium's price for a model ccusage
 * could not price (workspace rates, then models.dev). Readers use `cost ?? estimatedCost`.
 */
export const storedLocalUsageModelValidator = v.object({
  ...localUsageModelValidator.fields,
  estimatedCost: v.optional(v.number()),
});
export type StoredLocalUsageModel = Infer<typeof storedLocalUsageModelValidator>;

/**
 * One session's usage on one day. `agent` is ccusage's source id (`claude`, `codex`, `opencode`,
 * …); `sessionId` is the CLI's own session id, which ACP agents also use as their ACP session id.
 * `totalTokens` is ccusage's total, which also counts reasoning tokens absent from the models.
 */
export const localUsageRowValidator = v.object({
  agent: v.string(),
  sessionId: v.string(),
  lastActivity: v.number(),
  totalTokens: v.number(),
  models: v.array(localUsageModelValidator),
});
export type LocalUsageRow = Infer<typeof localUsageRowValidator>;

/** ccusage source ids as the CLIs call themselves. */
const LOCAL_AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  droid: "Droid",
  codebuff: "Codebuff",
  hermes: "Hermes Agent",
  pi: "pi-agent",
  goose: "Goose",
  openclaw: "OpenClaw",
  kilo: "Kilo",
  kimi: "Kimi",
  qwen: "Qwen",
  copilot: "Copilot CLI",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  grok: "Grok Build CLI",
  zcode: "ZCode",
};

/** Display name of a ccusage source id. */
export function localAgentName(agent: string) {
  return LOCAL_AGENT_NAMES[agent] ?? agent;
}

/** The UTC day key ccusage rows are grouped by (`--timezone UTC`). */
export function utcDay(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Whether a Radium-reported ACP turn is already inside a session's local rows: ccusage read the
 * session's logs that day after the turn ended. Turns ccusage has not seen yet (or never will, for
 * CLIs it cannot read) keep counting on their own, so nothing is dropped or counted twice.
 */
export function isTurnCovered(rows: Array<{ day: string; syncedAt: number }>, endedAt: number) {
  const day = utcDay(endedAt);
  return rows.some((row) => row.day === day && row.syncedAt >= endedAt);
}
