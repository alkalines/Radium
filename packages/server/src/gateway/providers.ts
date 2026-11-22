import { and, asc, eq, inArray } from "drizzle-orm";
import * as z from "zod";
import {
  resolveProviderRouting,
  type ProviderRouting,
} from "contracts/routing/settings";
import {
  providerModelValidator,
  providerNpmValidator,
  providerSnapshotFromCatalog,
  serviceTiersForModel,
  serviceTiersValidator,
  type ProviderSnapshot,
} from "contracts/workspaces/provider";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import type { Runtime } from "../runtime";
import {
  MAX_PROVIDER_CREDENTIALS,
  readCredentialValues,
  removeCredential,
  type CredentialRow,
} from "./credentials";
import { authors, models, providers, workspaceCredentials, workspaceProviders } from "./schema";

/** A workspace provider row. */
export type WorkspaceProviderRow = typeof workspaceProviders.$inferSelect;

/** A configured workspace provider: its row and the snapshot it resolves to. */
export type WorkspaceProviderRecord = {
  configuration: WorkspaceProviderRow;
  provider: ProviderSnapshot;
};

type CatalogRow = typeof providers.$inferSelect;

/** The catalogue row as a provider snapshot (the shape workspaces store). */
export function catalogSnapshot(row: CatalogRow): ProviderSnapshot {
  return providerSnapshotFromCatalog({
    slug: row.slug,
    name: row.name,
    npm: row.npm,
    env: row.env,
    catalogue_provider: row.catalogueProvider ?? undefined,
    credential_type: row.credentialType ?? undefined,
    oauth_flow: row.oauthFlow ?? undefined,
    doc: row.doc ?? undefined,
    api: row.api ?? undefined,
    models: row.models as ProviderSnapshot["models"],
  });
}

/**
 * The provider a configuration row resolves to: its own snapshot, else (rows created before
 * snapshots) the catalogue row of its slug. `null` for tombstones and unresolvable rows.
 */
function resolveRecord(
  configuration: WorkspaceProviderRow,
  catalog: CatalogRow | undefined,
): WorkspaceProviderRecord | null {
  if (configuration.deletedAt !== null) return null;
  const stored = configuration.snapshot as ProviderSnapshot | null;
  const provider = stored ?? (catalog ? catalogSnapshot(catalog) : null);
  if (!provider || provider.slug !== configuration.provider) return null;
  return {
    configuration,
    provider: {
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        service_tiers: serviceTiersForModel(model),
      })),
    },
  };
}

/** Catalogue rows for the configurations that have no snapshot of their own. */
async function catalogFor(db: Database, configurations: WorkspaceProviderRow[]) {
  const slugs = configurations
    .filter((row) => row.snapshot === null && row.deletedAt === null)
    .map((row) => row.provider);
  if (slugs.length === 0) return new Map<string, CatalogRow>();
  const rows = await db.select().from(providers).where(inArray(providers.slug, slugs));
  return new Map(rows.map((row) => [row.slug, row]));
}

/** Every configured (not deleted) provider of a workspace, oldest configuration first. */
export async function workspaceProviderRecords(
  db: Database,
  workspace: string,
): Promise<WorkspaceProviderRecord[]> {
  const configurations = await db
    .select()
    .from(workspaceProviders)
    .where(eq(workspaceProviders.workspace, workspace))
    .orderBy(workspaceProviders.createdAt, workspaceProviders.id)
    .limit(200);
  const catalog = await catalogFor(db, configurations);
  return configurations.flatMap((configuration) => {
    const record = resolveRecord(configuration, catalog.get(configuration.provider));
    return record ? [record] : [];
  });
}

/** Whether a configured provider may be selected for routing. */
export function isWorkspaceProviderEnabled(record: { configuration: WorkspaceProviderRow }) {
  return record.configuration.enabled && record.configuration.active;
}

/**
 * One configured provider of a workspace, or `null` when it is not configured or was deleted.
 * With `lock`, the configuration row is locked `for update` for the caller's transaction, which
 * serializes every change to that provider (snapshot edits, credential pool changes).
 */
