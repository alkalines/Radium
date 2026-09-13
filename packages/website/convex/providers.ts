import { v } from "convex/values";
import { credentialPreview } from "@/utils/credential_preview";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import {
  balanceSecretName,
  providerSecretNamespace,
  secrets,
  workspaceProviderSecretNamespace,
} from "./secrets";
import { requireOwnedWorkspace } from "./workspaces";
import {
  isWorkspaceProviderEnabled,
  workspaceProviderRecords,
  workspaceProviderView,
} from "./provider_records";
import {
  providerModelValidator,
  providerNpmValidator,
  providerSnapshotFromCatalog,
  type ProviderSnapshot,
} from "../src/utils/workspaces/provider";
import { canAccessWorkspace } from "../src/utils/workspaces/policy";

function parseProviderCredentials(provider: string, value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Provider credential payload must be an object.");
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
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
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    return (await workspaceProviderRecords(ctx, workspace)).map(workspaceProviderView);
  },
});

async function requireWorkspaceProvider(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  slug: string,
) {
  const workspace = await requireOwnedWorkspace(ctx, workspaceId);
  const catalog = await ctx.db
    .query("providers")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();

  const configuration = await ctx.db
    .query("workspace_configurations")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspaceId).eq("provider", slug),
    )
    .first();
  if (configuration) {
    if (configuration.deletedAt !== undefined) {
      throw new Error(`Provider ${slug} is not configured for this workspace.`);
    }
    const provider = configuration.snapshot
      ? configuration.snapshot
      : catalog
        ? providerSnapshotFromCatalog(catalog)
        : null;
    if (!provider || provider.slug !== slug) {
      throw new Error(`Provider ${slug} is not configured for this workspace.`);
    }
    return { workspace, provider, configuration, catalog };
  }
  if (!workspace.legacyBalance || !catalog) {
    throw new Error(`Provider ${slug} is not configured for this workspace.`);
  }

  const created = await ctx.db.insert("workspace_configurations", {
    workspace: workspaceId,
    provider: slug,
    enabled: catalog.enabled,
    active: catalog.enabled,
    snapshot: providerSnapshotFromCatalog(catalog),
  });
  const createdConfiguration = await ctx.db.get("workspace_configurations", created);
  if (!createdConfiguration) throw new Error("Failed to configure provider.");
  return {
    workspace,
    provider: providerSnapshotFromCatalog(catalog),
    configuration: createdConfiguration,
    catalog,
  };
}

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
 * Add missing global model identity records for an import batch, resolving
 * authors on demand. Existing catalogue metadata is immutable from workspace
 * mutations. Validates that every provider model references its global slug.
 */
async function ensureGlobalModels(
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

    if (!existingModel) await ctx.db.insert("models", modelValue);
  }
}

/**
 * Store a workspace-local provider snapshot. Global catalogue rows and model
 * metadata are never replaced by workspace mutations.
 */
export const importProvider = mutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.object({
      slug: v.string(),
      name: v.string(),
      npm: providerNpmValidator,
      env: v.array(v.string()),
      catalogue_provider: v.optional(v.string()),
      credential_type: v.optional(v.union(v.literal("api_key"), v.literal("oauth"))),
      oauth_flow: v.optional(v.string()),
      doc: v.optional(v.string()),
      api: v.optional(v.string()),
      enabled: v.optional(v.boolean()),
    }),
    models: v.array(importModelValidator),
  },
  handler: async (ctx, args) => {
    await requireOwnedWorkspace(ctx, args.workspace);

    if (args.provider.npm === "@ai-sdk/openai-compatible" && !args.provider.api) {
      throw new Error("OpenAI-compatible providers require an api base URL.");
    }

    await ensureGlobalModels(ctx, args.models);

    const snapshot: ProviderSnapshot = providerSnapshotFromCatalog({
      ...args.provider,
      models: args.models.map((entry) => entry.provider),
    });

    const configuration = await ctx.db
      .query("workspace_configurations")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.provider.slug),
      )
      .first();
    if (configuration) {
      await ctx.db.patch("workspace_configurations", configuration._id, {
        enabled: args.provider.enabled ?? true,
        active: true,
        snapshot,
        deletedAt: undefined,
      });
      return configuration._id;
    }

    return await ctx.db.insert("workspace_configurations", {
      workspace: args.workspace,
      provider: args.provider.slug,
      enabled: args.provider.enabled ?? true,
      active: true,
      snapshot,
    });
  },
});

