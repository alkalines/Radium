import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { AddFunction, MultiplyFunction } from "@/utils/math";
import { canAccessWorkspace, isByokRequest } from "../src/utils/workspaces/policy";
import { providerSnapshotFromCatalog } from "../src/utils/workspaces/provider";

export const hashAlgorithm = "SHA-512";
export const hashText = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        {
          name: hashAlgorithm,
        },
        new TextEncoder().encode(text),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export function isRevokedKey(record: { revokedAt?: number } | null | undefined): boolean {
  return record?.revokedAt !== undefined;
}

/**
 * Resolve a Gateway bearer key without using browser session authentication.
 * New keys are workspace-owned; the legacy branch exists only while the
 * widen-migrate-narrow rollout has not completed.
 */
export const getKeyInfo = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const hash = await hashText(args.key);
    const apiKey = await ctx.db
      .query("api_keys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();

    if (apiKey) {
      if (isRevokedKey(apiKey)) throw new Error("This key is invalid!");
      const legacyKey = apiKey.legacyKey ? await ctx.db.get("keys", apiKey.legacyKey) : null;
      if (apiKey.legacyKey && (!legacyKey || isRevokedKey(legacyKey))) {
        throw new Error("This key is invalid!");
      }
      const workspace = await ctx.db.get("workspaces", apiKey.workspace);
      if (!workspace || !canAccessWorkspace(workspace, workspace.ownerId)) {
        throw new Error("This key is invalid!");
      }
      if (
        legacyKey &&
        (legacyKey.hash !== apiKey.hash ||
          workspace.legacyBalance === undefined ||
          legacyKey.balance !== workspace.legacyBalance)
      ) {
        throw new Error("This key is invalid!");
      }

      return {
        _id: apiKey._id,
        _creationTime: apiKey._creationTime,
        name: apiKey.name,
        preview: apiKey.preview,
        workspace: workspace._id,
        apiKey: apiKey._id,
        userId: workspace.ownerId,
      };
    }

    const legacyKey = await ctx.db
      .query("keys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    if (!legacyKey) throw new Error("This key is invalid!");
    if (isRevokedKey(legacyKey)) throw new Error("This key is invalid!");

    const migratedKey = await ctx.db
      .query("api_keys")
      .withIndex("by_legacyKey", (q) => q.eq("legacyKey", legacyKey._id))
      .first();
    if (migratedKey && (isRevokedKey(migratedKey) || migratedKey.hash !== legacyKey.hash)) {
      throw new Error("This key is invalid!");
    }

    const balance = await ctx.db.get("balances", legacyKey.balance);
    if (!balance) throw new Error("This key is invalid!");
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_legacyBalance", (q) => q.eq("legacyBalance", legacyKey.balance))
      .first();
    if (workspace && !canAccessWorkspace(workspace, balance.userId)) {
      throw new Error("This key is invalid!");
    }

    return {
      _id: legacyKey._id,
      _creationTime: legacyKey._creationTime,
      name: legacyKey.name,
      preview: legacyKey.preview,
      ...(workspace ? { workspace: workspace._id } : {}),
      legacyBalance: legacyKey.balance,
      legacyKey: legacyKey._id,
      userId: balance.userId,
    };
  },
});

// Usage metadata remains useful for BYOK cost estimates and audit history. It
// is not a balance, quota, debit, or payment record.
export type completionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  completion_tokens_details: {
    reasoning_tokens?: number | null;
  };
  prompt_tokens_details: {
    cached_tokens?: number | null;
    written_cache_tokens?: number | null;
  };
};

export const completionUsageSchema = v.object({
  prompt_tokens: v.number(),
  completion_tokens: v.number(),
  completion_tokens_details: v.object({
    reasoning_tokens: v.optional(v.union(v.number(), v.null())),
  }),
  prompt_tokens_details: v.object({
    cached_tokens: v.optional(v.union(v.number(), v.null())),
    written_cache_tokens: v.optional(v.union(v.number(), v.null())),
  }),
});

export type completionPricing = {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details: {
    cached_tokens: number;
  };
  upstream_inference_cost: number;
  cost: number;
};

export const completionPricingSchema = v.object({
  prompt_tokens: v.number(),
  completion_tokens: v.number(),
  prompt_tokens_details: v.object({
    cached_tokens: v.number(),
  }),
  cost: v.number(),
  cost_details: v.optional(v.object({ upstream_inference_cost: v.optional(v.number()) })),
});

