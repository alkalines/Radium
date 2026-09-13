import { describe, expect, test } from "bun:test";

import {
  canAccessChat,
  canAccessLegacyChat,
  canAccessResolvedChat,
  canAccessWorkspace,
} from "./policy";

const workspace = {
  ownerType: "user" as const,
  ownerId: "alice",
  legacyBalance: "balance_1",
};

describe("workspace ownership policy", () => {
  test("limits workspaces to their Better Auth owner", () => {
    expect(canAccessWorkspace(workspace, "alice")).toBe(true);
    expect(canAccessWorkspace(workspace, "bob")).toBe(false);
    expect(canAccessWorkspace({ ...workspace, archivedAt: Date.now() }, "alice")).toBe(false);
  });

  test("keeps personal chats private while allowing owned workspace chats", () => {
    expect(
      canAccessChat(
        { userId: "alice", workspaceId: "workspace_1", scope: "personal" },
        workspace,
        "workspace_1",
        "alice",
      ),
    ).toBe(true);
    expect(
      canAccessChat(
        { userId: "bob", workspaceId: "workspace_1", scope: "personal" },
        workspace,
        "workspace_1",
        "alice",
      ),
    ).toBe(false);
    expect(
      canAccessChat(
        { userId: "bob", workspaceId: "workspace_1", scope: "workspace" },
        workspace,
        "workspace_1",
        "alice",
      ),
    ).toBe(true);
    expect(
      canAccessChat(
        { userId: "alice", workspaceId: "workspace_2", scope: "personal" },
        workspace,
        "workspace_1",
        "alice",
      ),
    ).toBe(false);
  });

  test("does not let a legacy balance mapping bypass chat owner or workspace state", () => {
    const legacyChat = { userId: "alice", balanceId: "balance_1" };
    expect(canAccessLegacyChat(legacyChat, workspace, "alice")).toBe(true);
    expect(canAccessLegacyChat(legacyChat, workspace, "bob")).toBe(false);
    expect(canAccessLegacyChat(legacyChat, { ...workspace, archivedAt: Date.now() }, "alice")).toBe(
      false,
    );
    expect(canAccessLegacyChat({ ...legacyChat, balanceId: "balance_2" }, workspace, "alice")).toBe(
      false,
    );
    expect(
      canAccessLegacyChat({ ...legacyChat, workspaceId: "workspace_1" }, workspace, "alice"),
    ).toBe(false);
  });

  test("applies the same policy used by requireAccessibleChat", () => {
    const legacyChat = {
      userId: "alice",
      balanceId: "balance_1",
      scope: "personal" as const,
    };
    expect(canAccessResolvedChat(legacyChat, workspace, "workspace_1", "alice")).toBe(true);
    expect(canAccessResolvedChat(legacyChat, workspace, "workspace_1", "bob")).toBe(false);
    expect(
      canAccessResolvedChat(
        legacyChat,
        { ...workspace, archivedAt: Date.now() },
        "workspace_1",
        "alice",
      ),
    ).toBe(false);
  });
});
