import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  balanceSecretName,
  providerSecretNamespace,
  secrets,
  workspaceProviderSecretNamespace,
  type SecretNamespace,
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
} from "../src/workspaces/provider";
import { canAccessWorkspace } from "../src/workspaces/policy";
import {
  assertValidPlacement,
  resolveProviderRouting,
  type ProviderRouting,
} from "../src/routing/settings";
import {
  MAX_PROVIDER_CREDENTIALS,
  assertRequiredCredentials,
  credentialPlacement,
  credentialDisplayName,
  credentialSecretName,
  isCredentialEnabled,
  maskCredentialValues,
  normalizeCredentialLabel,
} from "../src/workspaces/credentials";
import { subscriptionAdapter } from "../src/subscriptions/registry";

type SecretReadResult = Awaited<ReturnType<typeof secrets.get>>;
type SecretContext = QueryCtx | MutationCtx;
type SecretLookup = { namespace: SecretNamespace; name: string };

/**
 * Treat only a missing value as eligible for legacy fallback. Other Secret Store
 * failures require recovery rather than silently hiding an unavailable credential.
 */
async function readSecret(
  ctx: SecretContext,
  lookup: SecretLookup,
  description: string,
): Promise<SecretReadResult> {
  try {
    const result = await secrets.get(ctx, lookup);
    if (!result.ok && result.reason !== "not_found") {
      throw new Error(`Secret Store recovery required for ${description} (${result.reason}).`);
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Secret Store recovery required")) {
      throw error;
    }
    throw new Error(`Secret Store recovery required for ${description}.`, { cause: error });
  }
}

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

/** List provider snapshots configured for a workspace the caller owns. */
export const list = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    return (await workspaceProviderRecords(ctx, workspace)).map(workspaceProviderView);
  },
});

/**
 * Resolve an owner-configured workspace provider for a mutation, materializing the first local
 * configuration for legacy workspaces. Throws when the caller does not own the workspace or the
 * provider is not configured.
 */
export async function requireWorkspaceProvider(
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
  // Legacy workspaces may materialize their first local provider configuration;
  // workspaces without a legacy mapping must have an explicit configuration.
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

/** Enable or disable provider routing for an owned workspace. */
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
 * Tombstone a provider for this workspace and remove all of its credentials. Keeping the row
 * prevents legacy fallback or a later migration from restoring it.
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

    for (const credential of await providerCredentialRows(ctx, args.workspace, args.slug)) {
      await removeCredential(ctx, workspace, provider, credential);
    }
    await removeLegacyCredential(ctx, workspace, args.slug);
    await ctx.db.patch("workspace_configurations", configuration._id, {
      enabled: false,
      active: false,
      ...(!configuration.snapshot ? { snapshot: provider } : {}),
      deletedAt: Date.now(),
    });
  },
});

/**
 * List every credential of the workspace's providers as masked previews; secret values remain
 * write-only to clients. Ordered by provider, then creation. Entries without `_id` are legacy
 * credentials that the ownership migration has not copied yet.
 */
export const listCredentials = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const result: Array<{
      _id?: Id<"workspace_credentials">;
      provider: string;
      name: string;
      label?: string;
      preview: Record<string, string>;
      enabled: boolean;
      priority: number;
      weight: number;
    }> = [];

    for (const record of await workspaceProviderRecords(ctx, workspace)) {
      const slug = record.provider.slug;
      const rows = await providerCredentialRows(ctx, workspace._id, slug);
      for (const row of rows) {
        result.push({
          _id: row._id,
          provider: slug,
          name: credentialDisplayName(row),
          label: row.label,
          preview: row.preview,
          enabled: isCredentialEnabled(row),
          ...credentialPlacement(row),
        });
      }

      if (rows.some((row) => row.secretName === undefined)) continue;
      const legacy = await readLegacyCredential(ctx, workspace, slug);
      if (!legacy) continue;
      let preview = legacy.metadata?.preview;
      if (!preview) {
        try {
          preview = maskCredentialValues(parseProviderCredentials(slug, legacy.value));
        } catch {
          continue;
        }
      }
      result.push({
        provider: slug,
        name: credentialDisplayName({ preview }),
        preview,
        enabled: true,
        ...credentialPlacement({}),
      });
    }

    return result;
  },
});

