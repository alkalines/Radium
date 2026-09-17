import { describe, expect, test } from "bun:test";

import {
  canAccessChat,
  canAccessLegacyChat,
  canAccessResolvedChat,
  canAccessWorkspace,
  type WorkspaceMember,
} from "./policy";

const workspace = {
  ownerType: "user" as const,
  ownerId: "alice",
  legacyBalance: "balance_1",
};

const member: WorkspaceMember = { userId: "bob", role: "member" };

describe("workspace access policy", () => {
  test("allows the owner and explicit members, but not outsiders or archived users", () => {
    expect(canAccessWorkspace(workspace, "alice")).toBe(true);
    expect(canAccessWorkspace(workspace, "bob", [member])).toBe(true);
    expect(canAccessWorkspace(workspace, "carol", [member])).toBe(false);
    expect(canAccessWorkspace({ ...workspace, archivedAt: Date.now() }, "alice")).toBe(false);
    expect(canAccessWorkspace({ ...workspace, archivedAt: Date.now() }, "bob", [member])).toBe(
      false,
    );
  });

  test("keeps personal chats private while sharing workspace chats with members", () => {
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
        { userId: "alice", workspaceId: "workspace_1", scope: "personal" },
        workspace,
        "workspace_1",
        "bob",
        [member],
      ),
    ).toBe(false);
    expect(
      canAccessChat(
        { userId: "bob", workspaceId: "workspace_1", scope: "personal" },
        workspace,
        "workspace_1",
        "bob",
        [member],
      ),
    ).toBe(true);
    expect(
      canAccessChat(
        { userId: "alice", workspaceId: "workspace_1", scope: "workspace" },
        workspace,
        "workspace_1",
        "bob",
        [member],
      ),
    ).toBe(true);
    expect(
      canAccessChat(
        { userId: "alice", workspaceId: "workspace_1", scope: "workspace" },
        workspace,
        "workspace_1",
        "carol",
        [member],
      ),
    ).toBe(false);
    expect(
      canAccessChat(
        { userId: "alice", workspaceId: "workspace_1", scope: "workspace" },
        { ...workspace, archivedAt: Date.now() },
        "workspace_1",
        "alice",
      ),
    ).toBe(false);
  });

  test("keeps legacy chats private to the mapped workspace owner", () => {
    const legacyChat = { userId: "alice", balanceId: "balance_1" };
    expect(canAccessLegacyChat(legacyChat, workspace, "alice")).toBe(true);
    expect(canAccessLegacyChat(legacyChat, workspace, "bob")).toBe(false);
    expect(canAccessLegacyChat({ ...legacyChat, userId: "bob" }, workspace, "bob")).toBe(false);
    expect(canAccessLegacyChat({ ...legacyChat, balanceId: "balance_2" }, workspace, "alice")).toBe(
      false,
    );
    expect(canAccessLegacyChat(legacyChat, { ...workspace, archivedAt: Date.now() }, "alice")).toBe(
      false,
    );
  });

  test("rejects forged workspace and balance pointers", () => {
    const sharedMigratedChat = {
      userId: "alice",
      workspaceId: "workspace_1",
      balanceId: "balance_1",
      scope: "workspace" as const,
    };
    expect(
      canAccessResolvedChat(sharedMigratedChat, workspace, "workspace_1", "bob", [member]),
    ).toBe(true);
    expect(
      canAccessResolvedChat(sharedMigratedChat, workspace, "workspace_1", "carol", [member]),
    ).toBe(false);
    expect(
      canAccessResolvedChat(
        { ...sharedMigratedChat, balanceId: "balance_2" },
        workspace,
        "workspace_1",
        "bob",
        [member],
      ),
    ).toBe(false);
    expect(
      canAccessResolvedChat(
        { ...sharedMigratedChat, userId: "bob" },
        workspace,
        "workspace_1",
        "bob",
        [member],
      ),
    ).toBe(false);
    expect(
      canAccessResolvedChat(
        { userId: "alice", balanceId: "balance_1", scope: "personal" },
        workspace,
        "workspace_1",
        "alice",
      ),
    ).toBe(true);
    expect(
      canAccessResolvedChat(
        { userId: "alice", balanceId: "balance_2", scope: "personal" },
        workspace,
        "workspace_1",
        "alice",
      ),
    ).toBe(false);
  });
});
