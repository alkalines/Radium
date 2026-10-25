/** Workspace ownership plus the legacy balance pointer retained during migration. */
export type WorkspaceOwner = {
  ownerType: "user";
  ownerId: string;
  archivedAt?: number;
  legacyBalance?: string;
};

/** A direct workspace membership; organization membership is not represented here. */
export type WorkspaceMember = {
  userId: string;
  role: "member";
};

/** Personal chats are creator-private; workspace chats are shared with workspace access. */
export type ChatScope = "personal" | "workspace";

/**
 * Check management after the caller has authorized the chat's workspace and visibility.
 * Creators manage their own chats; workspace owners can also manage shared chats.
 * This predicate does not grant owners access to another user's personal chat.
 */
export function canManageChat(
  chat: { userId: string; scope?: ChatScope },
  workspace: Pick<WorkspaceOwner, "ownerId">,
  userId: string,
): boolean {
  return chat.userId === userId || (chat.scope === "workspace" && workspace.ownerId === userId);
}

/**
 * Project management (rename, appearance, delete) belongs to its creator and the workspace owner.
 * Any workspace member may read Projects; changing a Project's Worker folder is owner-only.
 */
export function canManageProject(
  project: { userId: string },
  workspace: Pick<WorkspaceOwner, "ownerId">,
  userId: string,
): boolean {
  return project.userId === userId || workspace.ownerId === userId;
}

/** Visibility and ownership fields for a chat with workspace routing metadata. */
export type ChatOwnership = {
  userId: string;
  workspaceId?: string;
  scope?: ChatScope;
};

/** Pre-workspace chat fields used while legacy balances are still mapped. */
export type LegacyChatOwnership = {
  userId: string;
  workspaceId?: string;
  balanceId?: string;
};

/** Chat ownership with the optional legacy pointer retained for consistency checks. */
export type ResolvedChatOwnership = ChatOwnership & {
  balanceId?: string;
};

/**
 * An active workspace is accessible to its owner or to an explicit member.
 * Better Auth organizations are intentionally not consulted here; organization
 * ownership and organization-derived membership are future policy extensions.
 */
export function canAccessWorkspace(
  workspace: WorkspaceOwner,
  userId: string,
  members: readonly WorkspaceMember[] = [],
): boolean {
  if (workspace.ownerType !== "user" || workspace.archivedAt !== undefined) return false;
  if (workspace.ownerId === userId) return true;
  return members.some((member) => member.role === "member" && member.userId === userId);
}

/**
 * Personal chats remain private to their creator. Workspace chats are visible
 * to the workspace owner and explicit members.
 */
export function canAccessChat(
  chat: ChatOwnership,
  workspace: WorkspaceOwner,
  workspaceId: string,
  userId: string,
  members: readonly WorkspaceMember[] = [],
): boolean {
  if (!canAccessWorkspace(workspace, userId, members) || chat.workspaceId !== workspaceId) {
    return false;
  }

  return chat.scope === "workspace" || chat.userId === userId;
}

/** Legacy chats require the mapped balance and the mapped workspace owner. */
export function canAccessLegacyChat(
  chat: LegacyChatOwnership,
  workspace: WorkspaceOwner,
  userId: string,
): boolean {
  return (
    canAccessWorkspace(workspace, userId) &&
    chat.userId === workspace.ownerId &&
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
  members: readonly WorkspaceMember[] = [],
): boolean {
  if (!workspace) return false;

  if (chat.workspaceId !== undefined) {
    // A retained legacy pointer is valid only when it names this workspace's
    // balance and the chat creator is that balance's owner.
    if (
      chat.balanceId !== undefined &&
      (chat.balanceId !== workspace.legacyBalance || chat.userId !== workspace.ownerId)
    ) {
      return false;
    }
    return canAccessChat(chat, workspace, workspaceId, userId, members);
  }

  return canAccessLegacyChat(chat, workspace, userId);
}

/** Legacy chats were user-owned before an explicit scope existed. */
export function chatScopeOrPersonal(scope: ChatScope | undefined): ChatScope {
  return scope ?? "personal";
}

/** Every new completion must be attributable to user-supplied upstream access. */
export function isByokRequest(byok: boolean): byok is true {
  return byok === true;
}

/** Unattributed historical Chatroom completions must not become Gateway usage. */
export function isGatewayCompletionWithoutChat(completion: {
  chatId?: string;
  userId?: string;
  bill: { apiKey?: string; key?: string };
}): boolean {
  return (
    completion.chatId === undefined &&
    completion.userId === undefined &&
    (completion.bill.apiKey !== undefined || completion.bill.key !== undefined)
  );
}

/** Only owner-attributed Gateway traces can omit chat visibility checks. */
export function isOwnerManagedGatewayTrace(
  trace: { chatId?: string; source: string; userId: string },
  ownerId: string,
): boolean {
  return trace.chatId === undefined && trace.source === "gateway" && trace.userId === ownerId;
}