/** Record BYOK completion usage without mutating a credit or account balance. */
export const recordCompletion = internalMutation({
  args: {
    bill: v.object({
      workspace: v.optional(v.id("workspaces")),
      apiKey: v.optional(v.id("api_keys")),
      /** Transitional attribution for completions emitted before migration. */
      balance: v.optional(v.id("balances")),
      key: v.optional(v.id("keys")),
    }),
    actor: v.optional(v.string()),
    chatId: v.optional(v.id("aisdk_chats")),
    request: v.object({
      model_slug: v.string(),
      app: v.optional(v.id("ai_apps")),
      provider: v.string(),
      byok: v.boolean(),
      api: v.literal("chat_completions"),
      stream: v.boolean(),
      canceled: v.boolean(),
      prompt_cache_key: v.optional(v.string()),
      telemetry_request_id: v.optional(v.string()),
    }),
    response: v.object({
      gen_id: v.string(),
      provider_gen_id: v.string(),
      usage: v.object({
        prompt_tokens: v.number(),
        completion_tokens: v.number(),
        total_tokens: v.number(),
        completion_tokens_details: v.object({
          reasoning_tokens: v.optional(v.number()),
        }),
        prompt_tokens_details: v.object({
          cached_tokens: v.optional(v.number()),
          written_cache_tokens: v.optional(v.number()),
        }),
      }),
      ttft: v.number(),
      gen_time: v.number(),
      finish_reason: v.string(),
    }),
  },
  async handler(ctx, args): Promise<Id<"chat_completions">> {
    if (!isByokRequest(args.request.byok)) {
      throw new Error("Only BYOK requests are supported.");
    }
    if (!args.bill.workspace && !args.bill.balance && !args.bill.apiKey) {
      throw new Error("Completion ownership is required.");
    }

    const requestedWorkspace = args.bill.workspace
      ? await ctx.db.get("workspaces", args.bill.workspace)
      : undefined;
    if (
      args.bill.workspace &&
      (!requestedWorkspace || !canAccessWorkspace(requestedWorkspace, requestedWorkspace.ownerId))
    ) {
      throw new Error("Workspace not found.");
    }

    const apiKey = args.bill.apiKey ? await ctx.db.get("api_keys", args.bill.apiKey) : undefined;
    if (args.bill.apiKey && !apiKey) throw new Error("API key not found.");

    const balance = args.bill.balance ? await ctx.db.get("balances", args.bill.balance) : undefined;
    if (args.bill.balance && !balance) throw new Error("Legacy completion owner not found.");
    const legacyKey = args.bill.key ? await ctx.db.get("keys", args.bill.key) : undefined;
    if (args.bill.key && !legacyKey) throw new Error("Legacy API key not found.");
    if (legacyKey && (!balance || legacyKey.balance !== balance._id)) {
      throw new Error("Legacy API key ownership mismatch.");
    }

    const balanceWorkspace = balance
      ? await ctx.db
          .query("workspaces")
          .withIndex("by_legacyBalance", (q) => q.eq("legacyBalance", balance._id))
          .first()
      : undefined;
    const apiKeyWorkspace = apiKey ? await ctx.db.get("workspaces", apiKey.workspace) : undefined;
    if (apiKey && !apiKeyWorkspace) throw new Error("API key workspace not found.");

    const resolvedWorkspace = requestedWorkspace ?? balanceWorkspace ?? apiKeyWorkspace;
    if (resolvedWorkspace && !canAccessWorkspace(resolvedWorkspace, resolvedWorkspace.ownerId)) {
      throw new Error("Workspace not found.");
    }
    if (resolvedWorkspace && balance && resolvedWorkspace.legacyBalance !== balance._id) {
      throw new Error("Workspace and legacy owner mismatch.");
    }
    if (resolvedWorkspace && apiKey && apiKey.workspace !== resolvedWorkspace._id) {
      throw new Error("API key workspace mismatch.");
    }
    if (apiKey?.legacyKey && legacyKey && apiKey.legacyKey !== legacyKey._id) {
      throw new Error("API key legacy mapping mismatch.");
    }
    if ((args.actor === undefined) !== (args.chatId === undefined)) {
      throw new Error("Completion chat attribution is incomplete.");
    }
    if (args.actor !== undefined && args.chatId !== undefined) {
      if (!resolvedWorkspace) throw new Error("Completion workspace not found.");
      const authorizedChat: { workspace: Doc<"workspaces"> } | null = await ctx.runQuery(
        internal.workspaces.authorizeChatForUser,
        { chatId: args.chatId, userId: args.actor },
      );
      if (!authorizedChat || authorizedChat.workspace._id !== resolvedWorkspace._id) {
        throw new Error("Completion chat workspace mismatch.");
      }
    }

    const [modelInfo, providerInfo] = await Promise.all([
      ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.request.model_slug))
        .unique(),
      resolvedWorkspace
        ? resolveCompletionProvider(ctx, resolvedWorkspace, args.request.provider)
        : ctx.db
            .query("providers")
            .withIndex("by_slug", (q) => q.eq("slug", args.request.provider))
            .unique(),
    ]);
    if (!modelInfo) throw new Error(`Unknown model: ${args.request.model_slug}`);
    if (!providerInfo) throw new Error(`Unknown provider: ${args.request.provider}`);

    const modelFromProvider = providerInfo.models.find((q) => q.model === args.request.model_slug);
    if (!modelFromProvider) {
      throw new Error(
        `Model ${args.request.model_slug} is not available on provider ${args.request.provider}.`,
      );
    }

    /** Decimal arithmetic avoids making persisted usage estimates drift on floats. */
    const completionPricing = MultiplyFunction([
      args.response.usage.completion_tokens,
      parseFloat(modelFromProvider.pricing.output),
    ]);
    const cacheReadPricing = MultiplyFunction([
      args.response.usage.prompt_tokens_details.cached_tokens || 0,
      parseFloat(modelFromProvider.pricing.cache_read || "0"),
    ]);
    const cacheWritePricing = MultiplyFunction([
      args.response.usage.prompt_tokens_details.written_cache_tokens || 0,
      parseFloat(modelFromProvider.pricing.cache_write || "0"),
    ]);
    const promptPricing = MultiplyFunction([
      args.response.usage.prompt_tokens,
      parseFloat(modelFromProvider.pricing.input),
    ]);
    const estimatedCost = AddFunction([
      completionPricing,
      cacheReadPricing,
      cacheWritePricing,
      promptPricing,
    ]);

    const bill = {
      ...(resolvedWorkspace ? { workspace: resolvedWorkspace._id } : {}),
      ...(apiKey ? { apiKey: apiKey._id } : {}),
      ...(balance ? { balance: balance._id } : {}),
      ...(legacyKey ? { key: legacyKey._id } : {}),
    };

    const completionRecord = {
      bill,
      ...(args.actor !== undefined && args.chatId !== undefined
        ? { chatId: args.chatId, userId: args.actor }
        : {}),
      request: {
        byok: true,
        streamed: args.request.stream,
        canceled: args.request.canceled,
        model: modelInfo._id,
        provider: args.request.provider,
        app: args.request.app,
      },
      response: {
        finish_reason: args.response.finish_reason,
        gen_time: args.response.gen_time,
        providerGenId: args.response.provider_gen_id,
        genId: args.response.gen_id,
        moderation_latency: undefined,
        ttft: args.response.ttft,
        usage: {
          prompt_tokens: args.response.usage.prompt_tokens,
          completion_tokens: args.response.usage.completion_tokens,
          completion_tokens_details: {
            reasoning_tokens: args.response.usage.completion_tokens_details.reasoning_tokens,
          },
          prompt_tokens_details: {
            cached_tokens: args.response.usage.prompt_tokens_details.cached_tokens,
          },
        },
        pricing: {
          completion_tokens: completionPricing,
          prompt_tokens: promptPricing,
          prompt_tokens_details: {
            cached_tokens: cacheReadPricing,
          },
          cost_details: { upstream_inference_cost: estimatedCost },
          cost: estimatedCost,
        },
      },
    };
    const completionId = await ctx.db.insert("chat_completions", completionRecord);

    if (args.request.telemetry_request_id) {
      const traces = resolvedWorkspace
        ? await ctx.db
            .query("telemetry_traces")
            .withIndex("by_workspace_and_requestId", (q) =>
              q
                .eq("workspace", resolvedWorkspace._id)
                .eq("requestId", args.request.telemetry_request_id!),
            )
            .take(100)
        : await ctx.db
            .query("telemetry_traces")
            .withIndex("by_balance_and_requestId", (q) =>
              q.eq("balance", balance!._id).eq("requestId", args.request.telemetry_request_id!),
            )
            .take(100);

      const attributedTraces = traces.filter((trace) =>
        args.chatId !== undefined ? trace.chatId === args.chatId : trace.chatId === undefined,
      );
      await Promise.all(
        attributedTraces.map((trace) =>
          ctx.db.patch("telemetry_traces", trace._id, { chatCompletionId: completionId }),
        ),
      );
    }

    return completionId;
  },
});

/** Read pricing from the workspace snapshot even if routing was disabled mid-request. */
async function resolveCompletionProvider(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  slug: string,
) {
  const configuration = await ctx.db
    .query("workspace_configurations")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace._id).eq("provider", slug),
    )
    .first();
  if (configuration?.snapshot) {
    return configuration.snapshot.slug === slug ? configuration.snapshot : null;
  }
  if (configuration?.deletedAt !== undefined) return null;
  if (!configuration && !workspace.legacyBalance) return null;

  const catalog = await ctx.db
    .query("providers")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  return catalog ? providerSnapshotFromCatalog(catalog) : null;
}

export type CompletionOwner =
  | { workspaceId: Id<"workspaces">; apiKeyId?: Id<"api_keys"> }
  | { legacyBalanceId: Id<"balances">; legacyKeyId?: Id<"keys"> };
