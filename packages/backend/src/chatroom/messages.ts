import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { messageSchema } from "../../convex/aisdk_schemas";
import { canonicalJson } from "../telemetry/canonical";
import { deleteChatFileBatch, linkChatFiles, storedFileUrls } from "./files";
import {
  invalidSealedContent,
  validateChatCapsule,
  validateMessageEnvelope,
  validatePlaintextAttachments,
  type SealedWrites,
} from "./sealing";

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
  return rows.flatMap((row) => (row.message ? [row.message] : []));
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
    if (row.message?.role === "user") return row.message;
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
  for (const message of messages) {
    validatePlaintextAttachments(message.parts);
  }
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
    } else if (!row.message || !isSameMessage(row.message, message)) {
      await ctx.db.patch("chat_messages", row._id, { message, sealed: undefined });
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
    validatePlaintextAttachments(message.parts);
    await ctx.db.insert("chat_messages", { chat, position, message });
  }
  await linkChatFiles(ctx, workspace, chat, storedFileUrls(messages));
}

/** Apply an action-sealed batch atomically; revisions are checked against the current row heads. */
export async function saveSealedChatMessages(
  ctx: MutationCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Id<"workspaces">,
  writes: SealedWrites,
) {
  if (
    !chat.e2eeId ||
    chat.rekey ||
    writes.capsule.chatEpoch !== chat.keyEpoch ||
    !Number.isSafeInteger(writes.length) ||
    writes.length < 0
  ) {
    invalidSealedContent();
  }
  validateChatCapsule(writes.capsule);
  const rows = await ctx.db
    .query("chat_messages")
    .withIndex("by_chat_and_position", (q) => q.eq("chat", chat._id))
    .collect();
  const existing = new Map(rows.map((row) => [row.position, row]));
  const positions = new Set<number>();
  const messageIds = new Set<string>();
  for (const write of writes.rows) {
    if (
      !Number.isSafeInteger(write.position) ||
      write.position < 0 ||
      write.position >= writes.length ||
      positions.has(write.position) ||
      !write.messageId ||
      messageIds.has(write.messageId) ||
      write.revision !== (existing.get(write.position)?.revision ?? 0) + 1
    ) {
      // Reject stale action snapshots rather than overwriting a concurrent turn's revision.
      invalidSealedContent();
    }
    validateMessageEnvelope(write.envelope, writes.capsule.capsuleId);
    positions.add(write.position);
    messageIds.add(write.messageId);
  }
  for (let position = 0; position < writes.length; position++) {
    if (!positions.has(position) && !existing.has(position)) {
      invalidSealedContent();
    }
  }
  const capsule = await ctx.db
    .query("e2ee_capsules")
    .withIndex("by_chat_and_capsuleId", (q) =>
      q.eq("chat", chat._id).eq("capsuleId", writes.capsule.capsuleId),
    )
    .first();
  if (capsule) {
    invalidSealedContent();
  }
  await ctx.db.insert("e2ee_capsules", { chat: chat._id, ...writes.capsule });
  for (const write of writes.rows) {
    const value = {
      messageId: write.messageId,
      revision: write.revision,
      sealed: { capsuleId: writes.capsule.capsuleId, envelope: write.envelope },
    };
    const row = existing.get(write.position);
    if (row) {
      await ctx.db.patch("chat_messages", row._id, { ...value, message: undefined });
    } else {
      await ctx.db.insert("chat_messages", { chat: chat._id, position: write.position, ...value });
    }
  }
  for (const row of rows) {
    if (row.position >= writes.length) {
      await ctx.db.delete("chat_messages", row._id);
    }
  }
  await linkChatFiles(ctx, workspace, chat._id, writes.fileUrls, { sealed: true });
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
    let moreKeys = false;
    const batches = await Promise.all([
      ctx.db
        .query("e2ee_capsules")
        .withIndex("by_chat_and_capsuleId", (q) => q.eq("chat", args.chatId))
        .take(DELETE_BATCH_SIZE),
      ctx.db
        .query("e2ee_chat_keys")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", args.chatId))
        .take(DELETE_BATCH_SIZE),
      ctx.db
        .query("e2ee_chat_key_wraps")
        .withIndex("by_chat_and_chatEpoch_and_recipientKeyId", (q) => q.eq("chat", args.chatId))
        .take(DELETE_BATCH_SIZE),
      ctx.db
        .query("chat_members")
        .withIndex("by_chat_and_userId", (q) => q.eq("chat", args.chatId))
        .take(DELETE_BATCH_SIZE),
    ]);
    for (const batch of batches) {
      for (const row of batch) {
        await ctx.db.delete(row._id);
      }
      moreKeys ||= batch.length === DELETE_BATCH_SIZE;
    }
    if (rows.length === DELETE_BATCH_SIZE || moreFiles || moreKeys) {
      await ctx.scheduler.runAfter(0, internal.aisdk.cleanupChatContent, { chatId: args.chatId });
    }
    return null;
  },
});
