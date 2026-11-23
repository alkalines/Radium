import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { invalidKeys } from "../e2ee/workspace-keys";
import { workspaceMembers } from "../workspaces/schema";
import type { Chat, ChatWorkspace } from "./access";
import { chatMembers } from "./schema";

/** Explicit recipients a shared chat may have besides its creator. */
export const MAX_CHAT_MEMBERS = 200;

/** The shared chat's explicit recipients (creator excluded); more than the bound is invalid. */
export async function chatMemberIds(db: Database, chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chat, chatId))
    .limit(MAX_CHAT_MEMBERS + 1);
  if (rows.length > MAX_CHAT_MEMBERS) invalidKeys();
  return rows.map((row) => row.userId);
}

/**
 * Replaces a shared chat's recipients in the caller's transaction, allowing only current users of
 * the chat's (active) workspace and never the creator. `chat` carries the scope being written.
 */
export async function setChatMembers(
  tx: Database,
  chat: Pick<Chat, "id" | "userId" | "lastInteractionAt">,
  workspace: ChatWorkspace,
  userIds: string[],
): Promise<void> {
  if (
    workspace.archivedAt !== null ||
    userIds.length > MAX_CHAT_MEMBERS ||
    new Set(userIds).size !== userIds.length ||
    userIds.includes(chat.userId)
  ) {
    invalidKeys();
  }
  const others = userIds.filter((userId) => userId !== workspace.ownerId);
  if (others.length > 0) {
    const members = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspace, workspace.id), inArray(workspaceMembers.userId, others)),
      );
    if (members.length !== others.length) invalidKeys();
  }
  await tx
    .delete(chatMembers)
    .where(
      userIds.length > 0
        ? and(eq(chatMembers.chat, chat.id), notInArray(chatMembers.userId, userIds))
        : eq(chatMembers.chat, chat.id),
    );
  if (userIds.length > 0) {
    await tx
      .insert(chatMembers)
      .values(
        userIds.map((userId) => ({
          chat: chat.id,
          workspace: workspace.id,
          userId,
          lastInteractionAt: chat.lastInteractionAt,
        })),
      )
      .onConflictDoNothing({ target: [chatMembers.chat, chatMembers.userId] });
  }
}

/** Mirrors Home ordering onto the members whenever the chat's interaction time changes. */
export async function touchChatMembers(tx: Database, chatId: string, at: Date): Promise<void> {
  await tx.update(chatMembers).set({ lastInteractionAt: at }).where(eq(chatMembers.chat, chatId));
}
