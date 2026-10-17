import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { providerSnapshotFromCatalog, type ProviderSnapshot } from "../src/workspaces/provider";

type ProviderContext = QueryCtx | MutationCtx;

/** A workspace's provider snapshot and the optional rows it was resolved from. */
export type WorkspaceProviderRecord = {
  configuration: Doc<"workspace_configurations"> | null;
  provider: ProviderSnapshot;
  catalog: Doc<"providers"> | null;
};

/**
 * Resolve local provider snapshots, using catalogue metadata when a snapshot is
 * missing. Legacy workspaces without local configuration also expose enabled
 * catalogue providers until they begin configuring providers locally.
 */
export async function workspaceProviderRecords(
  ctx: ProviderContext,
  workspace: Doc<"workspaces">,
): Promise<WorkspaceProviderRecord[]> {
  const configurations = await ctx.db
    .query("workspace_configurations")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
    .take(200);
  const catalog = await ctx.db.query("providers").take(200);
  const catalogBySlug = new Map(catalog.map((provider) => [provider.slug, provider]));

  if (configurations.length > 0) {
    const records: WorkspaceProviderRecord[] = [];
    for (const configuration of configurations) {
      if (configuration.deletedAt !== undefined) continue;
      const catalogProvider = catalogBySlug.get(configuration.provider) ?? null;
      let provider = configuration.snapshot;
      if (!provider && catalogProvider) {
        provider = providerSnapshotFromCatalog(catalogProvider);
      }
      if (!provider || provider.slug !== configuration.provider) continue;
      records.push({ configuration, provider, catalog: catalogProvider });
    }
    return records;
  }

  if (!workspace.legacyBalance) return [];
  return catalog
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      configuration: null,
      provider: providerSnapshotFromCatalog(provider),
      catalog: provider,
    }));
}

/** Build the public workspace view using local configuration before catalogue defaults. */
export function workspaceProviderView(record: WorkspaceProviderRecord) {
  const catalogEnabled = record.catalog?.enabled ?? true;
  return {
    _id: record.configuration?._id ?? record.catalog?._id ?? record.provider.slug,
    _creationTime: record.configuration?._creationTime ?? record.catalog?._creationTime ?? 0,
    ...record.provider,
    enabled: record.configuration?.enabled ?? catalogEnabled,
    active: record.configuration?.active ?? catalogEnabled,
  };
}

/** Whether a configured provider may be selected for workspace routing. */
export function isWorkspaceProviderEnabled(record: WorkspaceProviderRecord): boolean {
  return (record.configuration?.enabled ?? true) && (record.configuration?.active ?? true);
}