/**
 * Add a credential (one value per provider environment variable) to a workspace provider's pool,
 * optionally with its priority and weight inside the provider. Values go to Secret Store; app
 * data keeps only masked previews. OAuth accounts are added through their login flow instead.
 */
export const createCredential = mutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    label: v.optional(v.string()),
    priority: v.optional(v.number()),
    weight: v.optional(v.number()),
    credentials: v.record(v.string(), v.string()),
  },
  returns: v.id("workspace_credentials"),
  handler: async (ctx, args) => {
    const { provider } = await requireWorkspaceProvider(ctx, args.workspace, args.provider);
    if (provider.credential_type === "oauth") {
      throw new Error(`Connect ${provider.name} accounts through its login flow.`);
    }
    assertRequiredCredentials(provider.env, args.credentials);
    assertValidPlacement(credentialPlacement(args));
    const label = args.label === undefined ? undefined : normalizeCredentialLabel(args.label);

    return await insertCredential(ctx, args.workspace, args.provider, {
      values: args.credentials,
      preview: maskCredentialValues(args.credentials),
      label,
      priority: args.priority,
      weight: args.weight,
    });
  },
});

/**
 * Rename, enable/disable, re-rank (priority and weight inside the provider), or replace the
 * values of one credential. Omitted fields are unchanged; an empty label clears it. Replacing
 * values requires every provider environment variable and is not available for OAuth accounts.
 */
export const updateCredential = mutation({
  args: {
    workspace: v.id("workspaces"),
    credential: v.id("workspace_credentials"),
    label: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    weight: v.optional(v.number()),
    credentials: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { provider, credential } = await requireProviderCredential(
      ctx,
      args.workspace,
      args.credential,
    );
    const patch: Partial<Doc<"workspace_credentials">> = {};

    if (args.label !== undefined) patch.label = normalizeCredentialLabel(args.label);
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.priority !== undefined || args.weight !== undefined) {
      const placement = credentialPlacement({
        priority: args.priority ?? credential.priority,
        weight: args.weight ?? credential.weight,
      });
      assertValidPlacement(placement);
      Object.assign(patch, placement);
    }
    if (args.credentials !== undefined) {
      if (provider.credential_type === "oauth") {
        throw new Error(`Reconnect ${provider.name} accounts through its login flow.`);
      }
      assertRequiredCredentials(provider.env, args.credentials);
      patch.preview = maskCredentialValues(args.credentials);
      await secrets.put(ctx, {
        namespace: workspaceProviderSecretNamespace(args.workspace, credential.provider),
        name: credentialSecretName(credential),
        value: JSON.stringify(args.credentials),
        metadata: {
          kind: "provider",
          provider: credential.provider,
          workspace: args.workspace,
          preview: patch.preview,
        },
      });
    }

    await ctx.db.patch("workspace_credentials", credential._id, patch);
    return null;
  },
});

/**
 * Remove one credential, or the provider's legacy credential when `credential` is omitted.
 * Removing an OAuth account also ends its upstream session when its flow has an adapter.
 */
export const deleteCredential = mutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    credential: v.optional(v.id("workspace_credentials")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.credential === undefined) {
      const { workspace } = await requireWorkspaceProvider(ctx, args.workspace, args.provider);
      await removeLegacyCredential(ctx, workspace, args.provider);
      return null;
    }

    const { workspace, provider, credential } = await requireProviderCredential(
      ctx,
      args.workspace,
      args.credential,
    );
    if (credential.provider !== args.provider) throw new Error("Credential not found.");
    await removeCredential(ctx, workspace, provider, credential);
    return null;
  },
});

/**
 * Bind an upstream OAuth/subscription session to a workspace after a provider's login flow
 * completes. `credentials` are the values the flow stores for that session; binding the same
 * values again only refreshes the preview. A new session for an already connected upstream
 * `account` replaces that account's values and ends the replaced session through the flow's
 * adapter; any other session adds a credential to the pool.
 */
