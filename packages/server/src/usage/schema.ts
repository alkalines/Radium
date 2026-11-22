import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { acpStopReasonValidator, type AcpTurnUsage } from "contracts/acp/contract";
import type { StoredLocalUsageModel } from "contracts/usage/local_contract";
import type { ProviderPricing } from "contracts/workspaces/provider";
import { user } from "../auth/schema";
import { checkIn, createdAt, id, instant, json, literals } from "../db/columns";
import { chats } from "../chatroom/schema";
import { aiApps, apiKeys, models, workspaceCredentials } from "../gateway/schema";
import { workers } from "../worker/schema";
import { workspaces } from "../workspaces/schema";

/** Token counts a completion reports besides prompt and completion totals (OpenAI usage shape). */
export type CompletionUsageDetails = {
  completion_tokens_details: { reasoning_tokens?: number | null };
  prompt_tokens_details: {
    cached_tokens?: number | null;
    written_cache_tokens?: number | null;
    written_cache_tokens_1h?: number | null;
  };
};

/** USD cost of each token bucket of a completion; the totals are columns. */
export type CompletionPricingDetails = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details: {
    cached_tokens?: number;
    written_cache_tokens?: number;
    written_cache_tokens_1h?: number;
  };
  cost_details?: { upstream_inference_cost?: number };
};

/** Price state of one ACP turn; `cost` is USD (`estimated ?? reported`), absent when unknown. */
export type AgentTurnPricing = {
  status: "pending" | "priced" | "unknown";
  /** Where the rates came from: a workspace provider or the models.dev catalogue. */
  source?: "workspace" | "models.dev";
  /** Provider slug (workspace) or models.dev provider id that supplied the rates. */
  provider?: string;
  /** Radium canonical model slug (`author/model`), which groups the turn with Gateway traffic. */
  slug?: string;
  /** Catalogue display name of the matched model. */
  modelName?: string;
  estimatedCost?: number;
  /** Agent-reported USD cost of the turn; used only when no estimate is possible. */
  reportedCost?: number;
  cost?: number;
};

/** A models.dev model matched to an agent's model choice, with its per-token rates. */
export type ModelsDevMatch = {
  provider: string;
  modelId: string;
  name: string;
  slug: string;
  pricing: ProviderPricing;
};

/**
 * One Gateway completion: who called, what served it, tokens, timings and the operational cost
 * estimate (BYOK, never a charge). Written once per completion; Usage, Limits budgets and
 * Gateway logs read it, always through Chatroom privacy: a row with a `chat` or `user_id` is
 * never Gateway traffic, so deleting a chat (`chat` set null) cannot expose its completions.
 * Rows without a `chat` and `user_id` count as Gateway usage only when they carry an `api_key`.
 */
