export type WorkspaceOwner = {
  ownerType: "user";
  ownerId: string;
  archivedAt?: number;
  legacyBalance?: string;
};

export type ChatScope = "personal" | "workspace";

export type ChatOwnership = {
  userId: string;
  workspaceId?: string;
  scope?: ChatScope;
};

export type LegacyChatOwnership = {
  userId: string;
  workspaceId?: string;
  balanceId?: string;
};

export type ResolvedChatOwnership = ChatOwnership & {
  balanceId?: string;
};

/**
 * The first ownership implementation deliberately supports personal workspaces
 * only. Organization membership must be added here before it is accepted by any
 * Convex function; Better Auth organization records are not workspace access.
 */
export function canAccessWorkspace(workspace: WorkspaceOwner, userId: string): boolean {
  return (
    workspace.ownerType === "user" &&
    workspace.ownerId === userId &&
    workspace.archivedAt === undefined
  );
}

/**
 * Personal chats remain private to their creator. Workspace chats are shared
 * with the workspace audience, which currently contains only its personal owner.
 * A future organization membership policy belongs in this branch.
 */
export function canAccessChat(
  chat: ChatOwnership,
  workspace: WorkspaceOwner,
  workspaceId: string,
  userId: string,
): boolean {
  if (!canAccessWorkspace(workspace, userId) || chat.workspaceId !== workspaceId) {
    return false;
  }

  return chat.scope === "workspace" || chat.userId === userId;
}

/** Legacy chats require both the mapped balance and the authenticated owner. */
export function canAccessLegacyChat(
  chat: LegacyChatOwnership,
  workspace: WorkspaceOwner,
  userId: string,
): boolean {
  return (
    canAccessWorkspace(workspace, userId) &&
    chat.userId === userId &&
    chat.workspaceId === undefined &&
    chat.balanceId !== undefined &&
    chat.balanceId === workspace.legacyBalance
  );
}

/** Apply the authenticated workspace policy to either new or legacy chat data. */
export function canAccessResolvedChat(
  chat: ResolvedChatOwnership,
  workspace: WorkspaceOwner | null,
  workspaceId: string,
  userId: string,
): boolean {
  if (!workspace) return false;

  return (
    canAccessChat(chat, workspace, workspaceId, userId) ||
    canAccessLegacyChat(
      {
        userId: chat.userId,
        workspaceId: chat.workspaceId,
        balanceId: chat.balanceId,
      },
      workspace,
      userId,
    )
  );
}

/** Legacy chats were user-owned before an explicit scope existed. */
export function chatScopeOrPersonal(scope: ChatScope | undefined): ChatScope {
  return scope ?? "personal";
}

/** Every new completion must be attributable to user-supplied upstream access. */
export function isByokRequest(byok: boolean): byok is true {
  return byok === true;
}
