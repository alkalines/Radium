import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOwnedWorkspace } from "./workspaces";

type WorkspaceContext = QueryCtx;

async function completionsForWorkspace(
  ctx: WorkspaceContext,
  workspace: Doc<"workspaces">,
  since?: number,
  limit = 200,
) {
  const current = since
    ? await ctx.db
        .query("chat_completions")
        .withIndex("by_workspace", (q) =>
          q.eq("bill.workspace", workspace._id).gte("_creationTime", since),
        )
        .order("desc")
        .take(limit)
    : await ctx.db
        .query("chat_completions")
        .withIndex("by_workspace", (q) => q.eq("bill.workspace", workspace._id))
        .order("desc")
        .take(limit);

  if (!workspace.legacyBalance) return current;

  const legacy = since
    ? await ctx.db
        .query("chat_completions")
        .withIndex("by_balance", (q) =>
          q.eq("bill.balance", workspace.legacyBalance!).gte("_creationTime", since),
        )
        .order("desc")
        .take(limit)
    : await ctx.db
        .query("chat_completions")
        .withIndex("by_balance", (q) => q.eq("bill.balance", workspace.legacyBalance!))
        .order("desc")
        .take(limit);
  const byId = new Map(current.map((completion) => [completion._id, completion]));
  for (const completion of legacy) byId.set(completion._id, completion);
  return [...byId.values()].sort((a, b) => b._creationTime - a._creationTime).slice(0, limit);
}

/** Per-generation usage metadata for a workspace. */
export const getGenerations = query({
  args: {
    workspace: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const completions = await completionsForWorkspace(
      ctx,
      workspace,
      undefined,
      Math.min(Math.max(args.limit ?? 100, 1), 200),
    );

    return Promise.all(
      completions.map(async (completion) => {
        const model = await ctx.db.get("models", completion.request.model);
        const apiKey = completion.bill.apiKey
          ? await ctx.db.get("api_keys", completion.bill.apiKey)
          : null;
        const legacyKey =
          !apiKey && completion.bill.key ? await ctx.db.get("keys", completion.bill.key) : null;
        const key = apiKey ?? legacyKey;
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
        };
      }),
    );
  },
});

/** Aggregated workspace activity for a bounded reporting window. */
export const getActivity = query({
  args: {
    workspace: v.id("workspaces"),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const completions = await completionsForWorkspace(ctx, workspace, args.since, 2001);
    const truncated = completions.length > 2000;
    const windowedCompletions = completions.slice(0, 2000);

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
    const byKey = new Map<string, { requests: number; cost: number }>();
    const usageTypes = { byok: { requests: 0, cost: 0 } };

    for (const completion of windowedCompletions) {
      const { usage, pricing } = completion.response;
      const tokens = usage.prompt_tokens + usage.completion_tokens;
      const modelId = completion.request.model;
      const keyId = completion.bill.apiKey
        ? `api:${completion.bill.apiKey}`
        : completion.bill.key
          ? `legacy:${completion.bill.key}`
          : "unattributed";
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

      usageTypes.byok.requests += 1;
      usageTypes.byok.cost += pricing.cost;

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
      Promise.all(
        topKeys.map(async ([id]) => {
          if (id === "unattributed") return null;
          if (id.startsWith("legacy:")) {
            return await ctx.db.get("keys", id.slice("legacy:".length) as Id<"keys">);
          }
          return await ctx.db.get("api_keys", id.slice("api:".length) as Id<"api_keys">);
        }),
      ),
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
