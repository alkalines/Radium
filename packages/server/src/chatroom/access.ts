import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { chatMembers, chats } from "./schema";

export type Chat = typeof chats.$inferSelect;
export type ChatWorkspace = typeof workspaces.$inferSelect;

/**
 * A caller's authorized view of one chat. `role` is the caller's workspace role; `canManage` is
 * management (creator, or the workspace owner for `workspace`-scoped chats), evaluated only after
 * visibility, so ownership never grants access to a member's personal or shared chat.
 */
export type ChatAccess = {
  chat: Chat;
  workspace: ChatWorkspace;
  userId: string;
  role: "owner" | "member";
  canManage: boolean;
};

/** Row locks a write path may take on the chat row (never on the workspace). */
export type ChatLock = "update" | "no key update" | "share";

/**
 * The one Chatroom access function (`docs/Backend_Migration/Runtime.md`, tRPC conventions), used
 * by tRPC, `/api/chat`, files, completion and telemetry attribution, and later the stream and
 * shape proxies. In one query:
 *
 * - the workspace is active (not archived) and the user owns it or is a direct member;
 * - `personal`: the creator only, the workspace owner included in "only";
 * - `shared`: the creator and the chat's `chat_members`;
 * - `workspace`: every workspace user.
 *
 * A creator removed from the workspace loses their chats with it. Unknown, foreign, archived and
 * invisible chats all give `null`, so callers answer them alike.
 */
export async function chatAccess(
  db: Database,
  userId: string,
  chatId: string,
  lock?: ChatLock,
): Promise<ChatAccess | null> {
  let query = db
    .select({ chat: chats, workspace: workspaces, member: workspaceMembers.id, chatMember: chatMembers.id })
    .from(chats)
    .innerJoin(workspaces, and(eq(workspaces.id, chats.workspace), isNull(workspaces.archivedAt)))
    .leftJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspace, chats.workspace), eq(workspaceMembers.userId, userId)),
    )
    .leftJoin(chatMembers, and(eq(chatMembers.chat, chats.id), eq(chatMembers.userId, userId)))
    .where(eq(chats.id, chatId))
    .$dynamic();
  if (lock) {
    query = query.for(lock, { of: chats });
  }
  const [row] = await query;
  if (!row) return null;

  const { chat, workspace } = row;
  const role = workspace.ownerId === userId ? "owner" : row.member !== null ? "member" : null;
  if (!role) return null;
  if (!isChatVisible(chat, userId, row.chatMember !== null)) return null;
  return { chat, workspace, userId, role, canManage: canManageChat(chat, workspace, userId) };
}

/**
 * The visibility rule of {@link chatAccess} for a user of the chat's (active) workspace:
 * `workspace` scope, the creator, or a `chat_members` row of a `shared` chat.
 */
function isChatVisible(chat: Pick<Chat, "scope" | "userId">, userId: string, isMember: boolean) {
  return (
    chat.scope === "workspace" || chat.userId === userId || (chat.scope === "shared" && isMember)
  );
}

/**
 * {@link chatAccess} for many chats at once (usage and log reads): the chats of `chatIds` that
 * belong to `workspace` and that `userId` may see, by id. The caller has already authorized
 * `userId` in `workspace` (active, owner or member); this applies only the per-chat rule. One
 * query; unknown, foreign and invisible chats are absent alike.
 */
export async function visibleWorkspaceChats(
  db: Database,
  userId: string,
  workspace: string,
  chatIds: Iterable<string>,
): Promise<Map<string, Chat>> {
  const ids = [...new Set(chatIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ chat: chats, chatMember: chatMembers.id })
    .from(chats)
    .leftJoin(chatMembers, and(eq(chatMembers.chat, chats.id), eq(chatMembers.userId, userId)))
    .where(and(inArray(chats.id, ids), eq(chats.workspace, workspace)));
  return new Map(
    rows
      .filter((row) => isChatVisible(row.chat, userId, row.chatMember !== null))
      .map((row) => [row.chat.id, row.chat]),
  );
}

/**
 * Management after visibility: the creator, or the workspace owner for `workspace`-scoped chats.
 * Never consulted on its own: it does not grant access to another user's personal chat.
 */
export function canManageChat(
  chat: Pick<Chat, "userId" | "scope">,
  workspace: Pick<ChatWorkspace, "ownerId">,
  userId: string,
): boolean {
  return chat.userId === userId || (chat.scope === "workspace" && workspace.ownerId === userId);
}

/** {@link chatAccess}, refusing with `NOT_FOUND` like an unknown chat. */
export async function requireChatAccess(
  db: Database,
  userId: string,
  chatId: string,
  lock?: ChatLock,
): Promise<ChatAccess> {
  const access = await chatAccess(db, userId, chatId, lock);
  if (!access) throw new AppError("NOT_FOUND", "Chat not found.");
  return access;
}

/** {@link requireChatAccess} for managers only; others get the same `NOT_FOUND`. */
export async function requireChatManager(
  db: Database,
  userId: string,
  chatId: string,
  lock?: ChatLock,
): Promise<ChatAccess> {
  const access = await requireChatAccess(db, userId, chatId, lock);
  if (!access.canManage) throw new AppError("NOT_FOUND", "Chat not found.");
  return access;
}

/**
 * Whether `userId` may see chat `chatId` inside `workspace` (completion and telemetry
 * attribution): the access function, plus the chat belonging to exactly that workspace.
 */
export async function chatVisibleInWorkspace(
  db: Database,
  userId: string,
  chatId: string,
  workspace: string,
): Promise<boolean> {
  const access = await chatAccess(db, userId, chatId);
  return access !== null && access.workspace.id === workspace;
}