export async function workspaceProviderRecord(
  db: Database,
  workspace: string,
  slug: string,
  options: { lock?: boolean } = {},
): Promise<WorkspaceProviderRecord | null> {
  const query = db
    .select()
    .from(workspaceProviders)
    .where(and(eq(workspaceProviders.workspace, workspace), eq(workspaceProviders.provider, slug)));
  const [configuration] = options.lock ? await query.for("update") : await query;
  if (!configuration) return null;
  const catalog = await catalogFor(db, [configuration]);
  return resolveRecord(configuration, catalog.get(slug));
}

/** A workspace provider's snapshot and whether routing may use it (usage limits, polling). */
export type ProviderContext = { snapshot: ProviderSnapshot; enabled: boolean };

/** {@link ProviderContext} of one provider; `null` when it is not configured or was deleted. */
export async function providerContextFor(
  db: Database,
  workspace: string,
  slug: string,
): Promise<ProviderContext | null> {
  const record = await workspaceProviderRecord(db, workspace, slug);
  return record
    ? { snapshot: record.provider, enabled: isWorkspaceProviderEnabled(record) }
    : null;
}

type ProviderModel = ProviderSnapshot["models"][number];

/** One enabled credential of a routable provider, with its decrypted values. */
export type RoutableCredential = {
  id: string;
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
  /** Provider `oauth_flow`; identifies subscription limit adapters. */
  oauthFlow?: string;
  /** Upstream model id sent to the provider. */
  modelId: string;
  pricing: ProviderModel["pricing"];
  service_tiers?: ProviderModel["service_tiers"];
  inference_modes?: ProviderModel["inference_modes"];
  inferenceMode?: NonNullable<ProviderModel["inference_modes"]>[number];
  /** Pricing captured at dispatch; absent when the requested tier has no published quote. */
  quote?: ProviderModel["pricing"];
  routing: ProviderRouting;
  /** Never empty; in creation order, which breaks fill-first ties inside a priority tier. */
  credentials: RoutableCredential[];
};

/** The provider credential chosen for one routing attempt. */
export type RoutableTarget = Omit<RoutableProvider, "credentials"> & {
  credential: RoutableCredential;
};

// ---------------------------------------------------------------------------------------------
// Owner services (`providers.*`). Authorization (owned workspace) is the procedure's.

const text = (max: number) => z.string().max(max);

/** A global model identity as the import UI supplies it; the author is resolved or created. */
export const globalModelInput = z.object({
  name: text(256),
  slug: text(256).min(1),
  launch_date: z.number(),
  type: z.union([z.literal("chat"), z.literal("embedding"), z.literal("image-generation")]),
  description: text(8192),
  warning: text(2048).optional(),
  model_weights: text(2048).optional(),
  reasoning: z.boolean(),
  features: z.object({
    reasoning_minimal: z.boolean().optional(),
    reasoning_none: z.boolean().optional(),
    reasoning_budget: z.boolean().optional(),
    reasoning_efforts: z.array(text(64)).max(16).optional(),
  }),
  architecture: z.object({
    input_modalities: z.array(text(64)).max(16),
    output_modalities: z.array(text(64)).max(16),
    tokenizer: text(128),
  }),
  default_parameters: z
    .object({
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      frequency_penalty: z.number().optional(),
    })
    .optional(),
  author: z.object({ name: text(256), slug: text(256).min(1) }),
});

/** One imported model: its global identity and this provider's offer of it. */
export const importModelInput = z.object({
  global: globalModelInput,
  provider: providerModelValidator,
});
export type ImportModel = z.infer<typeof importModelInput>;

/** Provider metadata of an import (catalogue entry or owner-defined OpenAI-compatible endpoint). */
export const importProviderInput = z.object({
  slug: text(128).min(1),
  name: text(256),
  npm: providerNpmValidator,
  env: z.array(text(128)).max(16),
  catalogue_provider: text(128).optional(),
  credential_type: z.union([z.literal("api_key"), z.literal("oauth")]).optional(),
  oauth_flow: text(64).optional(),
  doc: text(2048).optional(),
  api: text(2048).optional(),
  enabled: z.boolean().optional(),
});

/** Bound on models in one import or add; a provider catalogue is far below it. */
export const MAX_IMPORT_MODELS = 1000;