export const chatCompletions = pgTable(
  "chat_completions",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Chatroom-generated completions only. Set null when the chat is deleted; `user_id` stays. */
    chat: text("chat").references(() => chats.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "restrict" }),
    /**
     * Direct Gateway calls only: the client's own session id (session header, `session_id` or
     * `prompt_cache_key`). Coding agents send theirs, which joins the call to the agent session.
     */
    clientSession: text("client_session"),
    // API keys are revoked, never deleted; the edge is a plain reference (`no action` so a
    // workspace delete can remove keys and completions in one statement).
    apiKey: text("api_key").references(() => apiKeys.id, { onDelete: "no action" }),
    provider: text("provider").notNull(),
    /** Provider credential that served the completion; set null when the credential is removed. */
    credential: text("credential").references(() => workspaceCredentials.id, {
      onDelete: "set null",
    }),
    /** `false` only on historical credit-billed rows. */
    byok: boolean("byok").notNull(),
    app: text("app").references(() => aiApps.id, { onDelete: "restrict" }),
    // Models are never deleted.
    model: text("model")
      .notNull()
      .references(() => models.id, { onDelete: "restrict" }),
    streamed: boolean("streamed").notNull(),
    canceled: boolean("canceled").notNull(),
    requestedServiceTier: text("requested_service_tier"),
    inferenceMode: text("inference_mode"),
    quoteSource: text("quote_source"),
    /** Rates the request was quoted at when dispatched. */
    quote: json<ProviderPricing>("quote"),
    genId: text("gen_id").notNull(),
    providerGenId: text("provider_gen_id").notNull(),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull(),
    completionTokens: bigint("completion_tokens", { mode: "number" }).notNull(),
    /** Reasoning and cache token counts (`response.usage` minus the two totals). */
    usageDetails: json<CompletionUsageDetails>("usage_details").notNull(),
    /** `reported_cost ?? estimated_cost`, USD; null when the cost is unknown, never zero. */
    cost: doublePrecision("cost"),
    estimatedCost: doublePrecision("estimated_cost"),
    reportedCost: doublePrecision("reported_cost"),
    /** Per-bucket costs and the upstream inference cost (`response.pricing` minus the totals). */
    pricingDetails: json<CompletionPricingDetails>("pricing_details").notNull(),
    moderationLatency: doublePrecision("moderation_latency"),
    /** Time to first token, ms. */
    ttft: doublePrecision("ttft").notNull(),
    /** Generation time, ms. */
    genTime: doublePrecision("gen_time").notNull(),
    finishReason: text("finish_reason").notNull(),
    servedServiceTier: text("served_service_tier"),
    servedQuote: json<ProviderPricing>("served_quote"),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "chat_completions_tokens",
      sql`${table.promptTokens} >= 0 and ${table.completionTokens} >= 0`,
    ),
    // Owner usage and logs: a workspace's newest completions (usage.GetUsage, usage.GetActivity,
    // usage.GetGenerations); routing's latency sample reads the same range.
    index("chat_completions_workspace_created").on(table.workspace, table.createdAt),
    // Budget meter: a credential's cost since the period start (limits.budgetMeter); also the
    // leading column of the `set null` when a credential is removed.
    index("chat_completions_credential_created")
      .on(table.credential, table.createdAt)
      .where(sql`${table.credential} is not null`),
    // Session cost: one chat's completions (usage.GetChatCost); also the `set null` when the
    // chat is deleted.
    index("chat_completions_chat_created")
      .on(table.chat, table.createdAt)
      .where(sql`${table.chat} is not null`),
    // Session cost of an ACP Session's direct Gateway calls, by its agent session id
    // (usage.GetChatCost, usage.GetActivity).
    index("chat_completions_workspace_client_session")
      .on(table.workspace, table.clientSession, table.createdAt)
      .where(sql`${table.clientSession} is not null`),
  ],
);

/**
 * Coding-CLI usage read from a Worker machine's own logs by ccusage: one row per session per UTC
 * day, token counts and costs only (`contracts/usage/local_contract`). Models ccusage could not
 * price get Radium's estimate; `price_key` is set while one waits for a models.dev lookup.
 */
export const localUsage = pgTable(
  "local_usage",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    worker: text("worker").notNull(),
    /** ccusage source id (`claude`, `codex`, `opencode`, …). */
    agent: text("agent").notNull(),
    /** The CLI's own session id, which ACP agents also use as their ACP session id. */
    sessionId: text("session_id").notNull(),
    /** UTC day the row covers. */
    day: date("day", { mode: "string" }).notNull(),
    /** When ccusage started reading the logs; turns that ended before it are inside the row. */
    syncedAt: instant("synced_at").notNull(),
    lastActivity: instant("last_activity").notNull(),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
    models: json<StoredLocalUsageModel[]>("models").notNull(),
    /** Set only while a model waits for its first models.dev lookup (`acp_model_prices` id). */
    priceKey: text("price_key").references(() => acpModelPrices.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    check("local_usage_total_tokens", sql`${table.totalTokens} >= 0`),
    foreignKey({
      name: "local_usage_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
    }).onDelete("cascade"),
    // One row per Worker, session, day and CLI (the report upserts on it). Worker ids are
    // global, so the workspace is not part of the key. Its `(worker, session_id)` prefix also
    // serves the session cost read (usage.GetChatCost).
    uniqueIndex("local_usage_worker_session_day_agent").on(
      table.worker,
      table.sessionId,
      table.day,
      table.agent,
    ),
    // Activity: a workspace's rows since a day, newest first (usage.GetActivity).
    index("local_usage_workspace_day").on(table.workspace, table.day),
    // Release the rows waiting for a model's lookup (usage.repricePending); also the `set null`
    // from `acp_model_prices`.
    index("local_usage_price_key")
      .on(table.priceKey)
      .where(sql`${table.priceKey} is not null`),
  ],
);