export const setEnabled = mutation({
  args: {
    workspace: v.id("workspaces"),
    slug: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { configuration, provider } = await requireWorkspaceProvider(
      ctx,
      args.workspace,
      args.slug,
    );
    await ctx.db.patch("workspace_configurations", configuration._id, {
      enabled: args.enabled,
      active: args.enabled,
      ...(!configuration.snapshot ? { snapshot: provider } : {}),
    });
  },
});

/**
 * Merge models into this workspace's provider snapshot without replacing the
 * global catalogue row. Global model identity records are added only when the
 * slug is new.
 */
export const addProviderModels = mutation({
  args: {
    workspace: v.id("workspaces"),
    slug: v.string(),
    models: v.array(importModelValidator),
  },
  handler: async (ctx, args) => {
    const { configuration, provider } = await requireWorkspaceProvider(
      ctx,
      args.workspace,
      args.slug,
    );
    if (args.models.length === 0) return;

    await ensureGlobalModels(ctx, args.models);

    const byModel = new Map(provider.models.map((entry) => [entry.model, entry]));
    for (const entry of args.models) byModel.set(entry.provider.model, entry.provider);

    await ctx.db.patch("workspace_configurations", configuration._id, {
      snapshot: { ...provider, models: [...byModel.values()] },
    });
  },
});

/**
 * Remove a single model from a provider's offered list. Leaves the shared
 * global {@link models} record untouched, since other providers may serve it.
 */
export const removeProviderModel = mutation({
  args: {
    workspace: v.id("workspaces"),
    slug: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const { configuration, provider } = await requireWorkspaceProvider(
      ctx,
      args.workspace,
      args.slug,
    );
    await ctx.db.patch("workspace_configurations", configuration._id, {
      snapshot: {
        ...provider,
        models: provider.models.filter((entry) => entry.model !== args.model),
      },
    });
  },
});

/**
 * Tombstone a provider for this workspace and remove its credentials. Keeping
 * the row prevents legacy fallback or a later migration from restoring it.
 */
export const deleteProvider = mutation({
  args: {
    workspace: v.id("workspaces"),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const { configuration, provider, workspace } = await requireWorkspaceProvider(
      ctx,
      args.workspace,
      args.slug,
    );

    await secrets.remove(ctx, {
      namespace: workspaceProviderSecretNamespace(args.workspace, args.slug),
      name: args.slug,
    });
    const credential = await ctx.db
      .query("workspace_credentials")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.slug),
      )
      .first();
    if (credential) await ctx.db.delete("workspace_credentials", credential._id);
    if (workspace.legacyBalance) {
      await secrets.remove(ctx, {
        namespace: providerSecretNamespace(args.slug),
        name: balanceSecretName(workspace.legacyBalance),
      });
    }
    await ctx.db.patch("workspace_configurations", configuration._id, {
      enabled: false,
      active: false,
      ...(!configuration.snapshot ? { snapshot: provider } : {}),
      deletedAt: Date.now(),
    });
  },
});