export const bindOAuthCredential = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    userId: v.string(),
    account: v.optional(v.string()),
    credentials: v.record(v.string(), v.string()),
    preview: v.record(v.string(), v.string()),
  },
  returns: v.null(),
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
    let provider: ProviderSnapshot | null = null;
    if (configuration) {
      // A tombstone is an explicit deletion and must not fall back to the catalog.
      if (configuration.deletedAt === undefined) {
        provider =
          configuration.snapshot ?? (catalog ? providerSnapshotFromCatalog(catalog) : null);
      }
    } else if (workspace.legacyBalance && catalog) {
      provider = providerSnapshotFromCatalog(catalog);
    }
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

    const rows = await providerCredentialRows(ctx, args.workspace, args.provider);
    const sessionOwner = await findCredentialByValues(ctx, rows, args.credentials);
    if (sessionOwner) {
      await ctx.db.patch("workspace_credentials", sessionOwner._id, {
        preview: args.preview,
        account: args.account ?? sessionOwner.account,
      });
      return null;
    }

    const sameAccount =
      args.account === undefined ? undefined : rows.find((row) => row.account === args.account);
    if (!sameAccount) {
      await insertCredential(ctx, args.workspace, args.provider, {
        values: args.credentials,
        preview: args.preview,
        account: args.account,
      });
      return null;
    }

    // Reconnecting an account: keep its row (label, routing state) and end the replaced session.
    const namespace = workspaceProviderSecretNamespace(args.workspace, args.provider);
    const name = credentialSecretName(sameAccount);
    const previous = await readStoredValues(ctx, namespace, name);
    await secrets.put(ctx, {
      namespace,
      name,
      value: JSON.stringify(args.credentials),
      metadata: {
        kind: "provider",
        provider: args.provider,
        workspace: args.workspace,
        preview: args.preview,
      },
    });
    await ctx.db.patch("workspace_credentials", sameAccount._id, { preview: args.preview });
    if (previous) await subscriptionAdapter(provider)?.endSession(ctx, previous);
    return null;
  },
});

/**
 * Remove the credential holding exactly `credentials` after its upstream session logged out or
 * expired. Other accounts of the provider are untouched.
 */
export const unbindOAuthCredential = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    userId: v.string(),
    credentials: v.record(v.string(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || !canAccessWorkspace(workspace, args.userId)) {
      throw new Error("Workspace not found.");
    }
    const rows = await providerCredentialRows(ctx, args.workspace, args.provider);
    const credential = await findCredentialByValues(ctx, rows, args.credentials);
    if (credential) await removeCredentialRecord(ctx, workspace, credential);
    return null;
  },
});

/** One credential of a routable provider; `id` is absent for a legacy, not yet migrated one. */
export type RoutableCredential = {
  id?: Id<"workspace_credentials">;
  /** Tier inside the provider; higher is tried first. */
  priority: number;
  /** Share inside the provider for `weighted-round-robin`. */
  weight: number;
  values: Record<string, string>;
};

/** An enabled workspace provider that offers the requested model, with its enabled credentials. */
export type RoutableProvider = {
  slug: string;
  name: string;
  npm: ProviderSnapshot["npm"];
  env: string[];
  doc?: string;
  baseURL?: string;
  /** Upstream model ID sent to the provider. */
  modelId: string;
  pricing: ProviderSnapshot["models"][number]["pricing"];
  routing: ProviderRouting;
  /** Never empty; in creation order, which breaks fill-first ties inside a priority tier. */
  credentials: RoutableCredential[];
};

/** The provider credential chosen for one routing attempt. */
export type RoutableTarget = Omit<RoutableProvider, "credentials"> & {
  credential: RoutableCredential;
};

/**
 * Resolve enabled workspace providers that offer `modelSlug` with their enabled, readable
 * credentials and owner routing overrides. Callers apply request preferences, cooldowns, and
 * selection. Throws when the model is unknown or no provider can serve it, so callers can report
 * configuration errors.
 */
