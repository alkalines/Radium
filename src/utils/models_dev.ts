/**
 * models.dev integration helpers.
 *
 * The gateway imports providers and models from the public models.dev schema
 * (`https://models.dev/api.json`). This module owns the contract between that
 * external shape and our Convex `importProvider` mutation: which providers are
 * usable, and how a raw models.dev model becomes both a global `models` record
 * and a provider-specific model entry.
 */

import type { AIProviderNpmPackage } from "./types/ai_provider";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * The npm provider packages the gateway can actually connect to (see
 * `src/utils/providers.ts`). models.dev lists ~145 providers across many SDK
 * packages; only these four are wired up, so the rest are surfaced as
 * unsupported in the UI.
 */
export const SUPPORTED_NPM: readonly AIProviderNpmPackage[] = [
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/anthropic",
  "@opencoredev/loginwithchatgpt-ai",
];

export function isSupportedNpm(npm: string | undefined): npm is AIProviderNpmPackage {
  return !!npm && (SUPPORTED_NPM as readonly string[]).includes(npm);
}

/* ----------------------------- models.dev types ---------------------------- */

export type ModelsDevCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
};

export type ModelsDevModel = {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: { type: string; values?: string[] }[];
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities?: { input?: string[]; output?: string[] };
  open_weights?: boolean;
  limit?: { context?: number; output?: number };
  cost?: ModelsDevCost;
};

export type ModelsDevProvider = {
  id: string;
  name: string;
  npm?: string;
  env?: string[];
  api?: string;
  doc?: string;
  models: Record<string, ModelsDevModel>;
};

export type ModelsDevApi = Record<string, ModelsDevProvider>;

/* --------------------------- import payload types -------------------------- */

export type SupportedParameter =
  | "temperature"
  | "top_p"
  | "top_k"
  | "frequency_penalty"
  | "presence_penalty"
  | "repetition_penalty"
  | "min_p"
  | "top_a"
  | "seed"
  | "max_tokens"
  | "logit_bias"
  | "logprobs"
  | "top_logprobs"
  | "response_format"
  | "structured_outputs"
  | "stop"
  | "tools"
  | "tool_choice"
  | "parallel_tool_calls"
  | "verbosity";

export type GlobalModelInput = {
  name: string;
  slug: string;
  launch_date: number;
  type: "chat" | "embedding" | "image-generation";
  description: string;
  warning?: string;
  model_weights?: string;
  reasoning: boolean;
  features: {
    reasoning_minimal?: boolean;
    reasoning_none?: boolean;
    reasoning_budget?: boolean;
    reasoning_efforts?: string[];
  };
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
  };
  default_parameters?: {
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
  };
  author: { name: string; slug: string };
};

export type ProviderModelInput = {
  model: string;
  upstream_model_id?: string;
  context: number;
  max_output: number;
  pricing: {
    input: string;
    output: string;
    cache_read?: string;
    cache_write?: string;
  };
  supported_parameters: SupportedParameter[];
  moderated: boolean;
};

export type MappedModel = {
  /** Raw models.dev id, kept so the UI can group/dedupe by upstream id. */
  upstreamId: string;
  global: GlobalModelInput;
  provider: ProviderModelInput;
};

/* ------------------------------- derivation -------------------------------- */

const AUTHOR_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "google-vertex": "Google",
  meta: "Meta",
  "meta-llama": "Meta",
  xai: "xAI",
  mistral: "Mistral",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  alibaba: "Alibaba",
  cohere: "Cohere",
  amazon: "Amazon",
  perplexity: "Perplexity",
  moonshotai: "Moonshot AI",
  zai: "Z.AI",
  nvidia: "NVIDIA",
  microsoft: "Microsoft",
};

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Infer the model author. models.dev ids are either bare (`o3` under the
 * `openai` provider) or prefixed (`xai/grok-4` under an aggregator) — the
 * prefix, when present, is a stronger author signal than the provider id.
 */
export function deriveAuthor(modelId: string, providerId: string): { name: string; slug: string } {
  const slug = modelId.includes("/") ? modelId.split("/")[0] : providerId;
  return { slug, name: AUTHOR_NAMES[slug] ?? titleCase(slug) };
}

/**
 * Canonical, provider-independent slug for the global `models` table, so the
 * same model offered by several providers dedupes to one row. Form:
 * `<author>/<base model id>` (e.g. `openai/gpt-4o`, `xai/grok-4`).
 */
export function canonicalSlug(modelId: string, authorSlug: string): string {
  const base = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  return `${authorSlug}/${base}`;
}

