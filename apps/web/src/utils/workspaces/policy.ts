export type WorkspaceOwner = {
  ownerType: "user";
  ownerId: string;
  archivedAt?: number;
  legacyBalance?: string;
};

export type WorkspaceMember = {
  userId: string;
  role: "member";
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