export async function resolveRoutableProviders(
  ctx: SecretContext,
  workspace: Doc<"workspaces">,
  modelSlug: string,
): Promise<RoutableProvider[]> {
  if (workspace.archivedAt !== undefined) throw new Error("Workspace not found.");

  const model = await ctx.db
    .query("models")
    .withIndex("by_slug", (q) => q.eq("slug", modelSlug))
    .unique();

  if (!model) throw new Error(`Unknown model: ${modelSlug}`);

  const modelProviders = (await workspaceProviderRecords(ctx, workspace))
    .filter(isWorkspaceProviderEnabled)
    .flatMap((record) => {
      const providerModel = record.provider.models.find(
        (candidate) => candidate.model === modelSlug,
      );
      return providerModel ? [{ record, providerModel }] : [];
    });

  if (modelProviders.length === 0) {
    throw new Error(`Model ${modelSlug} has no configured providers.`);
  }

  const candidates: RoutableProvider[] = [];

  for (const { record, providerModel } of modelProviders) {
    const provider = record.provider;
    const credentials = await providerCredentials(ctx, workspace, provider.slug);
    if (credentials.length === 0) continue;

    candidates.push({
      slug: provider.slug,
      name: provider.name,
      npm: provider.npm,
      env: provider.env,
      doc: provider.doc,
      baseURL: provider.api,
      modelId: providerModel.upstream_model_id ?? model.slug,
      pricing: providerModel.pricing,
      routing: resolveProviderRouting(record.configuration?.routing),
      credentials,
    });
  }

  if (candidates.length === 0) {
    throw new Error(`No BYOK credentials configured for model ${modelSlug}.`);
  }

  return candidates;
}

/** A provider's credential rows in creation order. */
async function providerCredentialRows(
  ctx: SecretContext,
  workspace: Id<"workspaces">,
  provider: string,
) {
  return await ctx.db
    .query("workspace_credentials")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace).eq("provider", provider),
    )
    .take(MAX_PROVIDER_CREDENTIALS);
}

/**
 * Enabled credentials with readable values. A legacy workspace's provider-slug credential that
 * no row owns yet is read from the workspace namespace, then the pre-workspace namespace.
 */
async function providerCredentials(
  ctx: SecretContext,
  workspace: Doc<"workspaces">,
  provider: string,
): Promise<RoutableCredential[]> {
  const rows = await providerCredentialRows(ctx, workspace._id, provider);
  const credentials: RoutableCredential[] = [];

  for (const row of rows) {
    if (!isCredentialEnabled(row)) continue;
    const stored = await readSecret(
      ctx,
      {
        namespace: workspaceProviderSecretNamespace(workspace._id, provider),
        name: credentialSecretName(row),
      },
      `workspace provider ${provider} credential`,
    );
    if (!stored.ok) continue;
    credentials.push({
      id: row._id,
      ...credentialPlacement(row),
      values: parseProviderCredentials(provider, stored.value),
    });
  }

  if (!rows.some((row) => row.secretName === undefined)) {
    const legacy = await readLegacyCredential(ctx, workspace, provider);
    if (legacy) {
      credentials.push({
        ...credentialPlacement({}),
        values: parseProviderCredentials(provider, legacy.value),
      });
    }
  }

  return credentials;
}

/**
 * A legacy workspace's provider-slug credential that no row owns: the workspace-namespace copy,
 * else the pre-workspace secret. `null` outside legacy workspaces.
 */
async function readLegacyCredential(
  ctx: SecretContext,
  workspace: Doc<"workspaces">,
  provider: string,
): Promise<Extract<SecretReadResult, { ok: true }> | null> {
  if (!workspace.legacyBalance) return null;

  const current = await readSecret(
    ctx,
    { namespace: workspaceProviderSecretNamespace(workspace._id, provider), name: provider },
    `workspace provider ${provider} credential`,
  );
  if (current.ok) return current;

  const legacy = await readSecret(
    ctx,
    {
      namespace: providerSecretNamespace(provider),
      name: balanceSecretName(workspace.legacyBalance),
    },
    `legacy provider ${provider} credential`,
  );
  return legacy.ok ? legacy : null;
}

/** Resolve a credential row of an owned, configured workspace provider. */
async function requireProviderCredential(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  credentialId: Id<"workspace_credentials">,
) {
  const credential = await ctx.db.get("workspace_credentials", credentialId);
  if (!credential || credential.workspace !== workspaceId) {
    throw new Error("Credential not found.");
  }
  const resolved = await requireWorkspaceProvider(ctx, workspaceId, credential.provider);
  return { ...resolved, credential };
}

