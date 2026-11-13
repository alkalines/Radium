import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { invalidKeys } from "../e2ee/workspace-contract";

/** Reads the bounded explicitly shared recipient list, excluding the creator. */
export async function chatMemberIds(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"aisdk_chats">,
): Promise<string[]> {
  const rows = await ctx.db
    .query("chat_members")
    .withIndex("by_chat_and_userId", (q) => q.eq("chat", chatId))
    .take(201);
  if (rows.length > 200) {
    invalidKeys();
  }
  return rows.map((row) => row.userId);
}
/** Checks explicit chat visibility; callers must additionally authorize the workspace. */
export async function isChatMember(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"aisdk_chats">,
  userId: string,
): Promise<boolean> {
  return !!(await ctx.db
    .query("chat_members")
    .withIndex("by_chat_and_userId", (q) => q.eq("chat", chatId).eq("userId", userId))
    .first());
}
/** Replaces a shared chat's recipients atomically, allowing only current workspace members. */
export async function setChatMembers(
  ctx: MutationCtx,
  chat: Doc<"aisdk_chats">,
  userIds: string[],
): Promise<void> {
  if (
    !chat.workspace ||
    userIds.length > 200 ||
    new Set(userIds).size !== userIds.length ||
    userIds.includes(chat.userId)
  ) {
    invalidKeys();
  }
  const workspace = await ctx.db.get("workspaces", chat.workspace);
  if (!workspace || workspace.archivedAt !== undefined) {
    invalidKeys();
  }
  for (const userId of userIds) {
    if (workspace.ownerId === userId) {
      continue;
    }
    const member = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_userId", (q) =>
        q.eq("workspace", workspace._id).eq("userId", userId),
      )
      .first();
    if (!member) {
      invalidKeys();
    }
  }
  const existing = await ctx.db
    .query("chat_members")
    .withIndex("by_chat_and_userId", (q) => q.eq("chat", chat._id))
    .take(201);
  if (existing.length > 200) {
    invalidKeys();
  }
  for (const row of existing) {
    if (!userIds.includes(row.userId)) {
      await ctx.db.delete("chat_members", row._id);
    }
  }
  for (const userId of userIds) {
    if (!existing.some((row) => row.userId === userId)) {
      await ctx.db.insert("chat_members", {
        chat: chat._id,
        workspace: workspace._id,
        userId,
        lastInteractionAt: chat.lastInteractionAt ?? chat._creationTime,
      });
    }
  }
}
/** Mirrors Home ordering whenever the chat's interaction timestamp changes. */
export async function touchChatMembers(
  ctx: MutationCtx,
  chatId: Id<"aisdk_chats">,
  at: number,
): Promise<void> {
  const rows = await ctx.db
    .query("chat_members")
    .withIndex("by_chat_and_userId", (q) => q.eq("chat", chatId))
    .take(201);
  if (rows.length > 200) {
    invalidKeys();
  }
  for (const row of rows) {
    await ctx.db.patch("chat_members", row._id, { lastInteractionAt: at });
  }
}
