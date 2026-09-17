import { describe, expect, test } from "bun:test";

import {
  isLegacyChatOwnershipConsistent,
  migratedRevocationPatch,
  OWNERSHIP_MIGRATION_STEPS,
  OWNERSHIP_MIGRATION_REMEDIATION,
  secretFailureNeedsRepair,
  type ChatWorkspaceBackfillRecord,
  chatWorkspaceBackfillPatch,
  needsLegacyOwnershipBackfill,
} from "./migration";

describe("workspace ownership migration", () => {
  test("keeps migration steps ordered from owners to dependent records", () => {
    expect(OWNERSHIP_MIGRATION_STEPS).toEqual([
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
    ]);
  });

  test("only backfills records that retain a legacy balance owner", () => {
    expect(needsLegacyOwnershipBackfill({ legacyBalance: "balance_1" })).toBe(true);
    expect(
      needsLegacyOwnershipBackfill({ workspace: "workspace_1", legacyBalance: "balance_1" }),
    ).toBe(false);
    expect(needsLegacyOwnershipBackfill({})).toBe(false);
  });

  test("preserves existing chat ownership and is safe to repeat", () => {
    const existing = {
      workspace: "workspace_existing",
      scope: undefined,
      balance: "balance_1",
      messages: ["keep me"],
    };
    const patch = chatWorkspaceBackfillPatch(existing, "workspace_new");
    expect(patch).toEqual({ scope: "personal" });

    const migrated = { ...existing, ...patch };
    expect(migrated).toEqual({
      workspace: "workspace_existing",
      scope: "personal",
      balance: "balance_1",
      messages: ["keep me"],
    });
    expect(chatWorkspaceBackfillPatch(migrated, "workspace_new")).toBeUndefined();

    const legacy: ChatWorkspaceBackfillRecord = { balance: "balance_1" };
    expect(chatWorkspaceBackfillPatch(legacy, "workspace_new")).toEqual({
      workspace: "workspace_new",
      scope: "personal",
    });
  });

  test("blocks cross-owner legacy chat edges", () => {
    expect(
      isLegacyChatOwnershipConsistent({
        chatUserId: "alice",
        balanceOwnerId: "alice",
        workspaceOwnerId: "alice",
        balanceId: "balance_1",
        workspaceLegacyBalance: "balance_1",
      }),
    ).toBe(true);
    expect(
      isLegacyChatOwnershipConsistent({
        chatUserId: "alice",
        balanceOwnerId: "bob",
        balanceId: "balance_1",
        workspaceLegacyBalance: "balance_1",
      }),
    ).toBe(false);
    expect(
      isLegacyChatOwnershipConsistent({
        chatUserId: "alice",
        workspaceOwnerId: "bob",
        balanceId: "balance_1",
        workspaceLegacyBalance: "balance_1",
      }),
    ).toBe(false);
    expect(
      isLegacyChatOwnershipConsistent({
        chatUserId: "alice",
        balanceOwnerId: "alice",
        balanceId: "balance_1",
        workspaceLegacyBalance: "balance_2",
      }),
    ).toBe(false);
  });

  test("only unavailable secrets require migration repair", () => {
    expect(secretFailureNeedsRepair("not_found")).toBe(false);
    expect(secretFailureNeedsRepair("expired")).toBe(true);
    expect(secretFailureNeedsRepair("key_unavailable")).toBe(true);
    expect(OWNERSHIP_MIGRATION_REMEDIATION).toContain("Repair or quarantine");
  });

  test("propagates revocations without clearing a target revocation", () => {
    expect(migratedRevocationPatch(123, undefined)).toEqual({ revokedAt: 123 });
    expect(migratedRevocationPatch(undefined, undefined)).toEqual({});
    expect(migratedRevocationPatch(123, 456)).toEqual({});
  });
});
