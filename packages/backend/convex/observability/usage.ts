import { v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireOwnedWorkspace } from "../workspaces";
import { filterVisibleCompletions, type AttributedCompletion } from "../chatroom";
import { credentialDisplayName } from "../../src/workspaces/credentials";

async function completionsForWorkspace(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  since?: number,
  readLimit = 200,
  outputLimit = readLimit,
) {
  // Keep the legacy index in the read path until ownership backfill verification is complete.
  const current =
    since !== undefined
      ? await ctx.db
          .query("chat_completions")
          .withIndex("by_workspace", (q) =>
            q.eq("bill.workspace", workspace._id).gte("_creationTime", since),
          )
          .order("desc")
          .take(readLimit)
      : await ctx.db
          .query("chat_completions")
          .withIndex("by_workspace", (q) => q.eq("bill.workspace", workspace._id))
          .order("desc")
          .take(readLimit);

  const legacy = workspace.legacyBalance
    ? since !== undefined
      ? await ctx.db
          .query("chat_completions")
          .withIndex("by_balance", (q) =>
            q.eq("bill.balance", workspace.legacyBalance!).gte("_creationTime", since),
          )
          .order("desc")
          .take(readLimit)
      : await ctx.db
          .query("chat_completions")
          .withIndex("by_balance", (q) => q.eq("bill.balance", workspace.legacyBalance!))
          .order("desc")
          .take(readLimit)
    : [];
  // Migrated rows can match both indexes; deduplicate before applying private-chat visibility.
  const byId = new Map(current.map((completion) => [completion._id, completion]));
  for (const completion of legacy) byId.set(completion._id, completion);
  const visible = await filterVisibleCompletions(ctx, workspace, [
    ...byId.values(),
  ] as AttributedCompletion[]);
  return visible.sort((a, b) => b._creationTime - a._creationTime).slice(0, outputLimit);
}

/** Recent owner-visible usage estimates; this is not a balance or billing read. */
export const getUsage = query({
  args: {
    workspace: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const completions = await completionsForWorkspace(ctx, workspace, undefined, limit * 2, limit);
    const recent = completions.map((completion) => ({
      _id: completion._id,
      _creationTime: completion._creationTime,
      provider: completion.request.provider,
      byok: completion.request.byok,
      cost: completion.response.pricing.cost,
      usage: {
        prompt_tokens: completion.response.usage.prompt_tokens,
        completion_tokens: completion.response.usage.completion_tokens,
      },
    }));
    return {
      completions: recent.length,
      spentRecent: recent.reduce((total, completion) => total + (completion.cost ?? 0), 0),
      unknownCostRequests: recent.filter((completion) => completion.cost === undefined).length,
      recent,
    };
  },
});

/** Per-generation usage metadata for the workspace owner; members have no general Gateway access. */
export const getGenerations = query({
  args: {
    workspace: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const completions = await completionsForWorkspace(ctx, workspace, undefined, limit * 2, limit);

    return Promise.all(
      completions.map(async (completion) => {
        const model = await ctx.db.get("models", completion.request.model);
        const apiKey = completion.bill.apiKey
          ? await ctx.db.get("api_keys", completion.bill.apiKey)
          : null;
        const legacyKey =
          !apiKey && completion.bill.key ? await ctx.db.get("keys", completion.bill.key) : null;
        const key = apiKey ?? legacyKey;
        const credential = completion.request.credential
          ? await ctx.db.get("workspace_credentials", completion.request.credential)
          : null;
        return {
          _id: completion._id,
          _creationTime: completion._creationTime,
          apiKey: key ? { name: key.name, preview: key.preview } : null,
          request: {
            provider: completion.request.provider,
            /** Absent when the credential was removed, legacy, or the row predates pools. */
            credentialName: credential ? credentialDisplayName(credential) : undefined,
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

/**
 * Aggregated workspace activity for the owner only; members have no general
 * Gateway access. Costs are historical estimates, never billing or debits.
 */
export const getActivity = query({
  args: {
    workspace: v.id("workspaces"),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    // Read one beyond the response cap so the owner can see that this window was truncated.
    const completions = await completionsForWorkspace(ctx, workspace, args.since, 2001);
    const truncated = completions.length > 2000;
    const windowedCompletions = completions.slice(0, 2000);

    const summary = {
      spend: 0,
      unknownCostRequests: 0,
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
    // Keep historical credit traffic separate from current BYOK estimates.
    const usageTypes = {
      byok: { requests: 0, cost: 0 },
      legacyCredits: { requests: 0, cost: 0 },
    };

    for (const completion of windowedCompletions) {
      const { usage, pricing } = completion.response;
      const tokens = usage.prompt_tokens + usage.completion_tokens;
      const modelId = completion.request.model;
      let keyId = "unattributed";
      if (completion.bill.apiKey) {
        keyId = `api:${completion.bill.apiKey}`;
      } else if (completion.bill.key) {
        keyId = `legacy:${completion.bill.key}`;
      }
      const date = new Date(completion._creationTime).toISOString().slice(0, 10);

      if (pricing.cost === undefined) summary.unknownCostRequests += 1;
      summary.spend += pricing.cost ?? 0;
      summary.promptTokens += usage.prompt_tokens;
      summary.completionTokens += usage.completion_tokens;
      summary.reasoningTokens += usage.completion_tokens_details.reasoning_tokens ?? 0;
      summary.cachedTokens += usage.prompt_tokens_details.cached_tokens ?? 0;
      summary.writtenCacheTokens += usage.prompt_tokens_details.written_cache_tokens ?? 0;

      const model = byModel.get(modelId) ?? { requests: 0, tokens: 0, cost: 0 };
      model.requests += 1;
      model.tokens += tokens;
      model.cost += pricing.cost ?? 0;
      byModel.set(modelId, model);

      const key = byKey.get(keyId) ?? { requests: 0, cost: 0 };
      key.requests += 1;
      key.cost += pricing.cost ?? 0;
      byKey.set(keyId, key);

      const usageType = completion.request.byok ? usageTypes.byok : usageTypes.legacyCredits;
      usageType.requests += 1;
      usageType.cost += pricing.cost ?? 0;

      const day = daily.get(date) ?? { date, cost: 0, requests: 0, models: {} };
      day.cost += pricing.cost ?? 0;
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
            const key = await ctx.db.get("keys", id.slice("legacy:".length) as Id<"keys">);
            return key ? { id, name: key.name } : null;
          }
          const key = await ctx.db.get("api_keys", id.slice("api:".length) as Id<"api_keys">);
          return key ? { id, name: key.name } : null;
        }),
      ),
    ]);
    const modelNames = new Map<string, string>(
      models.filter((model) => model !== null).map((model) => [model._id, model.name]),
    );
    const keyNames = new Map<string, string>(
      keys.filter((key) => key !== null).map((key) => [key.id, key.name]),
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
