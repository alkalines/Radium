import type { FileUIPart, UIMessage } from "ai";
import type { Id } from "backend/convex/_generated/dataModel";
import { fromBase64Url } from "radium-crypto";
import {
  parseFileFragment,
  uploadEncryptedFile,
  type ChatContentKey,
  type ChatQueue,
  type MessageEntry,
} from "./chat-content";
import { ensureChatKeys, prepareCustodyRelease } from "./chat-keys";
import { CustodialContentError, openLegacyContent } from "./legacy-content";
import type { SealedLegacyBox } from "./legacy-content";
import { onSecretsCleared } from "./runtime";
import { trpcClient } from "@/lib/trpc-client";

/** Historical content must be read through the sidecars; nothing here ever shows it as live data. */

/** The chat cannot be continued natively until a reader with unlocked keys can create its keys. */
export class ChatKeysRequiredError extends Error {
  constructor() {
    super(
      "Historical content in this chat must be encrypted before it can continue. " +
        "Unlock your encryption keys and try again; every member of the chat needs encryption " +
        "keys, and a workspace chat needs workspace keys.",
    );
    this.name = "ChatKeysRequiredError";
  }
}

/**
 * Gives a keyless chat its keys before any write, so new content is native and never plaintext.
 * Resolves once the chat has keys; throws `ChatKeysRequiredError` when key setup is unavailable
 * (locked, a chat member without encryption keys, or the workspace has no keys yet) instead of
 * falling back.
 */
export async function requireChatKeys(chatId: string): Promise<void> {
  if (!(await ensureChatKeys(chatId))) throw new ChatKeysRequiredError();
}

/**
 * Runs a historical read; when it meets custody, first gives the chat a key the custody can be
 * released to (`prepareCustodyRelease`), so reading is enough to start the release. The read still
 * rejects with `CustodialContentError`: the release runs on the server and the content appears
 * once it is resealed.
 */
async function readReleasingCustody<T>(chatId: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CustodialContentError) await prepareCustodyRelease(chatId);
    throw error;
  }
}

/** A message row as `GetChatMessages` returns it; `recordId` exists only with a sidecar. */
export type HistoricalEntry = MessageEntry & { recordId?: string; legacyContent?: SealedLegacyBox };

export type OpenedHistoricalChat = {
  /** Entries ready for `openMessages`: sealed rows untouched, historical rows opened in place. */
  entries: MessageEntry[];
  title?: { title: string; emoji?: string };
  queue?: ChatQueue;
  /** Error text of a historical failed request; new failures never store any. */
  interruptionMessage?: string;
};

type ChatSidecar = {
  messages?: unknown;
  messages_queue?: unknown;
  title?: unknown;
  emoji?: unknown;
  interruptionMessage?: unknown;
};

function isQueue(value: unknown): value is ChatQueue {
  return (
    !!value &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string" &&
    "model" in value &&
    typeof value.model === "string" &&
    "files" in value &&
    Array.isArray(value.files)
  );
}

/** The chat whose history is read and which sidecar fields the caller needs. */
export type HistoricalChatInput = {
  chatId: string;
  workspaceId: string;
  legacyContent?: SealedLegacyBox | null;
  /** `interruption`: restore a failed request's error text that moved into the sidecar. */
  wants: { title: boolean; queue: boolean; interruption?: boolean };
};

/**
 * Opens a chat's historical plaintext: embedded history, the queued first prompt, title and
 * emoji from the chat sidecar, and each message row's own sidecar. Native sealed rows keep their
 * envelopes, message IDs and revisions; a row holding both a native envelope and a sidecar is
 * read from the native envelope. `wants` names the sidecar fields the caller would otherwise
 * lack (no sealed title / sealed or consumed queue), so an unneeded sidecar is never opened.
 * Rejects with `CustodialContentError` while content is still in server custody, after giving the
 * chat a key that custody can be released to when this reader may (`readReleasingCustody`).
 */
export async function openHistoricalChat(
  chat: HistoricalChatInput,
  entries: readonly HistoricalEntry[],
): Promise<OpenedHistoricalChat> {
  return readReleasingCustody(chat.chatId, () => openHistoricalContent(chat, entries));
}

async function openHistoricalContent(
  chat: HistoricalChatInput,
  entries: readonly HistoricalEntry[],
): Promise<OpenedHistoricalChat> {
  // Embedded history exists only for chats whose rows were never created.
  const embedded = entries.length === 0;
  const sidecar =
    chat.legacyContent &&
    (embedded || chat.wants.title || chat.wants.queue || chat.wants.interruption)
      ? await openLegacyContent<ChatSidecar>(chat.legacyContent, {
          table: "aisdk_chats",
          record: chat.chatId,
          workspace: chat.workspaceId,
          chatId: chat.chatId,
        })
      : undefined;

  let opened: MessageEntry[];
  if (embedded && sidecar?.messages !== undefined) {
    if (!Array.isArray(sidecar.messages)) throw new Error("Invalid historical messages");
    opened = sidecar.messages.map((message: { id?: string }, position) => ({
      position,
      message,
      ...(typeof message?.id === "string" ? { messageId: message.id } : {}),
    }));
  } else {
    opened = await Promise.all(
      entries.map(async ({ recordId, legacyContent, ...entry }): Promise<MessageEntry> => {
        if (entry.sealed || !legacyContent) return entry;
        if (!recordId) throw new Error("Missing historical message identity");
        const row = await openLegacyContent<{ message?: unknown }>(legacyContent, {
          table: "chat_messages",
          record: recordId,
          workspace: chat.workspaceId,
          chatId: chat.chatId,
        });
        if (row.message === undefined) throw new Error("Invalid historical message");
        return { ...entry, message: row.message };
      }),
    );
  }

  let queue: ChatQueue | undefined;
  if (chat.wants.queue && sidecar?.messages_queue != null) {
    if (!isQueue(sidecar.messages_queue)) throw new Error("Invalid historical queued prompt");
    queue = sidecar.messages_queue;
  }
  let title: OpenedHistoricalChat["title"];
  if (chat.wants.title && typeof sidecar?.title === "string") {
    title = {
      title: sidecar.title,
      ...(typeof sidecar.emoji === "string" ? { emoji: sidecar.emoji } : {}),
    };
  }
  const interruptionMessage =
    chat.wants.interruption && typeof sidecar?.interruptionMessage === "string"
      ? sidecar.interruptionMessage
      : undefined;
  return {
    entries: opened,
    ...(title ? { title } : {}),
    ...(queue ? { queue } : {}),
    ...(interruptionMessage ? { interruptionMessage } : {}),
  };
}

