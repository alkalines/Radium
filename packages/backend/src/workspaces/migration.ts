export const OWNERSHIP_MIGRATION_STEPS = [
  "workspacesFromBalances",
  "workspacesFromSettings",
  "mcpServersToWorkspaces",
  "workspaceConfigurations",
  "workspaceCredentials",
  "apiKeysFromKeys",
  "chatroomSettingsToWorkspaces",
  "chatsToWorkspaces",
  "completionsToWorkspaces",
  "tracesToWorkspaces",
  "spansToWorkspaces",
] as const;

/**
 * Remediation text shared by migration failures and the ownership runbook.
 * Keep this free of document values and secret material.
 */
export const OWNERSHIP_MIGRATION_REMEDIATION =
  "Repair or quarantine the affected record, restore Secret Store key material when required, then rerun the affected migration and its verification query.";

export type LegacyOwnershipRecord = {
  workspace?: string;
  legacyBalance?: string;
};

export type ChatWorkspaceBackfillRecord<WorkspaceId extends string = string> = {
  workspace?: WorkspaceId;
  scope?: "personal" | "workspace";
  balance?: string;
};

export type LegacyChatOwnershipConsistency = {
  chatUserId: string;
  balanceOwnerId?: string;
  workspaceOwnerId?: string;
  balanceId?: string;
  workspaceLegacyBalance?: string;
};

/**
 * Historical chats may only be attached to a workspace when every ownership
 * edge agrees. This intentionally rejects an old chat that was created with a
 * different user's balance instead of attempting to repair or reassign it.
 */
export function isLegacyChatOwnershipConsistent({
  chatUserId,
  balanceOwnerId,
  workspaceOwnerId,
  balanceId,
  workspaceLegacyBalance,
}: LegacyChatOwnershipConsistency): boolean {
  return (
    (balanceOwnerId === undefined || balanceOwnerId === chatUserId) &&
    (workspaceOwnerId === undefined || workspaceOwnerId === chatUserId) &&
    (balanceId === undefined || workspaceLegacyBalance === balanceId)
  );
}

export type SecretFailureReason = "not_found" | "expired" | "key_unavailable";

/** Only an absent secret is an expected migration no-op. */
export function secretFailureNeedsRepair(reason: SecretFailureReason): boolean {
  return reason !== "not_found";
}

/** Preserve a target revocation and propagate a legacy revocation once. */
export function migratedRevocationPatch(
  sourceRevokedAt: number | undefined,
  targetRevokedAt: number | undefined,
): { revokedAt?: number } {
  return sourceRevokedAt !== undefined && targetRevokedAt === undefined
    ? { revokedAt: sourceRevokedAt }
    : {};
}

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
