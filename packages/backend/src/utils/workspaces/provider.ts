import { v } from "convex/values";

export const providerNpmValidator = v.union(
  v.literal("@openrouter/ai-sdk-provider"),
  v.literal("@ai-sdk/openai"),
  v.literal("@ai-sdk/openai-compatible"),
  v.literal("@ai-sdk/anthropic"),
  v.literal("@opencoredev/loginwithchatgpt-ai"),
);

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
  pricing: v.object({
    input: v.string(),
    output: v.string(),
    cache_read: v.optional(v.string()),
    cache_write: v.optional(v.string()),
  }),
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

export type ProviderSnapshot = typeof providerSnapshotValidator.type;

export type WorkspaceProviderView = ProviderSnapshot & {
  _id: string;
  _creationTime: number;
  enabled: boolean;
  active: boolean;
};

export function providerSnapshotFromCatalog(provider: ProviderSnapshot): ProviderSnapshot {
  return {
    slug: provider.slug,
    name: provider.name,
    npm: provider.npm,
    env: provider.env,
    models: provider.models,
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
