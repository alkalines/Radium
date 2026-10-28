import { v } from "convex/values";

/** Supported provider adapter packages persisted in workspace snapshots. */
export const providerNpmValidator = v.union(
  v.literal("@openrouter/ai-sdk-provider"),
  v.literal("@ai-sdk/openai"),
  v.literal("@ai-sdk/openai-compatible"),
  v.literal("@ai-sdk/anthropic"),
  v.literal("@opencoredev/loginwithchatgpt-ai"),
);

const tokenRateFields = {
  input: v.string(),
  output: v.string(),
  cache_read: v.optional(v.string()),
  cache_write: v.optional(v.string()),
  cache_write_1h: v.optional(v.string()),
};

/** USD per-token rates with optional whole-request context thresholds. */
export const providerPricingValidator = v.object({
  ...tokenRateFields,
  tiers: v.optional(v.array(v.object({ context: v.number(), ...tokenRateFields }))),
});
export type ProviderPricing = typeof providerPricingValidator.type;

/** Supported, explicit model-mode overrides; never arbitrary upstream request bodies. */
export const inferenceModesValidator = v.array(
  v.object({
    id: v.string(),
    source: v.optional(v.string()),
    pricing: v.optional(providerPricingValidator),
    provider_body: v.object({
      service_tier: v.optional(v.string()),
      speed: v.optional(v.union(v.literal("fast"), v.literal("standard"))),
      reasoning: v.optional(v.object({ mode: v.union(v.literal("standard"), v.literal("pro")) })),
    }),
    // HTTP header names contain hyphens, which Convex object-field validators reject.
    provider_headers: v.optional(v.record(v.string(), v.string())),
  }),
);

/** Explicitly advertised tier capability and optional per-token USD quote. */
export const serviceTiersValidator = v.array(
  v.object({
    id: v.string(),
    source: v.optional(v.string()),
    pricing: v.optional(providerPricingValidator),
  }),
);
/** Model metadata accepted in a provider catalogue or workspace snapshot. */
export const providerModelValidator = v.object({
  model: v.string(),
  upstream_model_id: v.optional(v.string()),
  quantization: v.optional(
    v.union(
      v.literal("int4"),
      v.literal("int8"),
      v.literal("fp4"),
      v.literal("fp6"),
      v.literal("fp8"),
      v.literal("fp16"),
      v.literal("bf16"),
      v.literal("fp32"),
    ),
  ),
  context: v.number(),
  max_output: v.number(),
  pricing: providerPricingValidator,
  service_tiers: v.optional(serviceTiersValidator),
  inference_modes: v.optional(inferenceModesValidator),
  supported_parameters: v.array(
    v.union(
      v.literal("temperature"),
      v.literal("top_p"),
      v.literal("top_k"),
      v.literal("frequency_penalty"),
      v.literal("presence_penalty"),
      v.literal("repetition_penalty"),
      v.literal("min_p"),
      v.literal("top_a"),
      v.literal("seed"),
      v.literal("max_tokens"),
      v.literal("logit_bias"),
      v.literal("logprobs"),
      v.literal("top_logprobs"),
      v.literal("response_format"),
      v.literal("structured_outputs"),
      v.literal("stop"),
      v.literal("tools"),
      v.literal("tool_choice"),
      v.literal("parallel_tool_calls"),
      v.literal("verbosity"),
    ),
  ),
  promotions: v.optional(
    v.object({
      input: v.optional(v.string()),
      output: v.optional(v.string()),
      cache_read: v.optional(v.string()),
      cache_write: v.optional(v.string()),
    }),
  ),
  moderated: v.boolean(),
});

/** Immutable provider metadata captured for one workspace's local routing. */
export const providerSnapshotValidator = v.object({
  slug: v.string(),
  name: v.string(),
  npm: providerNpmValidator,
  env: v.array(v.string()),
  catalogue_provider: v.optional(v.string()),
  credential_type: v.optional(v.union(v.literal("api_key"), v.literal("oauth"))),
  oauth_flow: v.optional(v.string()),
  doc: v.optional(v.string()),
  api: v.optional(v.string()),
  models: v.array(providerModelValidator),
});

/** Type of the validated, workspace-local provider snapshot. */
export type ProviderSnapshot = typeof providerSnapshotValidator.type;

/** Provider snapshot with the identity and enabled state used by workspace views. */
export type WorkspaceProviderView = ProviderSnapshot & {
  _id: string;
  _creationTime: number;
  enabled: boolean;
  active: boolean;
};

/**
 * Copy provider metadata into the persisted snapshot shape, omitting absent
 * optional fields so the result is safe to store as a Convex value.
 */
export function providerSnapshotFromCatalog(provider: ProviderSnapshot): ProviderSnapshot {
  return {
    slug: provider.slug,
    name: provider.name,
    npm: provider.npm,
    env: provider.env,
    models: provider.models.map((model) => ({
      ...model,
      service_tiers: serviceTiersForModel(model),
    })),
    ...(provider.catalogue_provider === undefined
      ? {}
      : { catalogue_provider: provider.catalogue_provider }),
    ...(provider.credential_type === undefined
      ? {}
      : { credential_type: provider.credential_type }),
    ...(provider.oauth_flow === undefined ? {} : { oauth_flow: provider.oauth_flow }),
    ...(provider.doc === undefined ? {} : { doc: provider.doc }),
    ...(provider.api === undefined ? {} : { api: provider.api }),
  };
}

/**
 * Every configured model has a standard tier, including snapshots saved before tiers existed.
 * Missing default-tier rates inherit the model's base quote; explicit zero rates remain zero.
 */
export function serviceTiersForModel(model: {
  pricing: ProviderPricing;
  service_tiers?: Array<{ id: string; source?: string; pricing?: ProviderPricing }>;
}) {
  const configured = model.service_tiers ?? [];
  const standard = configured.find((tier) => tier.id === "default");
  return [
    {
      ...standard,
      id: "default",
      source: standard?.source ?? "base",
      pricing: standard?.pricing ?? model.pricing,
    },
    ...configured.filter((tier) => tier.id !== "default"),
  ];
}
