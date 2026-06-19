import { v } from "convex/values";
import { credentialPreview } from "@/utils/credential_preview";
import type { Id } from "./_generated/dataModel";
import { internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { balanceSecretName, providerSecretNamespace, secrets } from "./secrets";

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

function parseProviderCredentials(provider: string, value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Provider credential payload must be an object.");
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch (error) {
    throw new Error(`Stored credentials for provider ${provider} are invalid.`, { cause: error });
  }
}

/**
 * Validator for a global `models` table record as supplied by the import UI.
 * Mirrors {@link schema} minus the resolved `author` id — callers pass the
 * author as a `{ name, slug }` pair which the mutation resolves (or creates).
 */
const globalModelValidator = v.object({
  name: v.string(),
  slug: v.string(),
  launch_date: v.number(),
  type: v.union(v.literal("chat"), v.literal("embedding"), v.literal("image-generation")),
  description: v.string(),
  warning: v.optional(v.string()),
  model_weights: v.optional(v.string()),
  reasoning: v.boolean(),
  features: v.object({
    reasoning_minimal: v.optional(v.boolean()),
    reasoning_none: v.optional(v.boolean()),
    reasoning_budget: v.optional(v.boolean()),
    reasoning_efforts: v.optional(v.array(v.string())),
  }),
  architecture: v.object({
    input_modalities: v.array(v.string()),
    output_modalities: v.array(v.string()),
    tokenizer: v.string(),
  }),
  default_parameters: v.optional(
    v.object({
      temperature: v.optional(v.number()),
      top_p: v.optional(v.number()),
      frequency_penalty: v.optional(v.number()),
    }),
  ),
  author: v.object({
    name: v.string(),
    slug: v.string(),
  }),
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("providers").take(200);
  },
});

/**
 * Resolve an author by slug, creating it on demand for unknown authors.
 * `cache` deduplicates lookups/inserts within a single import batch so the
 * same author shared by several models is only written once.
 */
async function resolveAuthor(
  ctx: MutationCtx,
  author: { name: string; slug: string },
  cache: Map<string, Id<"authors">>,
): Promise<Id<"authors">> {
  const cached = cache.get(author.slug);
  if (cached) return cached;

  const existing = await ctx.db
    .query("authors")
    .filter((q) => q.eq(q.field("slug"), author.slug))
    .first();
  const id = existing
    ? existing._id
    : await ctx.db.insert("authors", { name: author.name, slug: author.slug });

  cache.set(author.slug, id);
  return id;
}

const importModelValidator = v.object({
  global: globalModelValidator,
  provider: providerModelValidator,
});

/**
 * Upsert each global {@link models} record for an import batch, resolving
 * authors on demand. Validates that every provider model references its global
 * slug so the two stores never drift. Shared by {@link importProvider} and
 * {@link addProviderModels}.
 */
async function upsertGlobalModels(
  ctx: MutationCtx,
  models: { global: typeof globalModelValidator.type; provider: { model: string } }[],
) {
  const authorCache = new Map<string, Id<"authors">>();

  for (const entry of models) {
    if (entry.provider.model !== entry.global.slug) {
      throw new Error(
        `Provider model "${entry.provider.model}" must reference its global model slug "${entry.global.slug}".`,
      );
    }

    const authorId = await resolveAuthor(ctx, entry.global.author, authorCache);
    const { author: _author, ...modelFields } = entry.global;
    const modelValue = { ...modelFields, author: authorId };

    const existingModel = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", entry.global.slug))
      .unique();

    if (existingModel) {
      await ctx.db.patch("models", existingModel._id, modelValue);
    } else {
      await ctx.db.insert("models", modelValue);
    }
  }
}

/**
 * Single entry point for adding a gateway provider from the UI. In one
 * transaction it: creates any unknown {@link authors}, upserts each selected
 * model into the global {@link models} table (deduped by slug), and upserts the
 * {@link providers} row (deduped by slug) with its provider-specific model list.
 *
 * Used for both models.dev imports and manual/custom providers — the client
 * shapes the data, this owns persistence and dedup. Replacing an existing
 * provider overwrites its whole model list; use {@link addProviderModels} to
 * merge models into a provider without dropping the rest.
 */
