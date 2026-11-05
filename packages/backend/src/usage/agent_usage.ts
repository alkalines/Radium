import { v, type Infer } from "convex/values";
import type { AcpTurnUsage } from "../acp/contract";
import { inferModelAuthor, modelKey, nameKey } from "../acp/models";
import { mapModelsDevModel, type ModelsDevApi, type ModelsDevModel } from "../models_dev";
import { providerPricingValidator, type ProviderPricing } from "../workspaces/provider";
import type { completionUsage } from "./completion";

/**
 * ACP agent usage. Agents call their own providers, so Radium never sees the requests: the Worker
 * reports each finished turn's model and tokens, and Convex prices them. Pricing prefers the
 * workspace's own provider rates (Radium models), then a models.dev match for models Radium does not
 * define. Like Gateway usage, these are operational estimates, never charges.
 */

/** Price state of one turn; `cost` is USD (`estimated ?? reported`), absent when unknown. */
export const agentTurnPricingValidator = v.object({
  status: v.union(v.literal("pending"), v.literal("priced"), v.literal("unknown")),
  /** Where the rates came from: a workspace provider or the models.dev catalogue. */
  source: v.optional(v.union(v.literal("workspace"), v.literal("models.dev"))),
  /** Provider slug (workspace) or models.dev provider id that supplied the rates. */
  provider: v.optional(v.string()),
  /** Radium canonical model slug (`author/model`), which groups the turn with Gateway traffic. */
  slug: v.optional(v.string()),
  /** Catalogue display name of the matched model. */
  modelName: v.optional(v.string()),
  estimatedCost: v.optional(v.number()),
  /** Agent-reported USD cost of the turn; used only when no estimate is possible. */
  reportedCost: v.optional(v.number()),
  cost: v.optional(v.number()),
});
export type AgentTurnPricing = Infer<typeof agentTurnPricingValidator>;

/** A models.dev model matched to an agent's model choice, with its per-token rates. */
export const modelsDevMatchValidator = v.object({
  provider: v.string(),
  modelId: v.string(),
  name: v.string(),
  slug: v.string(),
  pricing: providerPricingValidator,
});
export type ModelsDevMatch = Infer<typeof modelsDevMatchValidator>;

/** An agent model choice as reported with a turn. */
export type AgentModel = { id: string; name: string; description?: string };

/**
 * Normalize ACP turn usage to the Gateway's inclusive completion usage so one estimator prices
 * both. ACP does not say whether cache tokens are part of `inputTokens` (Anthropic-style bridges
 * report them apart, OpenAI-style ones inside) or whether `thoughtTokens` is part of
 * `outputTokens`; `totalTokens` is the sum of the agent's own accounting, so the reading whose
 * implied total is closest to it wins. Cache tokens can only be inside the input when they fit.
 */
export function normalizeAcpUsage(usage: AcpTurnUsage): completionUsage {
  const read = usage.cachedReadTokens ?? 0;
  const written = usage.cachedWriteTokens ?? 0;
  const cache = read + written;
  const thought = usage.thoughtTokens ?? 0;
  const readings = [
    { cacheInInput: false, thoughtInOutput: true },
    { cacheInInput: false, thoughtInOutput: false },
    { cacheInInput: true, thoughtInOutput: true },
    { cacheInInput: true, thoughtInOutput: false },
  ].filter((reading) => !reading.cacheInInput || cache <= usage.inputTokens);

  let best = readings[0]!;
  let bestDistance = Infinity;
  for (const reading of readings) {
    const implied =
      usage.inputTokens +
      usage.outputTokens +
      (reading.cacheInInput ? 0 : cache) +
      (reading.thoughtInOutput ? 0 : thought);
    const distance = Math.abs(implied - usage.totalTokens);
    if (distance < bestDistance) {
      best = reading;
      bestDistance = distance;
    }
  }

  return {
    prompt_tokens: usage.inputTokens + (best.cacheInInput ? 0 : cache),
    completion_tokens: usage.outputTokens + (best.thoughtInOutput ? 0 : thought),
    completion_tokens_details: { reasoning_tokens: usage.thoughtTokens },
    prompt_tokens_details: { cached_tokens: read, written_cache_tokens: written },
  };
}

/** A display name without OpenCode's `provider/` prefix (`claude-agent/Haiku 4.5`). */
export function agentModelName(model: AgentModel) {
  const slash = model.id.indexOf("/");
  const prefix = slash > 0 ? `${model.id.slice(0, slash)}/` : "";
  return prefix && model.name.startsWith(prefix) ? model.name.slice(prefix.length) : model.name;
}

/** The lab of an agent model, then of its description, then of the harness (`claude-agent`, `codex`). */
function agentModelAuthor(model: AgentModel, agentId: string) {
  return (
    inferModelAuthor(model.id, model.name) ??
    (model.description ? inferModelAuthor(model.description, model.description) : null) ??
    inferModelAuthor(agentId, agentId)
  );
}

