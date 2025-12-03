import { number } from "zod";
import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { AddFunction, MultiplyFunction } from "@/utils/math";

export const hashAlgorithm = "SHA-512";
export const hashText = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        {
          name: hashAlgorithm,
        },
        new TextEncoder().encode(text)
      )
    )
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const findUsableCredit = (
  UserCredit: number,
  UsedKey: number,
  KeyLimit?: number
) =>
  parseFloat(
    Math.max(
      0,
      (KeyLimit ? Math.min(KeyLimit, UserCredit) : UserCredit) - UsedKey
    ).toFixed(7)
  );

export const getKeyInfo = query({
  args: {
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const hash = await hashText(args.key);
    const dbKey = (
      await ctx.db
        .query("keys")
        .filter((q) => q.eq(q.field("hash"), hash))
        .collect()
    )[0];
    if (!dbKey) throw new Error("This key is invalid!");
    const userKey = await ctx.db.get(dbKey.user);
    const usableCredits = findUsableCredit(
      userKey!.credits,
      dbKey.usedCredits,
      dbKey.creditLimit
    );

    return {
      _id: dbKey._id,
      _creationTime: dbKey._creationTime,
      name: dbKey.name,
      hash: dbKey.hash,
      creditLimit: dbKey.creditLimit,
      usedCredits: dbKey.usedCredits,
      user: userKey,
      usableCredits,
    };
  },
});

// Usage
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

// Usage
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
  cost_details: v.optional(
    v.object({ upstream_inference_cost: v.optional(v.number()) })
  ),
});

export const billKey = internalMutation({
  args: {
    user: v.object({
      usedKey: v.id("keys"),
      id: v.id("users"),
    }),
    request: v.object({
      model_slug: v.string(),
      app: v.optional(v.id("ai_apps")),
      provider: v.string(),
      byok: v.boolean(),
      api: v.literal("chat_completions"),
      stream: v.boolean(),
      canceled: v.boolean(),
      prompt_cache_key: v.optional(v.string()),
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
        // Search and other parameters should be here too.
      }),
      ttft: v.number(), // Time To First Token
      gen_time: v.number(),
      finish_reason: v.string(),
    }),
  },
  async handler(ctx, args) {
    const [keyInfo, userInfo, modelInfo] = await Promise.all([
      ctx.db.get(args.user.usedKey),
      ctx.db.get(args.user.id),
      ctx.db
        .query("models")
        .filter((q) => q.eq(q.field("slug"), args.request.model_slug))
        .first(),
    ]);
    const modelFromProvider = modelInfo!.providers.find(
      (q) => q.id === args.request.provider
    );

    /**
     * Pricing
     * @description There is a need for the MultiplyFunction and AddFunction because otherwise floating point numbers equation get broken. [Click to see an article, about it](https://medium.com/@devinred/weird-math-in-javascript-2379ad151d09)
     */

    const completionPricing = MultiplyFunction([
      args.response.usage.completion_tokens,
      parseFloat(modelFromProvider!.pricing.output),
    ]);
    const cacheReadPricing = MultiplyFunction([
      args.response.usage.prompt_tokens_details.cached_tokens || 0,
      parseFloat(modelFromProvider!.pricing.cache_read || "0"),
    ]);
    const cacheWritePricing = MultiplyFunction([
      args.response.usage.prompt_tokens_details.written_cache_tokens || 0,
      parseFloat(modelFromProvider!.pricing.cache_write || "0"),
    ]);
    const promptPricing = MultiplyFunction([
      args.response.usage.prompt_tokens,
      parseFloat(modelFromProvider!.pricing.input),
    ]);
    const totalCostInference = AddFunction([
      completionPricing,
      cacheReadPricing,
      cacheWritePricing,
      promptPricing,
    ]); // Float numbers are weird in JS...

    /**
     * @todo 1M per month should be free
     */
    const billedCost = args.request.byok
      ? totalCostInference * 0.05
      : totalCostInference;

    // Database actions
    await Promise.all([
      ctx.db.insert("chat_completions", {
        user: {
          id: userInfo!._id,
          key: keyInfo!._id,
        },
        request: {
          byok: args.request.byok,
          streamed: args.request.stream,
          canceled: args.request.canceled,
          model: modelInfo!._id,
          provider: args.request.provider,
          app: args.request.app,
        },
        response: {
          finish_reason: args.response.finish_reason,
          gen_time: args.response.gen_time,
          providerGenId: args.response.provider_gen_id,
          genId: args.response.gen_id,
          moderation_latency: undefined, // That is a later kind of problem
          ttft: args.response.ttft,
          usage: {
            prompt_tokens: args.response.usage.prompt_tokens,
            completion_tokens: args.response.usage.completion_tokens,
            completion_tokens_details: {
              reasoning_tokens:
                args.response.usage.completion_tokens_details.reasoning_tokens,
            },
            prompt_tokens_details: {
              cached_tokens:
                args.response.usage.prompt_tokens_details.cached_tokens,
            },
          },
          pricing: {
            completion_tokens: completionPricing,
            prompt_tokens: promptPricing,
            prompt_tokens_details: {
              cached_tokens: cacheReadPricing,
            },
            cost_details: {
              upstream_inference_cost: args.request.byok
                ? totalCostInference
                : undefined,
            },
            cost: billedCost,
          },
        },
      }),
      ctx.db.patch(keyInfo!._id, {
        usedCredits: AddFunction([keyInfo!.usedCredits, billedCost]),
      }),
    ]);
    return true;
  },
});
