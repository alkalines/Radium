import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  isWorkspaceProviderEnabled,
  workspaceProviderRecords,
} from "../../convex/provider_records";
import { requireAccessibleChat } from "../../convex/workspaces";
import type { AcpStopReason, AcpTurnReport, AcpTurnUsage } from "../acp/contract";
import { logger } from "../logging/server";
import { fetchModelsDev, type ModelsDevApi } from "../models_dev";
import {
  matchModelsDev,
  modelsDevMatchValidator,
  normalizeAcpUsage,
  workspaceQuote,
  type AgentModel,
  type AgentTurnPricing,
  type WorkspaceProviderModels,
} from "./agent_usage";
import { estimateCompletionCost } from "./completion";
import type { ProviderPricing } from "../workspaces/provider";
import { isGatewayCompletionWithoutChat } from "../workspaces/policy";
import { isTurnCovered, utcDay } from "./local_contract";

/** A matched models.dev price is refreshed weekly; a failed or empty lookup is retried daily. */
const MATCH_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const NO_MATCH_RETRY_MS = 24 * 60 * 60 * 1000;
const RESOLVE_BATCH = 50;
const REPRICE_BATCH = 100;
const MODELS_DEV_TIMEOUT_MS = 20_000;

/**
 * Record one finished turn from the bound Worker's turn-end patch, then price it in a separate
 * transaction so pricing reads (workspace provider snapshots) never slow or fail the lifecycle
 * mutation. Idempotent per prompt command: the Worker retries patches whose receipt it lost. A
 * report naming another chat's or a non-prompt command is dropped.
 */
export async function recordAcpTurn(
  ctx: MutationCtx,
  session: Doc<"acp_sessions">,
  report: AcpTurnReport,
  tokens: AcpTurnUsage | undefined,
  stopReason: AcpStopReason | undefined,
) {
  const existing = await ctx.db
    .query("acp_usage")
    .withIndex("by_chat_and_command", (q) =>
      q.eq("chat", session.chat).eq("command", report.command),
    )
    .first();
  if (existing) return;

  const commandId = ctx.db.normalizeId("acp_commands", report.command);
  const command = commandId ? await ctx.db.get(commandId) : null;
  if (!command || command.chat !== session.chat || command.kind !== "prompt") return;

  const now = Date.now();
  const agentCost =
    report.cost && Number.isFinite(report.cost.amount) && report.cost.amount >= 0
      ? { amount: report.cost.amount, currency: report.cost.currency.slice(0, 8) }
      : undefined;
  const turn = await ctx.db.insert("acp_usage", {
    workspace: session.workspace,
    chat: session.chat,
    worker: session.worker,
    agentId: session.agentId,
    command: report.command,
    userId: command.by,
    startedAt: Math.min(report.startedAt, now),
    endedAt: now,
    ...(stopReason ? { stopReason } : {}),
    // Bounded: the strings are the agent's own labels and only identify the model.
    ...(report.model
      ? {
          model: {
            id: report.model.id.slice(0, 200),
            name: report.model.name.slice(0, 200),
            ...(report.model.description
              ? { description: report.model.description.slice(0, 500) }
              : {}),
          },
        }
      : {}),
    ...(tokens ? { tokens } : {}),
    ...(agentCost ? { agentCost } : {}),
    pricing: { status: "pending" },
  });
  await ctx.scheduler.runAfter(0, internal.agent_usage.priceTurn, { turn });
}

/** Rates found for one agent model choice, and where they came from. */
type ResolvedQuote = {
  provider: string;
  slug: string;
  pricing: ProviderPricing;
  source: NonNullable<AgentTurnPricing["source"]>;
  modelName?: string;
};

/**
 * Rates for agent model choices within one mutation, cached per workspace and model. Workspace
 * provider rates win (the owner's configured Radium models); a model Radium does not define uses
 * its cached models.dev match. A model never looked up yet queues one lookup and resolves as
 * `pending` with the `acp_model_prices` id its usage should wait under; matches refresh in the
 * background. `agentKey` is the ACP agent id, or `local:<ccusage source>` for local CLI rows.
 * Call `flush` once at the end to start the resolver for queued lookups.
 */