/** `author/model` with the model part reduced by `modelKey`, so slug spellings compare equal. */
function slugKey(slug: string) {
  const slash = slug.indexOf("/");
  return slash > 0 ? `${slug.slice(0, slash).toLowerCase()}/${modelKey(slug)}` : modelKey(slug);
}

/** Slug keys an agent model may correspond to: every ID segment under the inferred lab. */
function agentSlugKeys(model: AgentModel, agentId: string, matchedSlug?: string) {
  const keys = new Set<string>();
  const author = agentModelAuthor(model, agentId);
  if (author)
    for (const segment of model.id.split("/")) keys.add(`${author.slug}/${modelKey(segment)}`);
  if (matchedSlug) keys.add(slugKey(matchedSlug));
  return keys;
}

/** Workspace provider models, as `workspaceProviderRecords` resolves them. */
export type WorkspaceProviderModels = Array<{
  slug: string;
  models: Array<{ model: string; upstream_model_id?: string; pricing: ProviderPricing }>;
}>;

/**
 * Rates from the workspace's enabled providers. The provider the agent routes through
 * (`provider/model`) is tried by upstream ID first; otherwise any provider offering the same
 * Radium model (by normalized slug) prices it, the routed provider first.
 */
export function workspaceQuote(
  providers: WorkspaceProviderModels,
  model: AgentModel,
  agentId: string,
  matchedSlug?: string,
) {
  const slash = model.id.indexOf("/");
  const routedProvider = slash > 0 ? model.id.slice(0, slash) : undefined;
  const routedModel = slash > 0 ? model.id.slice(slash + 1) : model.id;

  const routed = providers.find((provider) => provider.slug === routedProvider);
  const exact = routed?.models.find(
    (candidate) => candidate.upstream_model_id === routedModel || candidate.model === routedModel,
  );
  if (routed && exact) return { provider: routed.slug, slug: exact.model, pricing: exact.pricing };

  const keys = agentSlugKeys(model, agentId, matchedSlug);
  const ordered = routed
    ? [routed, ...providers.filter((provider) => provider !== routed)]
    : providers;
  for (const provider of ordered) {
    const found = provider.models.find((candidate) => keys.has(slugKey(candidate.model)));
    if (found) return { provider: provider.slug, slug: found.model, pricing: found.pricing };
  }
  return undefined;
}

function toMatch(providerId: string, model: ModelsDevModel): ModelsDevMatch {
  const mapped = mapModelsDevModel(providerId, model);
  return {
    provider: providerId,
    modelId: model.id,
    name: model.name,
    slug: mapped.provider.model,
    pricing: mapped.provider.pricing,
  };
}

/**
 * Match an agent's model choice to a models.dev model, conservatively: an exact
 * `provider/model` route first (OpenCode uses models.dev ids); then, within the inferred lab's
 * own provider, an ID equal under `modelKey`; then the longest catalogue name found whole in the
 * choice's name and description (`Default (recommended)` described as "currently Sonnet 4.5").
 * Names need a version digit, so a bare alias such as `opus` stays unmatched rather than guessed.
 * Labs without a models.dev provider of the same id are matched by ID across all providers only.
 */
export function matchModelsDev(
  api: ModelsDevApi,
  model: AgentModel,
  agentId: string,
): ModelsDevMatch | null {
  const slash = model.id.indexOf("/");
  if (slash > 0) {
    const providerId = model.id.slice(0, slash);
    const exact = api[providerId]?.models[model.id.slice(slash + 1)];
    if (exact) return toMatch(providerId, exact);
  }

  const author = agentModelAuthor(model, agentId);
  if (!author) return null;
  const idKeys = new Set(model.id.split("/").map(modelKey));
  const labProvider = api[author.slug];
  const searched = labProvider ? [[author.slug, labProvider] as const] : Object.entries(api);

  for (const [providerId, provider] of searched) {
    const byId = Object.values(provider.models ?? {}).find((candidate) =>
      idKeys.has(modelKey(candidate.id)),
    );
    if (byId) return toMatch(providerId, byId);
  }
  if (!labProvider) return null;

  const text = `-${nameKey([agentModelName(model), model.description ?? ""].join(" "))}-`;
  let best: ModelsDevModel | undefined;
  let bestKey = "";
  for (const candidate of Object.values(labProvider.models ?? {})) {
    // OpenRouter marks the current version `(latest)`; the name without it is the model's.
    const key = nameKey(candidate.name.replace(/\s*\(latest\)$/i, ""));
    if (!/\d/.test(key) || !text.includes(`-${key}-`)) continue;
    const newer = (candidate.release_date ?? "") > (best?.release_date ?? "");
    if (key.length > bestKey.length || (key.length === bestKey.length && newer)) {
      best = candidate;
      bestKey = key;
    }
  }
  return best ? toMatch(author.slug, best) : null;
}