/** Each Worker's local usage cursor and last sync result. One row per Worker. */
export const localUsageSyncs = pgTable(
  "local_usage_syncs",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    worker: text("worker").notNull(),
    /** The last UTC day uploaded; the Worker re-reads only from there. */
    syncedThrough: date("synced_through", { mode: "string" }),
    lastSyncAt: instant("last_sync_at").notNull(),
    /** Short error of the last failed sync. */
    error: text("error"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "local_usage_syncs_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
    }).onDelete("cascade"),
    // One cursor per Worker (usage.finishLocalUsageSync, usage.localUsageCursor).
    uniqueIndex("local_usage_syncs_worker").on(table.worker),
    // Activity: every Worker's sync state in a workspace (usage.LocalUsageSyncs).
    index("local_usage_syncs_workspace").on(table.workspace),
  ],
);

/**
 * models.dev matches of a workspace's agent model choices, so a model Radium does not define is
 * fetched once and refreshed weekly rather than on every turn. `queued` rows await the resolver.
 */
export const acpModelPrices = pgTable(
  "acp_model_prices",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The ACP agent id, or `local:<ccusage source>` for local CLI rows. */
    agentId: text("agent_id").notNull(),
    model: text("model").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    queued: boolean("queued").notNull(),
    checkedAt: instant("checked_at"),
    match: json<ModelsDevMatch>("match"),
    createdAt: createdAt(),
  },
  (table) => [
    // A queued lookup has not run yet; every other row was checked.
    check("acp_model_prices_checked", sql`${table.queued} or ${table.checkedAt} is not null`),
    // One price row per agent model choice (usage quote resolver).
    uniqueIndex("acp_model_prices_workspace_agent_model").on(
      table.workspace,
      table.agentId,
      table.model,
    ),
    // The resolver's queue, oldest first (usage.queuedModelPrices).
    index("acp_model_prices_queued")
      .on(table.createdAt)
      .where(sql`${table.queued}`),
  ],
);

/**
 * One finished ACP prompt turn's usage: metadata only, never content. Reported by the bound
 * Worker with the turn-end patch; the server prices it (`pricing`). Project and visibility follow
 * the chat at read time, and every read filters by chat visibility, so a deleted chat's turns are
 * never read: they go with the chat.
 */
export const acpUsage = pgTable(
  "acp_usage",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chat: text("chat").notNull(),
    worker: text("worker").notNull(),
    agentId: text("agent_id").notNull(),
    /**
     * The claimed prompt command's id. Not a reference: finished commands are pruned while their
     * usage stays, and the key must keep deduplicating the Worker's retried patches.
     */
    command: text("command").notNull(),
    /** The user who sent the prompt. */
    userId: text("user_id").references(() => user.id, { onDelete: "restrict" }),
    startedAt: instant("started_at").notNull(),
    endedAt: instant("ended_at").notNull(),
    stopReason: text("stop_reason", { enum: literals(acpStopReasonValidator) }),
    /** The agent's model choice for the turn (`acpTurnModel`); id and name are set together. */
    modelId: text("model_id"),
    modelName: text("model_name"),
    modelDescription: text("model_description"),
    tokens: json<AcpTurnUsage>("tokens"),
    /** The turn's share of the agent's cumulative cost, in the agent's currency. */
    agentCostAmount: doublePrecision("agent_cost_amount"),
    agentCostCurrency: text("agent_cost_currency"),
    pricing: json<AgentTurnPricing>("pricing").notNull(),
    /** Set only while the turn waits for a models.dev match (`acp_model_prices` id). */
    priceKey: text("price_key").references(() => acpModelPrices.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "acp_usage_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    foreignKey({
      name: "acp_usage_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
    }).onDelete("cascade"),
    checkIn("acp_usage_stop_reason", table.stopReason, literals(acpStopReasonValidator)),
    check("acp_usage_model", sql`num_nonnulls(${table.modelId}, ${table.modelName}) in (0, 2)`),
    check(
      "acp_usage_model_description",
      sql`${table.modelDescription} is null or ${table.modelId} is not null`,
    ),
    check(
      "acp_usage_agent_cost",
      sql`num_nonnulls(${table.agentCostAmount}, ${table.agentCostCurrency}) in (0, 2) and ${table.agentCostAmount} >= 0`,
    ),
    // One row per prompt command, even when the Worker retries the patch (usage.recordAcpTurn);
    // also the leading column of the cascade from `chats`.
    uniqueIndex("acp_usage_chat_command").on(table.chat, table.command),
    // Activity: a workspace's turns since a time, newest first (usage.GetActivity).
    index("acp_usage_workspace_created").on(table.workspace, table.createdAt),
    // Release the turns waiting for a model's lookup (usage.repricePending); also the `set
    // null` from `acp_model_prices`.
    index("acp_usage_price_key")
      .on(table.priceKey)
      .where(sql`${table.priceKey} is not null`),
  ],
);