function deriveTokenizer(authorSlug: string, family?: string): string {
  const k = `${authorSlug} ${family ?? ""}`.toLowerCase();
  if (k.includes("claude") || k.includes("anthropic")) return "Claude";
  if (k.includes("gemini") || k.includes("google") || k.includes("palm")) return "Gemini";
  if (k.includes("grok") || k.includes("xai")) return "Grok";
  if (k.includes("deepseek")) return "DeepSeek";
  if (k.includes("qwen")) return "Qwen3";
  if (k.includes("llama") || k.includes("meta")) return "Llama3";
  if (k.includes("mistral")) return "Mistral";
  if (k.includes("cohere")) return "Cohere";
  if (k.includes("nova") || k.includes("amazon")) return "Nova";
  if (k.includes("yi")) return "Yi";
  return "GPT";
}

const INPUT_MODALITY_MAP: Record<string, string> = { pdf: "file" };

function mapModalities(list: string[] | undefined, fallback: string[]): string[] {
  const source = list && list.length > 0 ? list : fallback;
  return source.map((modality) => INPUT_MODALITY_MAP[modality] ?? modality);
}

function deriveSupportedParameters(model: ModelsDevModel): SupportedParameter[] {
  const params = new Set<SupportedParameter>(["max_tokens", "stop", "seed"]);
  if (model.temperature !== false) {
    params.add("temperature");
    params.add("top_p");
    params.add("frequency_penalty");
    params.add("presence_penalty");
  }
  if (model.tool_call) {
    params.add("tools");
    params.add("tool_choice");
    params.add("parallel_tool_calls");
  }
  if (model.structured_output) {
    params.add("response_format");
    params.add("structured_outputs");
  }
  return [...params];
}

function deriveFeatures(model: ModelsDevModel): GlobalModelInput["features"] {
  const values = model.reasoning_options?.find((option) => option.type === "effort")?.values ?? [];
  return {
    reasoning_efforts: values.length > 0 ? values : undefined,
    reasoning_minimal: values.includes("minimal") ? true : undefined,
    reasoning_none: values.includes("none") ? true : undefined,
    reasoning_budget: model.reasoning_options?.some((option) =>
      ["budget", "max_tokens", "tokens"].includes(option.type),
    )
      ? true
      : undefined,
  };
}

/**
 * Convert a models.dev per-million-token cost into our stored per-token string.
 * Billing multiplies token counts by `parseFloat(pricing.input)` directly (see
 * `convex/key.ts`), so the unit must be per token. Avoids exponent notation.
 */
function perToken(costPerMillion: number | undefined): string | undefined {
  if (costPerMillion === undefined) return undefined;
  const value = costPerMillion / 1_000_000;
  if (value === 0) return "0";
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Map a raw models.dev model into the `{ global, provider }` payload expected
 * by `importProvider`. The result is editable in the UI before submission —
 * notably the author and canonical slug for unknown/aggregated authors.
 */
export function mapModelsDevModel(providerId: string, model: ModelsDevModel): MappedModel {
  const author = deriveAuthor(model.id, providerId);
  const slug = canonicalSlug(model.id, author.slug);
  const releaseDate = model.release_date ?? model.last_updated;
  const launchTimestamp = releaseDate ? Date.parse(releaseDate) : NaN;

  return {
    upstreamId: model.id,
    global: {
      name: model.name,
      slug,
      launch_date: Number.isNaN(launchTimestamp) ? Date.now() : launchTimestamp,
      type: "chat",
      description: "",
      reasoning: Boolean(model.reasoning),
      features: deriveFeatures(model),
      architecture: {
        input_modalities: mapModalities(model.modalities?.input, ["text"]),
        output_modalities: mapModalities(model.modalities?.output, ["text"]),
        tokenizer: deriveTokenizer(author.slug, model.family),
      },
      author,
    },
    provider: {
      model: slug,
      upstream_model_id: model.id,
      context: model.limit?.context ?? 0,
      max_output: model.limit?.output ?? 0,
      pricing: {
        input: perToken(model.cost?.input) ?? "0",
        output: perToken(model.cost?.output) ?? "0",
        cache_read: perToken(model.cost?.cache_read),
        cache_write: perToken(model.cost?.cache_write),
      },
      supported_parameters: deriveSupportedParameters(model),
      moderated: false,
    },
  };
}

/** Fetch and parse the full models.dev catalogue. */
export async function fetchModelsDev(signal?: AbortSignal): Promise<ModelsDevApi> {
  const response = await fetch(MODELS_DEV_API_URL, { signal });
  if (!response.ok) {
    throw new Error(`models.dev request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as ModelsDevApi;
}