export const listCredentials = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const credentials = await ctx.db
      .query("workspace_credentials")
      .withIndex("by_workspace_and_provider", (q) => q.eq("workspace", args.workspace))
      .take(200);
    const configurations = await ctx.db
      .query("workspace_configurations")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .take(200);
    const deletedProviders = new Set(
      configurations
        .filter((configuration) => configuration.deletedAt !== undefined)
        .map((configuration) => configuration.provider),
    );
    const result = new Map<
      string,
      { _id?: Id<"workspace_credentials">; provider: string; preview: Record<string, string> }
    >(
      credentials
        .filter((credential) => !deletedProviders.has(credential.provider))
        .map(
          (credential) =>
            [
              credential.provider,
              { _id: credential._id, provider: credential.provider, preview: credential.preview },
            ] as const,
        ),
    );

    // Keep legacy credentials visible before the Secret Store backfill completes.
    if (workspace.legacyBalance) {
      const providers = await ctx.db.query("providers").take(200);
      for (const provider of providers) {
        if (result.has(provider.slug) || deletedProviders.has(provider.slug)) continue;
        const legacy = await secrets.get(ctx, {
          namespace: providerSecretNamespace(provider.slug),
          name: balanceSecretName(workspace.legacyBalance),
        });
        if (!legacy.ok) continue;
        let preview = legacy.metadata?.preview;
        if (!preview) {
          try {
            preview = Object.fromEntries(
              Object.entries(parseProviderCredentials(provider.slug, legacy.value)).map(
                ([name, value]) => [name, credentialPreview(value)],
              ),
            );
          } catch {
            continue;
          }
        }
        result.set(provider.slug, { provider: provider.slug, preview });
      }
    }

    return [...result.values()];
  },
});

export const upsertCredentials = mutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    credentials: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const { provider } = await requireWorkspaceProvider(ctx, args.workspace, args.provider);

    for (const requiredName of provider.env) {
      if (!args.credentials[requiredName]) {
        throw new Error(`Missing required credential value: ${requiredName}`);
      }
    }

    const preview = Object.fromEntries(
      Object.entries(args.credentials).map(([name, value]) => [name, credentialPreview(value)]),
    );

    await secrets.put(ctx, {
      namespace: workspaceProviderSecretNamespace(args.workspace, args.provider),
      name: args.provider,
      value: JSON.stringify(args.credentials),
      metadata: {
        kind: "provider",
        provider: args.provider,
        workspace: args.workspace,
        preview,
      },
    });

    const existing = await ctx.db
      .query("workspace_credentials")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.provider),
      )
      .first();
    if (existing) {
      await ctx.db.patch("workspace_credentials", existing._id, { preview });
    } else {
      await ctx.db.insert("workspace_credentials", {
        workspace: args.workspace,
        provider: args.provider,
        preview,
      });
    }

    return args.provider;
  },
});

export const deleteCredentials = mutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);

    await secrets.remove(ctx, {
      namespace: workspaceProviderSecretNamespace(args.workspace, args.provider),
      name: args.provider,
    });
    if (workspace.legacyBalance) {
      await secrets.remove(ctx, {
        namespace: providerSecretNamespace(args.provider),
        name: balanceSecretName(workspace.legacyBalance),
      });
    }
    const credential = await ctx.db
      .query("workspace_credentials")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.provider),
      )
      .first();
    if (credential) await ctx.db.delete("workspace_credentials", credential._id);
    return true;
  },
});

