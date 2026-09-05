import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwnedBalance } from "./keys";

/**
 * Per-generation logs for a balance: the full request/response metadata for each
 * billed completion, used to render the gateway's Logs view.
 *
 * Unlike {@link api.credits.getCredits} — which only summarises spend — this
 * returns the complete persisted metadata for every generation (provider,
 * generation IDs, token usage, pricing breakdown, latency, finish reason).
 */
export const getGenerations = query({
  args: {
    balance: v.id("balances"),
    /** How many recent generations to return (defaults to 100, capped at 200). */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const completions = await ctx.db
      .query("chat_completions")
      .withIndex("by_balance", (q) => q.eq("bill.balance", args.balance))
      .order("desc")
      .take(Math.min(args.limit ?? 100, 200));

    return Promise.all(
      completions.map(async (completion) => {
        const model = await ctx.db.get("models", completion.request.model);
        const key = completion.bill.key ? await ctx.db.get("keys", completion.bill.key) : null;
        return {
          _id: completion._id,
          _creationTime: completion._creationTime,
          apiKey: key ? { name: key.name, preview: key.preview } : null,
          request: {
            provider: completion.request.provider,
            byok: completion.request.byok,
            streamed: completion.request.streamed,
            canceled: completion.request.canceled,
            model: model ? { id: model._id, name: model.name, slug: model.slug } : null,
          },
          response: completion.response,
          // @todo Surface the full request payload — system message, tools,
          // tool calls, and user/assistant messages — once `chat_completions`
          // persists it. This will be opt-in since transcripts can be large and
          // may contain sensitive content (à la the AI SDK Devtools).
        };
      }),
    );
  },
});

/** Aggregated gateway activity for a bounded reporting window. */
export const getActivity = query({
  args: {
    balance: v.id("balances"),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const limit = 2000;
    const completions = await ctx.db
      .query("chat_completions")
      .withIndex("by_balance", (q) =>
        q.eq("bill.balance", args.balance).gte("_creationTime", args.since),
      )
      .order("desc")
      .take(limit + 1);
    const truncated = completions.length > limit;
    const windowedCompletions = completions.slice(0, limit);

    const summary = {
      spend: 0,
      requests: windowedCompletions.length,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      writtenCacheTokens: 0,
    };
    const daily = new Map<
      string,
      { date: string; cost: number; requests: number; models: Record<string, number> }
    >();
    const byModel = new Map<Id<"models">, { requests: number; tokens: number; cost: number }>();
    const byKey = new Map<Id<"keys"> | "unattributed", { requests: number; cost: number }>();
    const usageTypes = {
      byok: { requests: 0, cost: 0 },
      credits: { requests: 0, cost: 0 },
    };

    for (const completion of windowedCompletions) {
      const { usage, pricing } = completion.response;
      const tokens = usage.prompt_tokens + usage.completion_tokens;
      const modelId = completion.request.model;
      const keyId = completion.bill.key ?? "unattributed";
      const date = new Date(completion._creationTime).toISOString().slice(0, 10);

      summary.spend += pricing.cost;
      summary.promptTokens += usage.prompt_tokens;
      summary.completionTokens += usage.completion_tokens;
      summary.reasoningTokens += usage.completion_tokens_details.reasoning_tokens ?? 0;
      summary.cachedTokens += usage.prompt_tokens_details.cached_tokens ?? 0;
      summary.writtenCacheTokens += usage.prompt_tokens_details.written_cache_tokens ?? 0;

      const model = byModel.get(modelId) ?? { requests: 0, tokens: 0, cost: 0 };
      model.requests += 1;
      model.tokens += tokens;
      model.cost += pricing.cost;
      byModel.set(modelId, model);

      const key = byKey.get(keyId) ?? { requests: 0, cost: 0 };
      key.requests += 1;
      key.cost += pricing.cost;
      byKey.set(keyId, key);

      const usageType = completion.request.byok ? usageTypes.byok : usageTypes.credits;
      usageType.requests += 1;
      usageType.cost += pricing.cost;

      const day = daily.get(date) ?? { date, cost: 0, requests: 0, models: {} };
      day.cost += pricing.cost;
      day.requests += 1;
      day.models[modelId] = (day.models[modelId] ?? 0) + 1;
      daily.set(date, day);
    }

    const topModels = [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 10);
    const topKeys = [...byKey.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, 5);
    const [models, keys] = await Promise.all([
      Promise.all(topModels.map(([id]) => ctx.db.get("models", id))),
      Promise.all(topKeys.map(([id]) => (id === "unattributed" ? null : ctx.db.get("keys", id)))),
    ]);
    const modelNames = new Map<string, string>(
      models.filter((model) => model !== null).map((model) => [model._id, model.name]),
    );
    const keyNames = new Map<string, string>(
      keys.filter((key) => key !== null).map((key) => [key._id, key.name]),
    );

    return {
      summary,
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      models: topModels
        .map(([id, values]) => ({ id, name: modelNames.get(id) ?? "Unknown model", ...values }))
        .sort((a, b) => b.tokens - a.tokens),
      apiKeys: topKeys
        .map(([id, values]) => ({
          id,
          name: id === "unattributed" ? "Radium Chatroom" : (keyNames.get(id) ?? "Deleted key"),
          ...values,
        }))
        .sort((a, b) => b.requests - a.requests),
      usageTypes,
      truncated,
    };
  },
});