/** A historical attachment's content, restored from its sidecar. */
export type HistoricalFile = { blob: Blob; filename?: string; mediaType: string };

/**
 * Restores an attachment whose plaintext blob moved into a sidecar, found by its old storage URL.
 * Null: the URL is not a historical attachment of this chat. The old URL is only a mapping key
 * and is never fetched.
 */
export async function openHistoricalFile(
  chatId: string,
  workspaceId: string,
  url: string,
): Promise<HistoricalFile | null> {
  const row = await trpcClient().chatFiles.historicalFile.query({ chatId, url });
  if (!row) return null;
  const file = await readReleasingCustody(chatId, () =>
    openLegacyContent<{
      filename?: string | null;
      mediaType?: unknown;
      size?: unknown;
      fileBytes?: unknown;
    }>(row.legacyContent, {
      table: "chat_files",
      record: row.recordId,
      workspace: workspaceId,
      chatId,
    }),
  );
  if (typeof file.fileBytes !== "string" || typeof file.mediaType !== "string") {
    throw new Error("Invalid historical attachment");
  }
  const bytes = fromBase64Url(file.fileBytes);
  if (bytes.byteLength !== file.size) throw new Error("Historical attachment is incomplete");
  return {
    blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mediaType }),
    ...(file.filename ? { filename: file.filename } : {}),
    mediaType: file.mediaType,
  };
}

/** Destination of a re-encrypted attachment: the chat (or fork) that will reference it. */
export type ReencryptTarget = {
  /** Chat whose historical files are read. */
  chatId: string;
  workspaceId: string;
  /** Key of the chat that will reference the new upload; absent when it cannot be encrypted. */
  key?: ChatContentKey;
};

// Re-uploads are keyed by destination chat and old URL, so repeated sends reuse one native copy.
// Entries hold object keys inside their URLs: memory only, cleared with every other secret.
// A "not historical" answer expires, since a plaintext file can be migrated while a Tab stays open.
const NOT_HISTORICAL_TTL_MS = 30_000;
const reuploads = new Map<string, { part: Promise<FileUIPart | null>; at: number }>();
onSecretsCleared(() => reuploads.clear());

async function reencryptHistorical(
  part: FileUIPart,
  target: ReencryptTarget,
): Promise<FileUIPart | null> {
  const historical = await openHistoricalFile(target.chatId, target.workspaceId, part.url);
  if (!historical) return null;
  // Without a key the attachment could neither be forked nor sent; fail instead of dropping it.
  if (!target.key) throw new ChatKeysRequiredError();
  const file = new File([historical.blob], historical.filename ?? part.filename ?? "attachment", {
    type: historical.mediaType,
  });
  const client = trpcClient();
  return uploadEncryptedFile(file, target.key, {
    createUpload: () => client.chatFiles.createUpload.mutate({ workspace: target.workspaceId }),
    register: (args) =>
      client.chatFiles.register.mutate({ workspace: target.workspaceId, ...args }),
  });
}

/**
 * Returns a native encrypted attachment for a historical one (the old part otherwise), uploaded
 * under `target.key` before any inference, send or fork that would reuse it. Native, inline and
 * external URLs pass through unchanged.
 */
export async function reencryptFilePart(
  part: FileUIPart,
  target: ReencryptTarget,
): Promise<FileUIPart> {
  if (!/^https?:\/\//.test(part.url) || parseFileFragment(part.url)) return part;
  const cacheKey = `${target.chatId}\0${target.key?.e2eeId ?? ""}\0${part.url}`;
  let entry = reuploads.get(cacheKey);
  if (entry && Date.now() - entry.at > NOT_HISTORICAL_TTL_MS && (await entry.part) === null) {
    entry = undefined;
  }
  if (!entry) {
    const created = { part: reencryptHistorical(part, target), at: Date.now() };
    entry = created;
    reuploads.set(cacheKey, created);
    created.part.catch(() => {
      if (reuploads.get(cacheKey) === created) reuploads.delete(cacheKey);
    });
  }
  return (await entry.part) ?? part;
}

/**
 * Re-encrypts every historical attachment of `messages`. `changed` lists the messages that now
 * point at a new upload; the caller must drop their saved revision so the new URL is rewritten
 * even though the message ID is unchanged.
 */
export async function reencryptMessageFiles(
  messages: UIMessage[],
  target: ReencryptTarget,
): Promise<{ messages: UIMessage[]; changed: Set<string> }> {
  const changed = new Set<string>();
  const next = await Promise.all(
    messages.map(async (message) => {
      const parts = await Promise.all(
        message.parts.map((part) =>
          part.type === "file" ? reencryptFilePart(part, target) : part,
        ),
      );
      if (parts.every((part, index) => part === message.parts[index])) return message;
      changed.add(message.id);
      return { ...message, parts };
    }),
  );
  return { messages: next, changed };
}
