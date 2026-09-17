import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  providerSnapshotFromCatalog,
  type ProviderSnapshot,
} from "../src/utils/workspaces/provider";

type ProviderContext = QueryCtx | MutationCtx;

export type WorkspaceProviderRecord = {
  configuration: Doc<"workspace_configurations"> | null;
  provider: ProviderSnapshot;
  catalog: Doc<"providers"> | null;
};

/**
 * Resolve local provider snapshots, falling back to the immutable catalogue
 * only for workspaces that have not started local configuration yet.
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
      const provider = configuration.snapshot
        ? configuration.snapshot
        : catalogProvider
          ? providerSnapshotFromCatalog(catalogProvider)
          : null;
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

export function isWorkspaceProviderEnabled(record: WorkspaceProviderRecord): boolean {
  return (record.configuration?.enabled ?? true) && (record.configuration?.active ?? true);
}
