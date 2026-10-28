import { v } from "convex/values";
import type { ProviderPricing } from "../workspaces/provider";

/** BYOK usage metadata for operational estimates, not a credit or payment record. */
export type completionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  completion_tokens_details: {
    reasoning_tokens?: number | null;
  };
  prompt_tokens_details: {
    cached_tokens?: number | null;
    written_cache_tokens?: number | null;
    written_cache_tokens_1h?: number | null;
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
    written_cache_tokens_1h: v.optional(v.union(v.number(), v.null())),
  }),
});

/** Resolve a reported fallback tier against the provider's dispatch-time snapshot. */
export function servedTierQuote(
  requestedTier: string | undefined,
  servedTier: string | undefined,
  quote: ProviderPricing | undefined,
  tiers: Array<{ id: string; pricing?: ProviderPricing }> | undefined,
  defaultQuote?: ProviderPricing,
) {
  const requested = requestedTier === "fast" ? "priority" : requestedTier;
  const served = servedTier === "fast" ? "priority" : servedTier;
  if (!served || served === (requested && requested !== "auto" ? requested : "default"))
    return quote;
  const entry = tiers?.find(
    (candidate) => (candidate.id === "fast" ? "priority" : candidate.id) === served,
  );
  return entry?.pricing ?? (served === "default" ? defaultQuote : undefined);
}

/** Quote disjoint input buckets; an absent rate for consumed tokens makes the estimate unknown. */
export function estimateCompletionCost(
  usage: completionUsage,
  quote: ProviderPricing | undefined,
  cacheWriteTtlUnknown = false,
) {
  // Context thresholds apply to the whole request, using inclusive input usage before
  // subtracting cache buckets. An exact boundary still uses the lower schedule.
  const matchingTier = quote?.tiers
    ?.filter((tier) => usage.prompt_tokens > tier.context)
    .reduce<NonNullable<ProviderPricing["tiers"]>[number] | undefined>(
      (current, tier) => (!current || tier.context > current.context ? tier : current),
      undefined,
    );
  const rates = matchingTier ?? quote;
  const read = usage.prompt_tokens_details.cached_tokens ?? 0;
  const written = usage.prompt_tokens_details.written_cache_tokens ?? 0;
  const written1h = usage.prompt_tokens_details.written_cache_tokens_1h ?? 0;
  const bucket = (tokens: number, rate: string | undefined): number | undefined => {
    if (tokens < 0 || !Number.isFinite(tokens)) return undefined;
    if (tokens === 0) return 0;
    if (rate === undefined || rate.trim() === "") return undefined;
    const value = Number(rate);
    return Number.isFinite(value) && value >= 0 ? tokens * value : undefined;
  };
  const prompt = bucket(usage.prompt_tokens - read - written, rates?.input);
  const output = bucket(usage.completion_tokens, rates?.output);
  const cacheRead = bucket(read, rates?.cache_read);
  const cacheWrite5m =
    cacheWriteTtlUnknown && written > 0
      ? undefined
      : bucket(written - written1h, rates?.cache_write);
  const cacheWrite1h = bucket(written1h, rates?.cache_write_1h);
  const cacheWrite =
    cacheWrite5m === undefined || cacheWrite1h === undefined
      ? undefined
      : cacheWrite5m + cacheWrite1h;
  const buckets = [prompt, output, cacheRead, cacheWrite];
  return {
    prompt,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    estimatedCost:
      quote && buckets.every((value) => value !== undefined)
        ? (buckets as number[]).reduce((sum, value) => sum + value, 0)
        : undefined,
  };
}

export const completionPricingSchema = v.object({
  prompt_tokens: v.optional(v.number()),
  completion_tokens: v.optional(v.number()),
  prompt_tokens_details: v.object({
    cached_tokens: v.optional(v.number()),
    written_cache_tokens: v.optional(v.number()),
    written_cache_tokens_1h: v.optional(v.number()),
  }),
  cost: v.optional(v.number()),
  estimatedCost: v.optional(v.number()),
  reportedCost: v.optional(v.number()),
  cost_details: v.optional(v.object({ upstream_inference_cost: v.optional(v.number()) })),
});

/** Operational BYOK pricing estimates persisted with a completion, not charges or credits. */
export type completionPricing = typeof completionPricingSchema.type;