/** The owner's view of one configured provider: its snapshot plus id and state. */
function providerView(record: WorkspaceProviderRecord) {
  return {
    ...record.provider,
    id: record.configuration.id,
    createdAt: record.configuration.createdAt.getTime(),
    enabled: record.configuration.enabled,
    active: record.configuration.active,
  };
}

/** Every configured provider of the workspace (owner view). */
export async function listProviders(db: Database, workspace: string) {
  return (await workspaceProviderRecords(db, workspace)).map(providerView);
}

/**
 * The configured provider `slug`, its configuration row locked for the transaction; refuses
 * unconfigured and deleted providers.
 */
export async function requireWorkspaceProvider(tx: Database, workspace: string, slug: string) {
  const record = await workspaceProviderRecord(tx, workspace, slug, { lock: true });
  if (!record) {
    throw new AppError("NOT_FOUND", `Provider ${slug} is not configured for this workspace.`);
  }
  return record;
}

/**
 * Adds the global author and model rows an import names and that do not exist yet. Existing
 * catalogue rows are never changed by a workspace. Concurrent imports of the same slug insert
 * once (unique slugs, `on conflict do nothing`).
 */
async function ensureGlobalModels(tx: Database, entries: ImportModel[]) {
  for (const entry of entries) {
    if (entry.provider.model !== entry.global.slug) {
      throw new AppError(
        "BAD_REQUEST",
        `Provider model "${entry.provider.model}" must reference its global model slug "${entry.global.slug}".`,
      );
    }
  }
  if (entries.length === 0) return;

  const authorsBySlug = new Map(entries.map((entry) => [entry.global.author.slug, entry.global.author]));
  await tx
    .insert(authors)
    .values([...authorsBySlug.values()].map((author) => ({ name: author.name, slug: author.slug })))
    .onConflictDoNothing({ target: authors.slug });
  const authorRows = await tx
    .select({ id: authors.id, slug: authors.slug })
    .from(authors)
    .where(inArray(authors.slug, [...authorsBySlug.keys()]));
  const authorId = new Map(authorRows.map((row) => [row.slug, row.id]));

  const modelsBySlug = new Map(entries.map((entry) => [entry.global.slug, entry.global]));
  await tx
    .insert(models)
    .values(
      [...modelsBySlug.values()].map((model) => ({
        name: model.name,
        slug: model.slug,
        launchDate: new Date(model.launch_date),
        author: authorId.get(model.author.slug)!,
        modelWeights: model.model_weights ?? null,
        type: model.type,
        description: model.description,
        warning: model.warning ?? null,
        reasoning: model.reasoning,
        featuresReasoningMinimal: model.features.reasoning_minimal ?? null,
        featuresReasoningNone: model.features.reasoning_none ?? null,
        featuresReasoningBudget: model.features.reasoning_budget ?? null,
        featuresReasoningEfforts: model.features.reasoning_efforts ?? null,
        architecture: model.architecture,
        defaultTemperature: model.default_parameters?.temperature ?? null,
        defaultTopP: model.default_parameters?.top_p ?? null,
        defaultFrequencyPenalty: model.default_parameters?.frequency_penalty ?? null,
      })),
    )
    .onConflictDoNothing({ target: models.slug });
}

/**
 * Stores a workspace-local provider snapshot (catalogue import or owner-defined endpoint),
 * replacing an earlier configuration of the slug and lifting a tombstone. Global catalogue rows
 * and existing model metadata are never replaced.
 *
 * @returns the configuration id.
 */
export async function importProvider(
  db: Database,
  workspace: string,
  input: { provider: z.infer<typeof importProviderInput>; models: ImportModel[] },
) {
  const { enabled, ...provider } = input.provider;
  if (provider.npm === "@ai-sdk/openai-compatible" && !provider.api) {
    throw new AppError("BAD_REQUEST", "OpenAI-compatible providers require an api base URL.");
  }
  const snapshot = providerSnapshotFromCatalog({
    ...provider,
    models: input.models.map((entry) => entry.provider),
  });
  return await db.transaction(async (tx) => {
    await ensureGlobalModels(tx, input.models);
    // One upsert on the unique (workspace, provider): concurrent imports leave one row.
    const [row] = await tx
      .insert(workspaceProviders)
      .values({
        workspace,
        provider: provider.slug,
        enabled: enabled ?? true,
        active: true,
        snapshot,
      })
      .onConflictDoUpdate({
        target: [workspaceProviders.workspace, workspaceProviders.provider],
        set: { enabled: enabled ?? true, active: true, snapshot, deletedAt: null },
      })
      .returning({ id: workspaceProviders.id });
    return row!.id;
  });
}

