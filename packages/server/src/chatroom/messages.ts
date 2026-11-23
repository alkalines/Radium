import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { toBase64Url } from "radium-crypto";
import type { Config } from "../config";
import type { Database } from "../drivers/types";
import { e2eeCapsules } from "../e2ee/schema";
import type { Chat } from "./access";
import { linkChatFiles } from "./files";
import { chatMessages, chats } from "./schema";
import {
  invalidSealedContent,
  validateChatCapsule,
  validateMessageEnvelope,
  type SealedWrites,
} from "./sealing";

/**
 * Chat history, one message per `chat_messages` row ordered by `position`. Keyed chats store
 * sealed envelopes the server cannot read; imported rows may carry plaintext (`message`) or a
 * historical sidecar (`legacy_content`). Every read authorizes the chat first.
 */

/** A chat's full history and capsules, as a Session Tab opens it. */
export async function readChatHistory(db: Database, chatId: string) {
  const [rows, capsules] = await Promise.all([
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chat, chatId))
      .orderBy(asc(chatMessages.position)),
    db
      .select({
        capsuleId: e2eeCapsules.capsuleId,
        chatEpoch: e2eeCapsules.chatEpoch,
        capsule: e2eeCapsules.capsule,
      })
      .from(e2eeCapsules)
      .where(eq(e2eeCapsules.chat, chatId))
      .orderBy(asc(e2eeCapsules.createdAt), asc(e2eeCapsules.id)),
  ]);
  return {
    entries: rows.map((row) => ({
      position: row.position,
      messageId: row.messageId,
      revision: row.revision,
      message: row.message,
      sealed:
        row.sealedCapsuleId !== null && row.sealedEnvelope !== null
          ? { capsuleId: row.sealedCapsuleId, envelope: toBase64Url(row.sealedEnvelope) }
          : null,
      // The sidecar's AAD record; plain rows never need to reveal their row id.
      ...(row.legacyContent ? { recordId: row.id, legacyContent: row.legacyContent } : {}),
    })),
    capsules: capsules.map((capsule) => ({ ...capsule, capsule: toBase64Url(capsule.capsule) })),
  };
}

/** Stored positions with their message ids and revisions only; never message content. */
export async function chatMessageHeads(db: Database, chatId: string) {
  return await db
    .select({
      position: chatMessages.position,
      messageId: chatMessages.messageId,
      revision: chatMessages.revision,
    })
    .from(chatMessages)
    .where(eq(chatMessages.chat, chatId))
    .orderBy(asc(chatMessages.position));
}

/**
 * Saves one sealed write batch (a turn's changed positions) in one transaction holding the chat
 * row lock: concurrent saves of one chat serialize there, so the revision check below sees the
 * other save's rows and refuses a stale snapshot instead of overwriting it. Each written position
 * must be the next revision of its stored row; `length` truncates the history. `after` runs in the
 * same transaction once the batch is stored (the run's end).
 */
export async function saveSealedChatMessages(
  db: Database,
  config: Config,
  chatId: string,
  writes: SealedWrites,
  after?: (tx: Database) => Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [chat] = await tx.select().from(chats).where(eq(chats.id, chatId)).for("update");
    if (!chat) invalidSealedContent();
    await applySealedWrites(tx, config, chat, writes);
    await after?.(tx);
  });
}

async function applySealedWrites(tx: Database, config: Config, chat: Chat, writes: SealedWrites) {
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
  const rows = await tx
    .select({
      id: chatMessages.id,
      position: chatMessages.position,
      revision: chatMessages.revision,
      legacyContent: chatMessages.legacyContent,
    })
    .from(chatMessages)
    .where(eq(chatMessages.chat, chat.id));
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
      // A stale snapshot is refused rather than overwriting a concurrent turn's revision.
      invalidSealedContent();
    }
    validateMessageEnvelope(write.envelope, writes.capsule.capsuleId);
    positions.add(write.position);
    messageIds.add(write.messageId);
  }
  // A row whose history is still in custody cannot be replaced or truncated.
  for (const row of rows) {
    const replaced = positions.has(row.position) || row.position >= writes.length;
    if (row.legacyContent?.kind === "custody" && replaced) invalidSealedContent();
  }
  for (let position = 0; position < writes.length; position++) {
    if (!positions.has(position) && !existing.has(position)) invalidSealedContent();
  }
  const [capsule] = await tx
    .insert(e2eeCapsules)
    .values({
      chat: chat.id,
      capsuleId: writes.capsule.capsuleId,
      chatEpoch: writes.capsule.chatEpoch,
      capsule: writes.capsule.capsule,
    })
    .onConflictDoNothing({ target: [e2eeCapsules.chat, e2eeCapsules.capsuleId] })
    .returning({ id: e2eeCapsules.id });
  if (!capsule) invalidSealedContent();

  if (writes.length < rows.length) {
    await tx
      .delete(chatMessages)
      .where(and(eq(chatMessages.chat, chat.id), gte(chatMessages.position, writes.length)));
  }
  const replacedIds = writes.rows.flatMap((write) => {
    const row = existing.get(write.position);
    return row ? [row.id] : [];
  });
  if (replacedIds.length > 0) {
    // Rewritten positions are replaced whole: the native envelope supersedes any plaintext or
    // sidecar the row carried.
    await tx.delete(chatMessages).where(inArray(chatMessages.id, replacedIds));
  }
  if (writes.rows.length > 0) {
    await tx.insert(chatMessages).values(
      writes.rows.map((write) => ({
        chat: chat.id,
        position: write.position,
        messageId: write.messageId,
        revision: write.revision,
        sealedCapsuleId: writes.capsule.capsuleId,
        sealedEnvelope: write.envelope,
      })),
    );
  }
  await linkChatFiles(tx, config, chat.workspace, chat.id, writes.fileUrls, { sealed: true });
}
