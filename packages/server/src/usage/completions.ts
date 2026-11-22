import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { ProviderPricing } from "contracts/workspaces/provider";
import type { Database } from "../drivers/types";
import { models } from "../gateway/schema";
import { estimateCompletionCost, type completionUsage } from "./pricing";
import { chatCompletions } from "./schema";

/** One settled Gateway completion as the request path reports it (BYOK; quotes captured at dispatch). */
export type CompletionRecord = {
  workspace: string;
  /** The Gateway key of a direct call. */
  apiKey: string | null;
  /**
   * Chatroom completions only: the chat and the user it ran for (the caller authorized both).
   * Such a row is never Gateway traffic.
   */
  chat?: string;
  userId?: string;
  /** Direct Gateway calls only: the client's own session id. */
  clientSession?: string;
  modelSlug: string;
  provider: string;
  /** Credential that served it; the caller verified it belongs to the workspace provider. */
  credential: string | null;
  streamed: boolean;
  canceled: boolean;
  requestedServiceTier?: string;
  inferenceMode?: string;
  quoteSource?: string;
  /** Rates the request was quoted at when dispatched. */
  quote?: ProviderPricing;
  genId: string;
  providerGenId: string;
  finishReason: string;
  genTime: number;
  ttft: number;
  usage: completionUsage;
  servedServiceTier?: string;
  /** Rates of the tier that actually served it; absent when unknown (usage unavailable). */
  servedQuote?: ProviderPricing;
  reportedCost?: number;
  upstreamInferenceCost?: number;
  cacheWriteTtlUnknown?: boolean;
};

/**
 * Records one completion with its operational cost estimate (never a charge): the served
 * tier's rates priced against the token buckets, and `cost = reported ?? estimated`, `null`
 * when unknown. Runs in the caller's transaction.
 *
 * @returns the completion id.
 */
export async function recordChatCompletion(tx: Database, record: CompletionRecord) {
  const [model] = await tx
    .select({ id: models.id })
    .from(models)
    .where(eq(models.slug, record.modelSlug));
  if (!model) throw new Error("The completion's model is not in the catalogue.");

  const estimate = estimateCompletionCost(
    record.usage,
    record.servedQuote,
    record.cacheWriteTtlUnknown,
  );
  const cost = record.reportedCost ?? estimate.estimatedCost;
  const [row] = await tx
    .insert(chatCompletions)
    .values({
      workspace: record.workspace,
      apiKey: record.apiKey,
      chat: record.chat ?? null,
      userId: record.userId ?? null,
      clientSession: record.clientSession ?? null,
      provider: record.provider,
      credential: record.credential,
      byok: true,
      model: model.id,
      streamed: record.streamed,
      canceled: record.canceled,
      requestedServiceTier: record.requestedServiceTier ?? null,
      inferenceMode: record.inferenceMode ?? null,
      quoteSource: record.quoteSource ?? null,
      quote: record.quote ?? null,
      genId: record.genId,
      providerGenId: record.providerGenId,
      promptTokens: record.usage.prompt_tokens,
      completionTokens: record.usage.completion_tokens,
      usageDetails: {
        completion_tokens_details: {
          reasoning_tokens: record.usage.completion_tokens_details.reasoning_tokens ?? undefined,
        },
        prompt_tokens_details: {
          cached_tokens: record.usage.prompt_tokens_details.cached_tokens ?? undefined,
          written_cache_tokens: record.usage.prompt_tokens_details.written_cache_tokens ?? undefined,
          written_cache_tokens_1h:
            record.usage.prompt_tokens_details.written_cache_tokens_1h ?? undefined,
        },
      },
      cost: cost ?? null,
      estimatedCost: estimate.estimatedCost ?? null,
      reportedCost: record.reportedCost ?? null,
      pricingDetails: {
        prompt_tokens: estimate.prompt,
        completion_tokens: estimate.output,
        prompt_tokens_details: {
          cached_tokens: estimate.cacheRead,
          written_cache_tokens: estimate.cacheWrite,
          written_cache_tokens_1h: estimate.cacheWrite1h,
        },
        cost_details: { upstream_inference_cost: record.upstreamInferenceCost },
      },
      ttft: record.ttft,
      genTime: record.genTime,
      finishReason: record.finishReason,
      servedServiceTier: record.servedServiceTier ?? null,
      servedQuote: record.servedQuote ?? null,
    })
    .returning({ id: chatCompletions.id });
  return row!.id;
}

/** Completions of a workspace that routing's `throughput`/`latency` sort samples. */
const ROUTING_SAMPLE_SIZE = 200;

/**
 * Timing samples of `modelSlug` among the workspace's latest 200 completions (any model), as
 * routing's provider sort used them in Convex: provider, tier, inference mode, tokens and
 * timings. Bounded by the inner limit whatever the model mix.
 */
export async function recentModelSamples(db: Database, workspace: string, modelSlug: string) {
  const recent = db
    .select({
      model: chatCompletions.model,
      provider: chatCompletions.provider,
      canceled: chatCompletions.canceled,
      requestedServiceTier: chatCompletions.requestedServiceTier,
      inferenceMode: chatCompletions.inferenceMode,
      completionTokens: chatCompletions.completionTokens,
      ttft: chatCompletions.ttft,
      genTime: chatCompletions.genTime,
    })
    .from(chatCompletions)
    .where(eq(chatCompletions.workspace, workspace))
    .orderBy(desc(chatCompletions.createdAt), desc(chatCompletions.id))
    .limit(ROUTING_SAMPLE_SIZE)
    .as("recent");
  return await db
    .select({
      provider: recent.provider,
      canceled: recent.canceled,
      requestedServiceTier: recent.requestedServiceTier,
      inferenceMode: recent.inferenceMode,
      completionTokens: recent.completionTokens,
      ttft: recent.ttft,
      genTime: recent.genTime,
    })
    .from(recent)
    .innerJoin(models, eq(models.id, recent.model))
    .where(eq(models.slug, modelSlug));
}

/**
 * Radium's recorded cost of one provider credential's completions since `since` (USD), for its
 * metered budget. `null` when any completion in the range has an unknown cost: a partial sum
 * must not pass for the budget's use.
 */
export async function credentialSpendSince(
  db: Database,
  credential: string,
  since: Date,
): Promise<number | null> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${chatCompletions.cost}), 0)::float8`,
      unknown: sql<number>`count(*) filter (where ${chatCompletions.cost} is null)::int`,
    })
    .from(chatCompletions)
    .where(and(eq(chatCompletions.credential, credential), gte(chatCompletions.createdAt, since)));
  return row!.unknown > 0 ? null : Number(row!.total);
}
