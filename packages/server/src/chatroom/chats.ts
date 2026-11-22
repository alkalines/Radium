import { and, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { chatMembers, chats } from "./schema";

/** Whether `workspace` holds any chat (workspace archive refuses then). */
export async function workspaceHasChats(db: Database, workspace: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.workspace, workspace))
    .limit(1);
  return row !== undefined;
}

/**
 * Detaches a user removed from `workspace` from its chats, in the caller's transaction: the chats
 * they were a member of and the `shared` chats they created are flagged `rekey` (a removed
 * creator is no longer an implicit recipient of new chat key epochs), then their `chat_members`
 * rows are deleted. The next writer of each flagged chat starts a new epoch.
 */
export async function detachWorkspaceMember(
  tx: Database,
  workspace: string,
  userId: string,
): Promise<void> {
  const membership = and(eq(chatMembers.workspace, workspace), eq(chatMembers.userId, userId));
  await tx
    .update(chats)
    .set({ rekey: true })
    .where(
      and(
        eq(chats.workspace, workspace),
        or(
          inArray(chats.id, tx.select({ chat: chatMembers.chat }).from(chatMembers).where(membership)),
          and(eq(chats.userId, userId), eq(chats.scope, "shared")),
        ),
      ),
    );
  await tx.delete(chatMembers).where(membership);
}