/** Associates an opaque OAuth session with a workspace after the device flow completes. */
export const bindOAuthCredential = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    userId: v.string(),
    credentials: v.record(v.string(), v.string()),
    preview: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    const configuration = await ctx.db
      .query("workspace_configurations")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.provider),
      )
      .first();
    const catalog = await ctx.db
      .query("providers")
      .withIndex("by_slug", (q) => q.eq("slug", args.provider))
      .unique();
    if (!workspace || !canAccessWorkspace(workspace, args.userId)) {
      throw new Error("Workspace not found.");
    }
    const provider = configuration
      ? configuration.deletedAt === undefined
        ? (configuration.snapshot ?? (catalog ? providerSnapshotFromCatalog(catalog) : null))
        : null
      : workspace.legacyBalance && catalog
        ? providerSnapshotFromCatalog(catalog)
        : null;
    if (!provider || provider.credential_type !== "oauth") {
      throw new Error(`OAuth provider ${args.provider} is not configured.`);
    }
    if (configuration && !configuration.snapshot) {
      await ctx.db.patch("workspace_configurations", configuration._id, { snapshot: provider });
    } else if (!configuration && workspace.legacyBalance) {
      await ctx.db.insert("workspace_configurations", {
        workspace: args.workspace,
        provider: args.provider,
        enabled: catalog?.enabled ?? true,
        active: catalog?.enabled ?? true,
        snapshot: provider,
      });
    }

    await secrets.put(ctx, {
      namespace: workspaceProviderSecretNamespace(args.workspace, args.provider),
      name: args.provider,
      value: JSON.stringify(args.credentials),
      metadata: {
        kind: "provider",
        provider: args.provider,
        workspace: args.workspace,
        preview: args.preview,
      },
    });
    const existing = await ctx.db
      .query("workspace_credentials")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.provider),
      )
      .first();
    if (existing)
      await ctx.db.patch("workspace_credentials", existing._id, { preview: args.preview });
    else {
      await ctx.db.insert("workspace_credentials", {
        workspace: args.workspace,
        provider: args.provider,
        preview: args.preview,
      });
    }
  },
});

/** Removes an OAuth workspace binding when its upstream session is disconnected. */
export const unbindOAuthCredential = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || !canAccessWorkspace(workspace, args.userId)) {
      throw new Error("Workspace not found.");
    }
    await secrets.remove(ctx, {
      namespace: workspaceProviderSecretNamespace(args.workspace, args.provider),
      name: args.provider,
    });
    if (workspace.legacyBalance) {
      await secrets.remove(ctx, {
        namespace: providerSecretNamespace(args.provider),
        name: balanceSecretName(workspace.legacyBalance),
      });
    }
    const credential = await ctx.db
      .query("workspace_credentials")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.provider),
      )
      .first();
    if (credential) await ctx.db.delete("workspace_credentials", credential._id);
  },
});

export const resolveProviderCandidatesForModel = internalQuery({
  args: {
    workspace: v.id("workspaces"),
    modelSlug: v.string(),
    providerSlug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || workspace.archivedAt !== undefined) throw new Error("Workspace not found.");

    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", args.modelSlug))
      .unique();

    if (!model) throw new Error(`Unknown model: ${args.modelSlug}`);

    const providerRecords = (await workspaceProviderRecords(ctx, workspace)).filter(
      (record) =>
        (!args.providerSlug || record.provider.slug === args.providerSlug) &&
        isWorkspaceProviderEnabled(record),
    );
    const modelProviders = providerRecords.flatMap(({ provider }) => {
      const model = provider.models.find((candidate) => candidate.model === args.modelSlug);
      return model ? [{ provider, model }] : [];
    });

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
        namespace: workspaceProviderSecretNamespace(args.workspace, modelProvider.provider.slug),
        name: modelProvider.provider.slug,
      });

      const legacyCredentials =
        !credentials.ok && workspace.legacyBalance
          ? await secrets.get(ctx, {
              namespace: providerSecretNamespace(modelProvider.provider.slug),
              name: balanceSecretName(workspace.legacyBalance),
            })
          : null;

      const storedCredentials = credentials.ok ? credentials : legacyCredentials;
      if (!storedCredentials?.ok) continue;

      candidates.push({
        slug: modelProvider.provider.slug,
        name: modelProvider.provider.name,
        npm: modelProvider.provider.npm,
        env: modelProvider.provider.env,
        doc: modelProvider.provider.doc,
        baseURL: modelProvider.provider.api,
        modelId: modelProvider.model!.upstream_model_id ?? model.slug,
        credentials: parseProviderCredentials(modelProvider.provider.slug, storedCredentials.value),
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