function quoteResolver(ctx: MutationCtx) {
  const providers = new Map<Id<"workspaces">, WorkspaceProviderModels>();
  const prices = new Map<string, Doc<"acp_model_prices">>();
  const now = Date.now();
  let queuedLookup = false;

  async function resolve(
    workspace: Id<"workspaces">,
    agentKey: string,
    model: AgentModel,
  ): Promise<ResolvedQuote | { pending: string } | undefined> {
    const cacheKey = `${workspace}:${agentKey}:${model.id}`;
    let price =
      prices.get(cacheKey) ??
      (await ctx.db
        .query("acp_model_prices")
        .withIndex("by_workspace_and_agentId_and_model", (q) =>
          q.eq("workspace", workspace).eq("agentId", agentKey).eq("model", model.id),
        )
        .first());

    let workspaceProviders = providers.get(workspace);
    if (!workspaceProviders) {
      const workspaceDoc = await ctx.db.get(workspace);
      const records = workspaceDoc ? await workspaceProviderRecords(ctx, workspaceDoc) : [];
      workspaceProviders = records
        .filter(isWorkspaceProviderEnabled)
        .map((record) => ({ slug: record.provider.slug, models: record.provider.models }));
      providers.set(workspace, workspaceProviders);
    }
    const configured = workspaceQuote(workspaceProviders, model, agentKey, price?.match?.slug);
    if (configured) return { ...configured, source: "workspace", modelName: price?.match?.name };

    // A model Radium does not price is looked up on models.dev once, then refreshed in the
    // background; only its first lookup holds usage back.
    const retryAfter = price?.match ? MATCH_REFRESH_MS : NO_MATCH_RETRY_MS;
    if (!price) {
      const id = await ctx.db.insert("acp_model_prices", {
        workspace,
        agentId: agentKey,
        model: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        queued: true,
      });
      price = (await ctx.db.get(id))!;
      queuedLookup = true;
    } else if (
      !price.queued &&
      price.checkedAt !== undefined &&
      now - price.checkedAt > retryAfter
    ) {
      await ctx.db.patch(price._id, { queued: true });
      price = { ...price, queued: true };
      queuedLookup = true;
    }
    prices.set(cacheKey, price);

    if (price.match) return { ...price.match, source: "models.dev", modelName: price.match.name };
    if (price.checkedAt === undefined) return { pending: price._id };
    return undefined;
  }

  async function flush() {
    if (queuedLookup) await ctx.scheduler.runAfter(0, internal.agent_usage.resolveModelPrices, {});
  }

  return { resolve, flush };
}

/**
 * Price pending turns (`quoteResolver`). The list-price estimate wins over the cost the agent
 * reports: subscription and subsidized plans report 0 or a discounted figure, while owners compare
 * harnesses at API rates. A USD agent cost fills in only when no estimate is possible; other
 * currencies are kept but never converted.
 */
async function priceTurns(ctx: MutationCtx, turns: Doc<"acp_usage">[]) {
  const resolver = quoteResolver(ctx);

  for (const turn of turns) {
    if (turn.pricing.status !== "pending") continue;
    const resolved = turn.model
      ? await resolver.resolve(turn.workspace, turn.agentId, turn.model)
      : undefined;
    if (resolved && "pending" in resolved) {
      await ctx.db.patch(turn._id, { priceKey: resolved.pending });
      continue;
    }

    const reportedCost =
      turn.agentCost?.currency.toUpperCase() === "USD" ? turn.agentCost.amount : undefined;
    const estimatedCost =
      turn.tokens && resolved
        ? estimateCompletionCost(normalizeAcpUsage(turn.tokens), resolved.pricing).estimatedCost
        : undefined;
    const cost = estimatedCost ?? reportedCost;
    await ctx.db.patch(turn._id, {
      priceKey: undefined,
      pricing: {
        status: cost === undefined ? "unknown" : "priced",
        ...(resolved
          ? { source: resolved.source, provider: resolved.provider, slug: resolved.slug }
          : {}),
        ...(resolved?.modelName ? { modelName: resolved.modelName } : {}),
        ...(estimatedCost !== undefined ? { estimatedCost } : {}),
        ...(reportedCost !== undefined ? { reportedCost } : {}),
        ...(cost !== undefined ? { cost } : {}),
      },
    });
  }

  await resolver.flush();
}

