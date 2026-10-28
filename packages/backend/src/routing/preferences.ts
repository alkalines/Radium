import { v, type Infer } from "convex/values";
import type { ChatCompletions_RequestBody_Type } from "@/types/openai/types";
import type { SelectionCandidate } from "./selection";

/**
 * Request-level provider preferences, normalized from the OpenRouter-compatible `provider`
 * field. Slugs name the workspace's Radium providers.
 */
export const routingPreferencesValidator = v.object({
  only: v.optional(v.array(v.string())),
  ignore: v.optional(v.array(v.string())),
  order: v.optional(v.array(v.string())),
  allowFallbacks: v.boolean(),
  sort: v.optional(v.union(v.literal("price"), v.literal("throughput"), v.literal("latency"))),
});

export type RoutingPreferences = Infer<typeof routingPreferencesValidator>;
export type RoutingSort = NonNullable<RoutingPreferences["sort"]>;

// Request ordering outranks every owner priority (bounded to ±1,000,000).
const ORDER_PRIORITY_BASE = 3_000_000;
const SORT_PRIORITY_BASE = 2_000_000;

/** Normalize the request `provider` field; a plain slug is a hard pin without fallbacks. */
export function routingPreferencesFromRequest(
  provider: ChatCompletions_RequestBody_Type["provider"],
): RoutingPreferences {
  if (provider === undefined) return { allowFallbacks: true };
  if (typeof provider === "string") return { only: [provider], allowFallbacks: false };

  const sort = typeof provider.sort === "object" ? provider.sort.by : provider.sort;
  return {
    ...(provider.only ? { only: provider.only } : {}),
    ...(provider.ignore ? { ignore: provider.ignore } : {}),
    ...(provider.order ? { order: provider.order } : {}),
    allowFallbacks: provider.allow_fallbacks ?? true,
    ...(sort ? { sort } : {}),
  };
}

/** Observed or catalogued values used by `sort`; missing values rank after known ones. */
export type ProviderMetrics = Map<
  string,
  { price?: number; throughput?: number; latency?: number }
>;

/**
 * Apply filters and ordering by rewriting candidate priorities, so the configured strategy
 * still balances among equally ranked providers. `sort` ranks every candidate; `order`
 * then places listed providers above everything else in list order. With
 * `allow_fallbacks: false`, only providers listed in `order` remain.
 */
export function applyRoutingPreferences<T extends SelectionCandidate>(
  candidates: T[],
  preferences: RoutingPreferences,
  metrics: ProviderMetrics,
): T[] {
  let result = candidates.filter(
    (candidate) =>
      (!preferences.only || preferences.only.includes(candidate.provider)) &&
      !preferences.ignore?.includes(candidate.provider),
  );

  if (preferences.sort) {
    const sort = preferences.sort;
    const values = [
      ...new Set(
        result
          .map((candidate) => metrics.get(candidate.provider)?.[sort])
          .filter((value): value is number => value !== undefined),
      ),
    ].sort((left, right) => (sort === "throughput" ? right - left : left - right));

    result = result.map((candidate) => {
      const value = metrics.get(candidate.provider)?.[sort];
      const rank = value === undefined ? values.length : values.indexOf(value);
      return { ...candidate, priority: SORT_PRIORITY_BASE - rank };
    });
  }

  const order = preferences.order;
  if (order) {
    result = result.flatMap((candidate) => {
      const index = order.indexOf(candidate.provider);
      if (index >= 0) return [{ ...candidate, priority: ORDER_PRIORITY_BASE - index }];
      return preferences.allowFallbacks ? [candidate] : [];
    });
  }

  return result;
}