/** Writes a new snapshot (and any other columns) of a locked configuration. */
async function updateConfiguration(
  tx: Database,
  record: WorkspaceProviderRecord,
  change: Partial<typeof workspaceProviders.$inferInsert>,
) {
  await tx
    .update(workspaceProviders)
    .set(change)
    .where(eq(workspaceProviders.id, record.configuration.id));
}

/** Enables or disables a provider for routing. Rows created before snapshots get one now. */
export async function setProviderEnabled(
  db: Database,
  workspace: string,
  slug: string,
  enabled: boolean,
) {
  await db.transaction(async (tx) => {
    const record = await requireWorkspaceProvider(tx, workspace, slug);
    await updateConfiguration(tx, record, {
      enabled,
      active: enabled,
      ...(record.configuration.snapshot === null ? { snapshot: record.provider } : {}),
    });
  });
}

/**
 * Merges models into the provider's snapshot (same model id replaces its entry). The
 * configuration row lock makes concurrent edits of one provider apply one after another.
 */
export async function addProviderModels(
  db: Database,
  workspace: string,
  slug: string,
  entries: ImportModel[],
) {
  await db.transaction(async (tx) => {
    const record = await requireWorkspaceProvider(tx, workspace, slug);
    if (entries.length === 0) return;
    await ensureGlobalModels(tx, entries);
    const byModel = new Map(record.provider.models.map((model) => [model.model, model]));
    for (const entry of entries) byModel.set(entry.provider.model, entry.provider);
    if (byModel.size > MAX_IMPORT_MODELS) {
      throw new AppError("BAD_REQUEST", `A provider can offer at most ${MAX_IMPORT_MODELS} models.`);
    }
    await updateConfiguration(tx, record, {
      snapshot: { ...record.provider, models: [...byModel.values()] },
    });
  });
}

/**
 * Replaces one model's service tiers; the `default` tier's pricing becomes the model's base
 * pricing, so ordinary requests are quoted from it. Other model metadata is kept.
 */
export async function setProviderModelServiceTiers(
  db: Database,
  workspace: string,
  input: { slug: string; model: string; service_tiers: z.infer<typeof serviceTiersValidator> },
) {
  await db.transaction(async (tx) => {
    const record = await requireWorkspaceProvider(tx, workspace, input.slug);
    if (!record.provider.models.some((model) => model.model === input.model)) {
      throw new AppError("NOT_FOUND", "Provider model not found.");
    }
    const models = record.provider.models.map((model) => {
      if (model.model !== input.model) return model;
      const pricing =
        input.service_tiers.find((tier) => tier.id === "default")?.pricing ?? model.pricing;
      const updated = { ...model, pricing, service_tiers: input.service_tiers };
      return { ...updated, service_tiers: serviceTiersForModel(updated) };
    });
    await updateConfiguration(tx, record, { snapshot: { ...record.provider, models } });
  });
}

/** Removes one model from the provider's offer; the global model row stays for other providers. */
export async function removeProviderModel(
  db: Database,
  workspace: string,
  slug: string,
  model: string,
) {
  await db.transaction(async (tx) => {
    const record = await requireWorkspaceProvider(tx, workspace, slug);
    await updateConfiguration(tx, record, {
      snapshot: {
        ...record.provider,
        models: record.provider.models.filter((entry) => entry.model !== model),
      },
    });
  });
}

/**
 * Tombstones a provider and removes all of its credentials (secrets, limit keys, limit
 * snapshots, cooldowns; OAuth sessions are ended). The tombstone keeps anything from restoring
 * the provider; a later import lifts it.
 */
