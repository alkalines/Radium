export const OWNERSHIP_MIGRATION_STEPS = [
  "workspacesFromBalances",
  "workspacesFromSettings",
  "workspaceConfigurations",
  "workspaceCredentials",
  "apiKeysFromKeys",
  "mcpServersToWorkspaces",
  "chatroomSettingsToWorkspaces",
  "chatsToWorkspaces",
  "completionsToWorkspaces",
  "tracesToWorkspaces",
  "spansToWorkspaces",
] as const;

export type LegacyOwnershipRecord = {
  workspace?: string;
  legacyBalance?: string;
};

export type ChatWorkspaceBackfillRecord<WorkspaceId extends string = string> = {
  workspace?: WorkspaceId;
  scope?: "personal" | "workspace";
  balance?: string;
};

/** Migrations must be safe to retry after a partial batch or deployment. */
export function needsLegacyOwnershipBackfill(record: LegacyOwnershipRecord): boolean {
  return record.workspace === undefined && record.legacyBalance !== undefined;
}

/** Build an idempotent patch without overwriting existing chat ownership. */
export function chatWorkspaceBackfillPatch<WorkspaceId extends string>(
  record: ChatWorkspaceBackfillRecord<WorkspaceId>,
  workspace: WorkspaceId,
): { workspace?: WorkspaceId; scope?: "personal" } | undefined {
  if (record.workspace && record.scope) return undefined;
  return {
    ...(record.workspace ? {} : { workspace }),
    ...(record.scope ? {} : { scope: "personal" as const }),
  };
}
