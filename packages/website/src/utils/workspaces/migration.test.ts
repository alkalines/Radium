import { describe, expect, test } from "bun:test";

import {
  OWNERSHIP_MIGRATION_STEPS,
  type ChatWorkspaceBackfillRecord,
  chatWorkspaceBackfillPatch,
  needsLegacyOwnershipBackfill,
} from "./migration";

describe("workspace ownership migration", () => {
  test("keeps migration steps ordered from owners to dependent records", () => {
    expect(OWNERSHIP_MIGRATION_STEPS).toEqual([
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
});