export async function deleteProvider(runtime: Runtime, workspace: string, slug: string) {
  const removed: CredentialRow[] = [];
  await runtime.drivers.db.transaction(async (tx) => {
    const record = await requireWorkspaceProvider(tx, workspace, slug);
    for (const credential of await providerCredentialRows(tx, workspace, slug)) {
      await removeCredential(tx, runtime, record.provider, credential);
      removed.push(credential);
    }
    await updateConfiguration(tx, record, {
      enabled: false,
      active: false,
      deletedAt: new Date(),
      ...(record.configuration.snapshot === null ? { snapshot: record.provider } : {}),
    });
  });
  return removed;
}

/** A provider's credential rows in creation order (at most {@link MAX_PROVIDER_CREDENTIALS}). */
export async function providerCredentialRows(db: Database, workspace: string, provider: string) {
  return await db
    .select()
    .from(workspaceCredentials)
    .where(
      and(eq(workspaceCredentials.workspace, workspace), eq(workspaceCredentials.provider, provider)),
    )
    .orderBy(asc(workspaceCredentials.createdAt), asc(workspaceCredentials.id))
    .limit(MAX_PROVIDER_CREDENTIALS);
}

/** Routing configuration errors (unknown model, nothing can serve it); shown to the caller. */
export class RoutingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingConfigurationError";
  }
}

/**
 * Enabled workspace providers that offer `modelSlug`, with their enabled credentials' decrypted
 * values and the owner's routing overrides. Callers apply request preferences, cooldowns and
 * selection. Throws {@link RoutingConfigurationError} when the model is unknown or no provider
 * can serve it. A credential whose secret is missing is skipped; one that fails to decrypt
 * throws (it needs recovery, not silence).
 */
export async function resolveRoutableProviders(
  db: Database,
  runtime: Pick<Runtime, "secrets">,
  workspace: string,
  modelSlug: string,
): Promise<RoutableProvider[]> {
  const [model] = await db
    .select({ slug: models.slug })
    .from(models)
    .where(eq(models.slug, modelSlug));
  if (!model) throw new RoutingConfigurationError(`Unknown model: ${modelSlug}`);

  const offers = (await workspaceProviderRecords(db, workspace))
    .filter(isWorkspaceProviderEnabled)
    .flatMap((record) => {
      const providerModel = record.provider.models.find((candidate) => candidate.model === modelSlug);
      return providerModel ? [{ record, providerModel }] : [];
    });
  if (offers.length === 0) {
    throw new RoutingConfigurationError(`Model ${modelSlug} has no configured providers.`);
  }

  const credentialRows = await db
    .select()
    .from(workspaceCredentials)
    .where(
      and(
        eq(workspaceCredentials.workspace, workspace),
        eq(workspaceCredentials.enabled, true),
        inArray(
          workspaceCredentials.provider,
          offers.map((offer) => offer.record.provider.slug),
        ),
      ),
    )
    .orderBy(asc(workspaceCredentials.createdAt), asc(workspaceCredentials.id));

  const candidates: RoutableProvider[] = [];
  for (const { record, providerModel } of offers) {
    const provider = record.provider;
    const credentials: RoutableCredential[] = [];
    for (const row of credentialRows) {
      if (row.provider !== provider.slug || credentials.length >= MAX_PROVIDER_CREDENTIALS) continue;
      const values = await readCredentialValues(db, runtime.secrets, row);
      if (!values) continue;
      credentials.push({ id: row.id, priority: row.priority, weight: row.weight, values });
    }
    if (credentials.length === 0) continue;
    candidates.push({
      slug: provider.slug,
      name: provider.name,
      npm: provider.npm,
      env: provider.env,
      doc: provider.doc,
      baseURL: provider.api,
      oauthFlow: provider.oauth_flow,
      modelId: providerModel.upstream_model_id ?? modelSlug,
      pricing: providerModel.pricing,
      service_tiers: serviceTiersForModel(providerModel),
      inference_modes: providerModel.inference_modes,
      routing: resolveProviderRouting(
        (record.configuration.routing as ProviderRouting | null) ?? undefined,
      ),
      credentials,
    });
  }
  if (candidates.length === 0) {
    throw new RoutingConfigurationError(`No BYOK credentials configured for model ${modelSlug}.`);
  }
  return candidates;
}
