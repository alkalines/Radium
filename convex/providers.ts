import { v } from "convex/values";
import { credentialPreview, encryptCredentialRecord } from "@/utils/credential_crypto";
import { internalQuery, mutation, query } from "./_generated/server";
import { authComponent } from "./auth";

const providerNpmValidator = v.union(
  v.literal("@openrouter/ai-sdk-provider"),
  v.literal("@ai-sdk/openai"),
  v.literal("@ai-sdk/openai-compatible"),
  v.literal("@ai-sdk/anthropic"),
);

const providerModelValidator = v.object({
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

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("providers").take(200);
  },
});

export const upsertFromModelsDev = mutation({
  args: {
    slug: v.string(),
    provider: v.object({
      name: v.string(),
      npm: providerNpmValidator,
      env: v.array(v.string()),
      doc: v.optional(v.string()),
      api: v.optional(v.string()),
      models: v.optional(v.array(providerModelValidator)),
    }),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.provider.npm === "@ai-sdk/openai-compatible" && !args.provider.api) {
      throw new Error("OpenAI-compatible providers require the models.dev api field.");
    }

    const existing = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    const value = {
      slug: args.slug,
      name: args.provider.name,
      npm: args.provider.npm,
      env: args.provider.env,
      doc: args.provider.doc,
      api: args.provider.api,
      enabled: args.enabled ?? true,
      models: args.provider.models ?? [],
    };

    if (existing) {
      await ctx.db.replace("providers", existing._id, value);
      return existing._id;
    }

    return await ctx.db.insert("providers", value);
  },
});

export const upsertManual = mutation({
  args: {
    slug: v.string(),
    name: v.string(),
    npm: providerNpmValidator,
    env: v.array(v.string()),
    doc: v.optional(v.string()),
    api: v.optional(v.string()),
    enabled: v.boolean(),
    models: v.array(providerModelValidator),
  },
  handler: async (ctx, args) => {
    if (args.npm === "@ai-sdk/openai-compatible" && !args.api) {
      throw new Error("OpenAI-compatible providers require an api base URL.");
    }

    const existing = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    const value = {
      slug: args.slug,
      name: args.name,
      npm: args.npm,
      env: args.env,
      doc: args.doc,
      api: args.api,
      enabled: args.enabled,
      models: args.models,
    };

    if (existing) {
      await ctx.db.replace("providers", existing._id, value);
      return existing._id;
    }

    return await ctx.db.insert("providers", value);
  },
});

export const listCredentials = query({
  args: {
    balance: v.id("balances"),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const balance = await ctx.db.get("balances", args.balance);
    if (!balance || balance.userId !== identity._id) throw new Error("Balance not found.");

    const credentials = await ctx.db
      .query("provider_credentials")
      .withIndex("by_balance_and_provider", (q) => q.eq("balance", args.balance))
      .take(200);

    return credentials.map((credential) => ({
      _id: credential._id,
      provider: credential.provider,
      preview: credential.preview,
    }));
  },
});

export const upsertCredentials = mutation({
  args: {
    balance: v.id("balances"),
    provider: v.string(),
    credentials: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const [balance, provider] = await Promise.all([
      ctx.db.get("balances", args.balance),
      ctx.db.query("providers").withIndex("by_slug", (q) => q.eq("slug", args.provider)).unique(),
    ]);

    if (!balance || balance.userId !== identity._id) throw new Error("Balance not found.");
    if (!provider) throw new Error(`Provider ${args.provider} is not configured.`);

    for (const requiredName of provider.env) {
      if (!args.credentials[requiredName]) {
        throw new Error(`Missing required credential value: ${requiredName}`);
      }
    }

    const encrypted = await encryptCredentialRecord(
      process.env.PROVIDER_CREDENTIALS_SECRET ?? "",
      args.credentials,
    );
    const preview = Object.fromEntries(
      Object.entries(args.credentials).map(([name, value]) => [name, credentialPreview(value)]),
    );

    const existing = await ctx.db
      .query("provider_credentials")
      .withIndex("by_balance_and_provider", (q) =>
        q.eq("balance", args.balance).eq("provider", args.provider),
      )
      .unique();
    const value = {
      balance: args.balance,
      provider: args.provider,
      encrypted,
      preview,
    };

    if (existing) {
      await ctx.db.replace("provider_credentials", existing._id, value);
      return existing._id;
    }

    return await ctx.db.insert("provider_credentials", value);
  },
});

export const deleteCredentials = mutation({
  args: {
    balance: v.id("balances"),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const balance = await ctx.db.get("balances", args.balance);
    if (!balance || balance.userId !== identity._id) throw new Error("Balance not found.");

    const existing = await ctx.db
      .query("provider_credentials")
      .withIndex("by_balance_and_provider", (q) =>
        q.eq("balance", args.balance).eq("provider", args.provider),
      )
      .unique();

    if (existing) await ctx.db.delete("provider_credentials", existing._id);
    return true;
  },
});

export const resolveProviderCandidatesForModel = internalQuery({
  args: {
    balance: v.id("balances"),
    modelSlug: v.string(),
    providerSlug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", args.modelSlug))
      .unique();

    if (!model) throw new Error(`Unknown model: ${args.modelSlug}`);

    const providers = args.providerSlug
      ? await ctx.db
          .query("providers")
          .withIndex("by_slug", (q) => q.eq("slug", args.providerSlug!))
          .take(1)
      : await ctx.db.query("providers").take(200);
    const modelProviders = providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        provider,
        model: provider.models.find((providerModel) => providerModel.model === model.slug),
      }))
      .filter((candidate) => candidate.model);

    if (modelProviders.length === 0) {
      throw new Error(
        args.providerSlug
          ? `Model ${args.modelSlug} is not available on provider ${args.providerSlug}.`
          : `Model ${args.modelSlug} has no configured providers.`,
      );
    }

    const candidates = [];

    for (const modelProvider of modelProviders) {
      const credentials = await ctx.db
        .query("provider_credentials")
        .withIndex("by_balance_and_provider", (q) =>
          q.eq("balance", args.balance).eq("provider", modelProvider.provider.slug),
        )
        .unique();

      if (!credentials) continue;

      candidates.push({
        slug: modelProvider.provider.slug,
        name: modelProvider.provider.name,
        npm: modelProvider.provider.npm,
        env: modelProvider.provider.env,
        doc: modelProvider.provider.doc,
        baseURL: modelProvider.provider.api,
        modelId: modelProvider.model!.upstream_model_id ?? model.slug,
        credentials: credentials.encrypted,
      });
    }

    if (candidates.length === 0) {
      throw new Error(
        args.providerSlug
          ? `No BYOK credentials configured for provider ${args.providerSlug}.`
          : `No BYOK credentials configured for model ${args.modelSlug}.`,
      );
    }

    return candidates;
  },
});
