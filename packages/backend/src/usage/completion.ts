import { v } from "convex/values";

// Usage metadata supports BYOK cost estimates; it is not a credit or payment record.
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
