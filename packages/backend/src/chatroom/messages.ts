import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { messageSchema } from "../../convex/aisdk_schemas";
import { canonicalJson } from "../telemetry/canonical";
import { deleteChatFileBatch, linkChatFiles, storedFileUrls } from "./files";

/**
 * Chat history is stored one message per `chat_messages` row so chat documents stay small:
 * chat lists, authorization checks, and metadata subscriptions read only the chat document,
 * while the full history is read only by the open session's content query and by saves.
 *
 * Rows carry no access data. Callers MUST authorize the parent chat (`requireAccessibleChat`,
 * `authorizeChatRecord`) before reading or writing its messages.
 *
 * Chats created before the split keep their history in the deprecated `aisdk_chats.messages`
 * until `migrations.chatMessagesToTable` (or their next save) moves it; a chat whose `messages`
 * field is still set has no rows yet.
 */

export type StoredMessage = Infer<typeof messageSchema>;

const DELETE_BATCH_SIZE = 128;

/** A chat's ordered history; unmigrated chats fall back to their embedded array. */
export async function loadChatMessages(
  ctx: QueryCtx,
  chat: Doc<"aisdk_chats">,
): Promise<StoredMessage[]> {
  if (chat.messages !== undefined) return chat.messages;

  // Bounded only by the chat itself: the client sends the full history with every request, so
  // the open session needs all of it.
  const rows = await ctx.db
    .query("chat_messages")
    .withIndex("by_chat_and_position", (q) => q.eq("chat", chat._id))
    .collect();
  return rows.map((row) => row.message);
}

/** First user message, for title generation, without reading the rest of the history. */
export async function loadFirstUserMessage(
  ctx: QueryCtx,
  chat: Doc<"aisdk_chats">,
): Promise<StoredMessage | undefined> {
  if (chat.messages !== undefined) {
    return chat.messages.find((message) => message.role === "user");
  }

  // The first user turn is almost always position 0 or 1; scan in order without collecting.
  for await (const row of ctx.db
    .query("chat_messages")
    .withIndex("by_chat_and_position", (q) => q.eq("chat", chat._id))) {
    if (row.message.role === "user") return row.message;
  }
  return undefined;
}

/**
 * Replace a chat's history with `messages`, writing only positions whose content changed and
 * deleting positions past the new end (a revert or regenerate shortens history). Files mentioned
 * by written messages are linked to the chat. Also moves an unmigrated chat's embedded history
 * out: the caller MUST clear `messages` and `chat_completions` on the chat in the same mutation.
 */
export async function saveChatMessages(
  ctx: MutationCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Id<"workspaces">,
  messages: StoredMessage[],
) {
  const rows = await ctx.db
    .query("chat_messages")
    .withIndex("by_chat_and_position", (q) => q.eq("chat", chat._id))
    .collect();

  const written: StoredMessage[] = [];
  for (const [position, message] of messages.entries()) {
    const row = rows[position];
    if (!row) {
      await ctx.db.insert("chat_messages", { chat: chat._id, position, message });
      written.push(message);
    } else if (!isSameMessage(row.message, message)) {
      await ctx.db.patch("chat_messages", row._id, { message });
      written.push(message);
    }
  }
  for (const row of rows.slice(messages.length)) {
    await ctx.db.delete("chat_messages", row._id);
  }

  await linkChatFiles(ctx, workspace, chat._id, storedFileUrls(written));
}

/** Seed a new chat's history (a fork) and link the files it mentions. */
export async function insertChatMessages(
  ctx: MutationCtx,
  chat: Id<"aisdk_chats">,
  workspace: Id<"workspaces">,
  messages: StoredMessage[],
) {
  for (const [position, message] of messages.entries()) {
    await ctx.db.insert("chat_messages", { chat, position, message });
  }
  await linkChatFiles(ctx, workspace, chat, storedFileUrls(messages));
}

// Positions are rewritten only when content differs; key order and omitted `undefined` members
// must not count as a change, so compare canonical JSON. Values JSON cannot represent count as
// changed, which only costs a rewrite.
function isSameMessage(stored: StoredMessage, next: StoredMessage) {
  try {
    return canonicalJson(stored) === canonicalJson(next);
  } catch {
    return false;
  }
}

/**
 * Delete a deleted chat's messages and file references in batches, rescheduling itself until
 * none remain. Scheduled by `aisdk.DeleteChat` after the chat document is gone.
 */
export const cleanupChatContent = internalMutation({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("chat_messages")
      .withIndex("by_chat_and_position", (q) => q.eq("chat", args.chatId))
      .take(DELETE_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete("chat_messages", row._id);

    const moreFiles = await deleteChatFileBatch(ctx, args.chatId);
    if (rows.length === DELETE_BATCH_SIZE || moreFiles) {
      await ctx.scheduler.runAfter(0, internal.aisdk.cleanupChatContent, { chatId: args.chatId });
    }
    return null;
  },
});