/**
 * Fill the costs ccusage could not price in local rows: the same rates as ACP turns, keyed by
 * `local:<source>`. ccusage drops the provider from model ids, so the source is tried as the
 * routing provider first (`opencode/glm-5.3-flash-free` is an OpenCode Zen model on models.dev).
 * ccusage's own costs are never replaced.
 */
async function priceLocalRows(ctx: MutationCtx, rows: Doc<"local_usage">[]) {
  const resolver = quoteResolver(ctx);

  for (const row of rows) {
    let priceKey: string | undefined;
    const models = [];
    for (const usage of row.models) {
      if (usage.cost !== undefined) {
        models.push(usage);
        continue;
      }
      const resolved = await resolver.resolve(row.workspace, `local:${row.agent}`, {
        id: `${row.agent}/${usage.model}`,
        name: usage.model,
      });
      if (resolved && "pending" in resolved) {
        priceKey = resolved.pending;
        models.push(usage);
        continue;
      }
      const estimatedCost = resolved
        ? estimateCompletionCost(
            {
              prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
              completion_tokens: usage.outputTokens,
              completion_tokens_details: {},
              prompt_tokens_details: {
                cached_tokens: usage.cacheReadTokens,
                written_cache_tokens: usage.cacheCreationTokens,
              },
            },
            resolved.pricing,
          ).estimatedCost
        : undefined;
      models.push(estimatedCost === undefined ? usage : { ...usage, estimatedCost });
    }
    await ctx.db.patch(row._id, { models, priceKey });
  }

  await resolver.flush();
}

/** Price the unpriced models of one local row. */
export const priceLocalRow = internalMutation({
  args: { row: v.id("local_usage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.row);
    if (row) await priceLocalRows(ctx, [row]);
    return null;
  },
});

/** Price one recorded turn. */
export const priceTurn = internalMutation({
  args: { turn: v.id("acp_usage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turn);
    if (turn) await priceTurns(ctx, [turn]);
    return null;
  },
});

/** Turns and local rows waiting for a model's first models.dev lookup, in bounded batches. */
export const repricePending = internalMutation({
  args: { priceKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turns = await ctx.db
      .query("acp_usage")
      .withIndex("by_priceKey", (q) => q.eq("priceKey", args.priceKey))
      .take(REPRICE_BATCH);
    await priceTurns(ctx, turns);
    const rows = await ctx.db
      .query("local_usage")
      .withIndex("by_priceKey", (q) => q.eq("priceKey", args.priceKey))
      .take(REPRICE_BATCH);
    await priceLocalRows(ctx, rows);
    if (turns.length === REPRICE_BATCH || rows.length === REPRICE_BATCH)
      await ctx.scheduler.runAfter(0, internal.agent_usage.repricePending, args);
    return null;
  },
});

/** Model choices waiting for a models.dev lookup. */
export const queuedModelPrices = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("acp_model_prices")
      .withIndex("by_queued", (q) => q.eq("queued", true))
      .take(RESOLVE_BATCH),
});

/**
 * Store lookup results and release the turns and local rows that waited for them. A failed fetch
 * keeps the previous match (stale rates beat none) and is retried on a later turn.
 */
export const storeModelPrices = internalMutation({
  args: {
    results: v.array(
      v.object({
        id: v.id("acp_model_prices"),
        fetched: v.boolean(),
        match: v.optional(modelsDevMatchValidator),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const result of args.results) {
      const row = await ctx.db.get(result.id);
      if (!row) continue;
      await ctx.db.patch(row._id, {
        queued: false,
        checkedAt: now,
        ...(result.fetched ? { match: result.match } : {}),
      });
      await ctx.scheduler.runAfter(0, internal.agent_usage.repricePending, { priceKey: row._id });
    }
    return null;
  },
});

/**
 * Fetch the models.dev catalogue once for every queued model choice. Concurrent schedules are
 * harmless: a second run finds the queue empty or re-stores the same matches.
 */
export const resolveModelPrices = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.agent_usage.queuedModelPrices, {});
    if (rows.length === 0) return null;

    let api: ModelsDevApi | null = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
    try {
      api = await fetchModelsDev(controller.signal);
    } catch {
      logger.warn("usage.models_dev_unavailable");
    } finally {
      clearTimeout(timeout);
    }

    await ctx.runMutation(internal.agent_usage.storeModelPrices, {
      results: rows.map((row) => {
        const match = api
          ? matchModelsDev(
              api,
              { id: row.model, name: row.name, description: row.description },
              row.agentId,
            )
          : null;
        return { id: row._id, fetched: api !== null, ...(match ? { match } : {}) };
      }),
    });
    if (rows.length === RESOLVE_BATCH)
      await ctx.scheduler.runAfter(0, internal.agent_usage.resolveModelPrices, {});
    return null;
  },
});