/** Insert a pooled credential row and its secret, named after the row ID. */
async function insertCredential(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  provider: string,
  credential: {
    values: Record<string, string>;
    preview: Record<string, string>;
    label?: string;
    account?: string;
    priority?: number;
    weight?: number;
  },
) {
  const existing = await providerCredentialRows(ctx, workspace, provider);
  if (existing.length >= MAX_PROVIDER_CREDENTIALS) {
    throw new Error(`A provider can hold at most ${MAX_PROVIDER_CREDENTIALS} credentials.`);
  }

  const id = await ctx.db.insert("workspace_credentials", {
    workspace,
    provider,
    preview: credential.preview,
    label: credential.label,
    account: credential.account,
    priority: credential.priority,
    weight: credential.weight,
  });
  await ctx.db.patch("workspace_credentials", id, { secretName: id });
  await secrets.put(ctx, {
    namespace: workspaceProviderSecretNamespace(workspace, provider),
    name: id,
    value: JSON.stringify(credential.values),
    metadata: { kind: "provider", provider, workspace, preview: credential.preview },
  });
  return id;
}

/**
 * Remove a credential row, its secret, and its cooldowns. For an OAuth provider with a registered
 * flow adapter, the credential's upstream session is ended too.
 */
async function removeCredential(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  provider: ProviderSnapshot,
  credential: Doc<"workspace_credentials">,
) {
  const adapter = subscriptionAdapter(provider);
  if (adapter) {
    const values = await readStoredValues(
      ctx,
      workspaceProviderSecretNamespace(workspace._id, credential.provider),
      credentialSecretName(credential),
    );
    if (values) await adapter.endSession(ctx, values);
  }
  await removeCredentialRecord(ctx, workspace, credential);
}

async function removeCredentialRecord(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  credential: Doc<"workspace_credentials">,
) {
  await secrets.remove(ctx, {
    namespace: workspaceProviderSecretNamespace(workspace._id, credential.provider),
    name: credentialSecretName(credential),
  });
  // The provider-slug credential may have a pre-workspace copy that legacy fallback would restore.
  if (credential.secretName === undefined && workspace.legacyBalance) {
    await secrets.remove(ctx, {
      namespace: providerSecretNamespace(credential.provider),
      name: balanceSecretName(workspace.legacyBalance),
    });
  }

  const cooldowns = await ctx.db
    .query("routing_cooldowns")
    .withIndex("by_workspace_provider_credential_model", (q) =>
      q
        .eq("workspace", workspace._id)
        .eq("provider", credential.provider)
        .eq("credential", credential._id),
    )
    .take(500);
  for (const cooldown of cooldowns) await ctx.db.delete("routing_cooldowns", cooldown._id);

  await ctx.db.delete("workspace_credentials", credential._id);
}

/** Remove the provider-slug credential no row owns, in both workspace and legacy namespaces. */
async function removeLegacyCredential(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  provider: string,
) {
  const owned = (await providerCredentialRows(ctx, workspace._id, provider)).some(
    (row) => row.secretName === undefined,
  );
  if (!owned) {
    await secrets.remove(ctx, {
      namespace: workspaceProviderSecretNamespace(workspace._id, provider),
      name: provider,
    });
  }
  if (workspace.legacyBalance) {
    await secrets.remove(ctx, {
      namespace: providerSecretNamespace(provider),
      name: balanceSecretName(workspace.legacyBalance),
    });
  }
}

/** The row whose stored values equal `values` exactly, if any. */
async function findCredentialByValues(
  ctx: MutationCtx,
  rows: Doc<"workspace_credentials">[],
  values: Record<string, string>,
) {
  const names = Object.keys(values);
  for (const row of rows) {
    const stored = await readStoredValues(
      ctx,
      workspaceProviderSecretNamespace(row.workspace, row.provider),
      credentialSecretName(row),
    );
    if (!stored || Object.keys(stored).length !== names.length) continue;
    if (names.every((name) => stored[name] === values[name])) return row;
  }
  return undefined;
}

/**
 * A credential's stored values. Unreadable or malformed secrets read as absent so that
 * disconnecting never gets stuck on them.
 */
async function readStoredValues(ctx: MutationCtx, namespace: SecretNamespace, name: string) {
  try {
    const stored = await secrets.get(ctx, { namespace, name });
    return stored.ok ? parseProviderCredentials(name, stored.value) : undefined;
  } catch {
    return undefined;
  }
}