export const importProvider = mutation({
  args: {
    provider: v.object({
      slug: v.string(),
      name: v.string(),
      npm: providerNpmValidator,
      env: v.array(v.string()),
      doc: v.optional(v.string()),
      api: v.optional(v.string()),
      enabled: v.optional(v.boolean()),
    }),
    models: v.array(importModelValidator),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    if (args.provider.npm === "@ai-sdk/openai-compatible" && !args.provider.api) {
      throw new Error("OpenAI-compatible providers require an api base URL.");
    }

    await upsertGlobalModels(ctx, args.models);

    const existing = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.provider.slug))
      .unique();
    const value = {
      slug: args.provider.slug,
      name: args.provider.name,
      npm: args.provider.npm,
      env: args.provider.env,
      doc: args.provider.doc,
      api: args.provider.api,
      enabled: args.provider.enabled ?? true,
      models: args.models.map((entry) => entry.provider),
    };

    if (existing) {
      await ctx.db.replace("providers", existing._id, value);
      return existing._id;
    }

    return await ctx.db.insert("providers", value);
  },
});

export const setEnabled = mutation({
  args: {
    slug: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const provider = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!provider) throw new Error(`Provider ${args.slug} not found.`);

    await ctx.db.patch("providers", provider._id, { enabled: args.enabled });
  },
});

/**
 * Merge models into an existing provider without replacing its whole list.
 * Upserts the global {@link models} records, then adds each provider model
 * (replacing any entry with the same slug). Used by the per-provider model
 * manager to add catalogue or custom models incrementally.
 */
export const addProviderModels = mutation({
  args: {
    slug: v.string(),
    models: v.array(importModelValidator),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");
    if (args.models.length === 0) return;

    const provider = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!provider) throw new Error(`Provider ${args.slug} not found.`);

    await upsertGlobalModels(ctx, args.models);

    const byModel = new Map(provider.models.map((entry) => [entry.model, entry]));
    for (const entry of args.models) byModel.set(entry.provider.model, entry.provider);

    await ctx.db.patch("providers", provider._id, { models: [...byModel.values()] });
  },
});

/**
 * Remove a single model from a provider's offered list. Leaves the shared
 * global {@link models} record untouched, since other providers may serve it.
 */
export const removeProviderModel = mutation({
  args: {
    slug: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const provider = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!provider) throw new Error(`Provider ${args.slug} not found.`);

    await ctx.db.patch("providers", provider._id, {
      models: provider.models.filter((entry) => entry.model !== args.model),
    });
  },
});

/**
 * Delete a provider and any BYOK credentials stored against it. Shared global
 * {@link models} records are left in place — they are provider-independent.
 */
export const deleteProvider = mutation({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const provider = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!provider) throw new Error(`Provider ${args.slug} not found.`);

    const credentialPage = await secrets.list(ctx, {
      namespace: providerSecretNamespace(args.slug),
      paginationOpts: { numItems: 500, cursor: null },
    });
    await Promise.all(
      credentialPage.page.map((credential) =>
        secrets.remove(ctx, {
          namespace: providerSecretNamespace(args.slug),
          name: credential.name,
        }),
      ),
    );

    await ctx.db.delete("providers", provider._id);
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

    const providers = await ctx.db.query("providers").take(200);
    const credentials = [];

    for (const provider of providers) {
      const credential = await secrets.get(ctx, {
        namespace: providerSecretNamespace(provider.slug),
        name: balanceSecretName(args.balance),
      });

      if (!credential.ok) continue;

      credentials.push({
        _id: provider.slug,
        provider: provider.slug,
        preview: credential.metadata?.preview ?? {},
      });
    }

    return credentials;
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

    const preview = Object.fromEntries(
      Object.entries(args.credentials).map(([name, value]) => [name, credentialPreview(value)]),
    );

    await secrets.put(ctx, {
      namespace: providerSecretNamespace(args.provider),
      name: balanceSecretName(args.balance),
      value: JSON.stringify(args.credentials),
      metadata: {
        kind: "provider",
        provider: args.provider,
        balance: args.balance,
        preview,
      },
    });

    return args.provider;
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

    await secrets.remove(ctx, {
      namespace: providerSecretNamespace(args.provider),
      name: balanceSecretName(args.balance),
    });
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
      const credentials = await secrets.get(ctx, {
        namespace: providerSecretNamespace(modelProvider.provider.slug),
        name: balanceSecretName(args.balance),
      });

      if (!credentials.ok) continue;

      candidates.push({
        slug: modelProvider.provider.slug,
        name: modelProvider.provider.name,
        npm: modelProvider.provider.npm,
        env: modelProvider.provider.env,
        doc: modelProvider.provider.doc,
        baseURL: modelProvider.provider.api,
        modelId: modelProvider.model!.upstream_model_id ?? model.slug,
        credentials: parseProviderCredentials(modelProvider.provider.slug, credentials.value),
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