/**
 * Estimated total cost of one Session, built-in or ACP, for anyone who can open it (the same
 * audience as the per-message Gateway cost and the agent-reported cost already shown there).
 * Built-in Sessions sum their Gateway completions. ACP Sessions sum the direct Gateway calls
 * their agent tagged with its session id, then, for days without such calls, the local rows
 * ccusage read for that session id, plus the priced turns those rows do not cover yet
 * (`isTurnCovered`), so an agent ccusage cannot read still has a total. `steps` counts what was
 * summed; `unknown` and `pending` say how much of the total is missing. Bounded to the newest
 * 1,000 rows of each source.
 */
export const GetChatCost = query({
  args: { chat: v.id("aisdk_chats") },
  returns: v.union(
    v.null(),
    v.object({ cost: v.number(), steps: v.number(), unknown: v.number(), pending: v.number() }),
  ),
  handler: async (ctx, args) => {
    let chat: Doc<"aisdk_chats">;
    try {
      ({ chat } = await requireAccessibleChat(ctx, args.chat));
    } catch {
      return null;
    }
    const summary = { cost: 0, steps: 0, unknown: 0, pending: 0 };

    const completions = await ctx.db
      .query("chat_completions")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chat))
      .order("desc")
      .take(1000);
    for (const completion of completions) {
      const cost = completion.response.pricing.cost;
      summary.steps += 1;
      if (cost === undefined) summary.unknown += 1;
      summary.cost += cost ?? 0;
    }

    const sessionId = chat.agent?.sessionId;
    // Exact Gateway figures replace the agent's own records for the days they cover.
    const gatewayDays = new Set<string>();
    const gatewayCalls =
      sessionId && chat.workspace
        ? await ctx.db
            .query("chat_completions")
            .withIndex("by_workspace_and_clientSession", (q) =>
              q.eq("bill.workspace", chat.workspace).eq("clientSession", sessionId),
            )
            .order("desc")
            .take(1000)
        : [];
    for (const completion of gatewayCalls) {
      if (!isGatewayCompletionWithoutChat(completion)) continue;
      const cost = completion.response.pricing.cost;
      gatewayDays.add(utcDay(completion._creationTime));
      summary.steps += 1;
      if (cost === undefined) summary.unknown += 1;
      summary.cost += cost ?? 0;
    }

    const localRows =
      chat.agent && sessionId && chat.workspace
        ? await ctx.db
            .query("local_usage")
            .withIndex("by_worker_and_sessionId_and_day", (q) =>
              q
                .eq("workspace", chat.workspace!)
                .eq("worker", chat.agent!.worker)
                .eq("sessionId", sessionId),
            )
            .take(1000)
        : [];
    for (const row of localRows) {
      if (gatewayDays.has(row.day)) continue;
      for (const model of row.models) {
        summary.steps += 1;
        const cost = model.cost ?? model.estimatedCost;
        if (cost === undefined && row.priceKey) summary.pending += 1;
        else if (cost === undefined) summary.unknown += 1;
        summary.cost += cost ?? 0;
      }
    }

    const turns = await ctx.db
      .query("acp_usage")
      .withIndex("by_chat_and_command", (q) => q.eq("chat", args.chat))
      .take(1000);
    for (const turn of turns) {
      if (isTurnCovered(localRows, turn.endedAt) || gatewayDays.has(utcDay(turn.endedAt))) continue;
      summary.steps += 1;
      if (turn.pricing.status === "pending") summary.pending += 1;
      else if (turn.pricing.cost === undefined) summary.unknown += 1;
      summary.cost += turn.pricing.cost ?? 0;
    }
    return summary;
  },
});
