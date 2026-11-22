import { z } from "zod";

/** Supported provider adapter packages persisted in workspace snapshots. */
export const providerNpmValidator = z.union([
  z.literal("@openrouter/ai-sdk-provider"),
  z.literal("@ai-sdk/openai"),
  z.literal("@ai-sdk/openai-compatible"),
  z.literal("@ai-sdk/anthropic"),
  z.literal("@opencoredev/loginwithchatgpt-ai"),
]);

const tokenRateFields = {
  input: z.string(),
  output: z.string(),
  cache_read: z.optional(z.string()),
  cache_write: z.optional(z.string()),
  cache_write_1h: z.optional(z.string()),
};

/** USD per-token rates with optional whole-request context thresholds. */
export const providerPricingValidator = z.object({
  ...tokenRateFields,
  tiers: z.optional(z.array(z.object({ context: z.number(), ...tokenRateFields }))),
});
export type ProviderPricing = z.infer<typeof providerPricingValidator>;

/** Supported, explicit model-mode overrides; never arbitrary upstream request bodies. */
export const inferenceModesValidator = z.array(
  z.object({
    id: z.string(),
    source: z.optional(z.string()),
    pricing: z.optional(providerPricingValidator),
    provider_body: z.object({
      service_tier: z.optional(z.string()),
      speed: z.optional(z.union([z.literal("fast"), z.literal("standard")])),
      reasoning: z.optional(z.object({ mode: z.union([z.literal("standard"), z.literal("pro")]) })),
    }),
    // HTTP header names contain hyphens, which Convex object-field validators reject.
    provider_headers: z.optional(z.record(z.string(), z.string())),
  }),
);

/** Explicitly advertised tier capability and optional per-token USD quote. */
export const serviceTiersValidator = z.array(
  z.object({
    id: z.string(),
    source: z.optional(z.string()),
    pricing: z.optional(providerPricingValidator),
  }),
);
/** Model metadata accepted in a provider catalogue or workspace snapshot. */
export const providerModelValidator = z.object({
  model: z.string(),
  upstream_model_id: z.optional(z.string()),
  quantization: z.optional(
    z.union([
      z.literal("int4"),
      z.literal("int8"),
      z.literal("fp4"),
      z.literal("fp6"),
      z.literal("fp8"),
      z.literal("fp16"),
      z.literal("bf16"),
      z.literal("fp32"),
    ]),
  ),
  context: z.number(),
  max_output: z.number(),
  pricing: providerPricingValidator,
  service_tiers: z.optional(serviceTiersValidator),
  inference_modes: z.optional(inferenceModesValidator),
  supported_parameters: z.array(
    z.union([
      z.literal("temperature"),
      z.literal("top_p"),
      z.literal("top_k"),
      z.literal("frequency_penalty"),
      z.literal("presence_penalty"),
      z.literal("repetition_penalty"),
      z.literal("min_p"),
      z.literal("top_a"),
      z.literal("seed"),
      z.literal("max_tokens"),
      z.literal("logit_bias"),
      z.literal("logprobs"),
      z.literal("top_logprobs"),
      z.literal("response_format"),
      z.literal("structured_outputs"),
      z.literal("stop"),
      z.literal("tools"),
      z.literal("tool_choice"),
      z.literal("parallel_tool_calls"),
      z.literal("verbosity"),
    ]),
  ),
  promotions: z.optional(
    z.object({
      input: z.optional(z.string()),
      output: z.optional(z.string()),
      cache_read: z.optional(z.string()),
      cache_write: z.optional(z.string()),
    }),
  ),
  moderated: z.boolean(),
});

/** Immutable provider metadata captured for one workspace's local routing. */
export const providerSnapshotValidator = z.object({
  slug: z.string(),
  name: z.string(),
  npm: providerNpmValidator,
  env: z.array(z.string()),
  catalogue_provider: z.optional(z.string()),
  credential_type: z.optional(z.union([z.literal("api_key"), z.literal("oauth")])),
  oauth_flow: z.optional(z.string()),
  doc: z.optional(z.string()),
  api: z.optional(z.string()),
  models: z.array(providerModelValidator),
});

/** Type of the validated, workspace-local provider snapshot. */
export type ProviderSnapshot = z.infer<typeof providerSnapshotValidator>;

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
