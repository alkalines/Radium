import type { FileUIPart, UIMessage } from "ai";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  CryptoError,
  createCapsule,
  decodeCapsule,
  decodeEnvelope,
  deriveObjectKey,
  encodeCapsule,
  equalBytes,
  fromBase64Url,
  openBox,
  openCapsule,
  openSym,
  openWithCapsule,
  randomBytes,
  sealBox,
  sealSym,
  sealWithCapsule,
  toBase64Url,
  utf8,
  type AadParts,
} from "radium-crypto";
import { openChatSeed } from "./chat-keys";
import { keyManager } from "./key-manager";

/** Public context binding every content object to its workspace, chat and key epoch. */
export type ChatContentKey = {
  workspaceId: Id<"workspaces">;
  e2eeId: string;
  epoch: number;
  publicKey: Uint8Array;
};

/** Reader context; fresh chats may supply their memory-only seed before obtaining a database id. */
export type ChatContentReader = Pick<ChatContentKey, "workspaceId" | "e2eeId"> & {
  chatId?: Id<"aisdk_chats">;
  seed?: Uint8Array;
};

/** Queued turn; file fragments travel only inside this sealed object or the live turn request. */
export type ChatQueue = {
  text: string;
  files: FileUIPart[];
  model: string;
  provider?: string;
  serviceTier?: string;
  inferenceMode?: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
  webSearch: boolean;
};

/** Self-contained title or queue box, with the epoch needed to open it. */
export type ContentBox = { epoch: number; box: ArrayBuffer };

/** Mixed plaintext/encrypted message entry during the migration. */
export type MessageEntry = {
  position: number;
  messageId?: string;
  revision?: number;
  message?: unknown;
  sealed?: { capsuleId: string; envelope: ArrayBuffer };
};

/** One write batch's capsule, shared by all messages in that batch. */
export type MessageCapsule = {
  capsuleId: string;
  chatEpoch: number;
  capsule: ArrayBuffer;
};

type OpenedMessage = { envelope: ArrayBuffer; message: Promise<UIMessage> };
type OpenedCapsule = { capsule: ArrayBuffer; key: Promise<Uint8Array> };
const decoder = new TextDecoder("utf-8", { fatal: true });
let generation = 0;
const openedMessages = new Map<string, OpenedMessage>();
const capsuleKeys = new Map<string, OpenedCapsule>();

keyManager.subscribe(() => {
  if (keyManager.getSnapshot().state === "unlocked") {
    return;
  }
  generation++;
  openedMessages.clear();
  for (const { key } of capsuleKeys.values()) {
    void key.then(
      (bytes) => bytes.fill(0),
      () => {},
    );
  }
  capsuleKeys.clear();
});

function aad(
  chat: Pick<ChatContentKey, "workspaceId" | "e2eeId">,
  table: string,
  record: string,
  field: string,
): AadParts {
  return { workspace: chat.workspaceId, parent: chat.e2eeId, table, record, field };
}

function wire(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function seedFor(chat: ChatContentReader, epoch: number) {
  if (chat.seed) {
    return chat.seed;
  }
  if (!chat.chatId) {
    throw new CryptoError("BAD_INPUT", "Missing chat key context");
  }
  return openChatSeed(chat.chatId, epoch);
}

function parseMessage(value: unknown): UIMessage {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("role" in value) ||
    !["user", "assistant", "system"].includes(String(value.role)) ||
    !("parts" in value) ||
    !Array.isArray(value.parts)
  ) {
    throw new CryptoError("BAD_ENVELOPE", "Invalid sealed message");
  }
  return value as UIMessage;
}

/** Opens each immutable message revision once; all caches are memory-only and cleared on lock. */
export async function openMessages(
  entries: MessageEntry[],
  capsules: MessageCapsule[],
  chat: ChatContentReader,
) {
  const startGeneration = generation;
  const revisions: Record<string, number> = {};
  const capsuleRows = new Map(capsules.map((row) => [row.capsuleId, row]));
  const ordered = [...entries].sort((a, b) => a.position - b.position);
  const messages = await Promise.all(
    ordered.map(async (entry) => {
      if (entry.messageId && entry.revision) {
        revisions[entry.messageId] = entry.revision;
      }
      if (!entry.sealed) {
        const legacy = entry.message;
        if (legacy && typeof legacy === "object" && !("id" in legacy)) {
          // Old rows allowed missing IDs; a stable per-position ID keeps hydration and retries aligned.
          return parseMessage({
            ...legacy,
            id: entry.messageId ?? `${chat.e2eeId}:legacy:${entry.position}`,
          });
        }
        return parseMessage(legacy);
      }
      if (!entry.messageId || !entry.revision) {
        throw new CryptoError("BAD_ENVELOPE", "Missing message revision");
      }
      const row = capsuleRows.get(entry.sealed.capsuleId);
      if (!row) {
        throw new CryptoError("BAD_ENVELOPE", "Missing message capsule");
      }
      const capsuleCacheId = `${chat.workspaceId}:${chat.e2eeId}:${row.chatEpoch}:${row.capsuleId}`;
      let openedCapsule = capsuleKeys.get(capsuleCacheId);
      if (
        openedCapsule &&
        !equalBytes(new Uint8Array(openedCapsule.capsule), new Uint8Array(row.capsule))
      ) {
        // A capsule id is immutable; accepting a replacement would hide tampering behind the cache.
        throw new CryptoError("BAD_ENVELOPE", "Message capsule changed");
      }
      const capsule = decodeCapsule(new Uint8Array(row.capsule));
      if (toBase64Url(capsule.capsuleId) !== row.capsuleId) {
        throw new CryptoError("BAD_ENVELOPE", "Capsule id mismatch");
      }
      const envelope = new Uint8Array(entry.sealed.envelope);
      if (!equalBytes(decodeEnvelope(envelope).keyRef, capsule.capsuleId)) {
        // openSym authenticates the header but does not check that it names the selected capsule.
        throw new CryptoError("BAD_ENVELOPE", "Message capsule mismatch");
      }
      if (!openedCapsule) {
        const key = seedFor(chat, row.chatEpoch).then((seed) =>
          openCapsule({
            seed,
            capsule,
            aad: aad(chat, "e2ee_capsules", String(row.chatEpoch), "capsule"),
          }),
        );
        openedCapsule = { capsule: row.capsule, key };
        capsuleKeys.set(capsuleCacheId, openedCapsule);
        void key.catch(() => capsuleKeys.delete(capsuleCacheId));
      }
      const cacheId = `${chat.workspaceId}:${chat.e2eeId}:${entry.messageId}:${entry.revision}`;
      const cached = openedMessages.get(cacheId);
      if (cached && equalBytes(new Uint8Array(cached.envelope), envelope)) {
        return cached.message;
      }
      const messageId = entry.messageId;
      const key = openedCapsule.key;
      const opened = (async () => {
        const plaintext = await openWithCapsule({
          capsuleKey: await key,
          envelope,
          aad: aad(chat, "chat_messages", messageId, "message"),
          pad: "content",
        });
        try {
          const message = parseMessage(JSON.parse(decoder.decode(plaintext)));
          if (message.id !== messageId) {
            throw new CryptoError("BAD_ENVELOPE", "Message id mismatch");
          }
          if (startGeneration !== generation) {
            throw new CryptoError("DECRYPT_FAILED", "Keys locked while reading");
          }
          return message;
        } finally {
          plaintext.fill(0);
        }
      })();
      openedMessages.set(cacheId, { envelope: entry.sealed.envelope, message: opened });
      void opened.catch(() => openedMessages.delete(cacheId));
      return opened;
    }),
  );
  if (startGeneration !== generation) {
    throw new CryptoError("DECRYPT_FAILED", "Keys locked while reading");
  }
  return { messages, revisions };
}

/** Re-seals fork history to a fresh chat key; the original chat's AAD is never reused. */
export async function sealMessagesForFork(messages: UIMessage[], chat: ChatContentKey) {
  if (!messages.length) {
    return { capsules: [], messages: [] };
  }
  const { capsule, capsuleKey } = await createCapsule({
    recipientPublicKey: chat.publicKey,
    aad: aad(chat, "e2ee_capsules", String(chat.epoch), "capsule"),
  });
  const capsuleId = toBase64Url(capsule.capsuleId);
  try {
    const sealed = await Promise.all(
      messages.map(async (message) => ({
        messageId: message.id,
        capsuleId,
        envelope: wire(
          await sealWithCapsule({
            capsuleKey,
            capsuleId: capsule.capsuleId,
            plaintext: utf8(JSON.stringify(message)),
            aad: aad(chat, "chat_messages", message.id, "message"),
            pad: "content",
          }),
        ),
      })),
    );
    return {
      capsules: [{ capsuleId, chatEpoch: chat.epoch, capsule: wire(encodeCapsule(capsule)) }],
      messages: sealed,
    };
  } finally {
    capsuleKey.fill(0);
  }
}

async function sealContent(
  value: unknown,
  chat: ChatContentKey,
  field: "title" | "queue",
): Promise<ContentBox> {
  const box = await sealBox({
    recipientPublicKey: chat.publicKey,
    plaintext: utf8(JSON.stringify(value)),
    aad: aad(chat, "aisdk_chats", String(chat.epoch), field),
    pad: field === "title" ? "short" : "content",
  });
  return { epoch: chat.epoch, box: wire(box) };
}

async function openContent(
  box: ContentBox,
  chat: ChatContentReader,
  field: "title" | "queue",
): Promise<unknown> {
  const startGeneration = generation;
  const plaintext = await openBox({
    seed: await seedFor(chat, box.epoch),
    box: new Uint8Array(box.box),
    aad: aad(chat, "aisdk_chats", String(box.epoch), field),
    pad: field === "title" ? "short" : "content",
  });
  try {
    if (startGeneration !== generation) {
      throw new CryptoError("DECRYPT_FAILED", "Keys locked while reading");
    }
    return JSON.parse(decoder.decode(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

/** Seals the visible title and optional emoji without persisting plaintext metadata. */
export function sealTitle(title: { title: string; emoji?: string }, chat: ChatContentKey) {
  return sealContent(title, chat, "title");
}

/** Opens a title box under the specified chat epoch. */
export async function openTitle(
  box: ContentBox,
  chat: ChatContentReader,
): Promise<{ title: string; emoji?: string }> {
  const value = await openContent(box, chat, "title");
  if (
    !value ||
    typeof value !== "object" ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    ("emoji" in value && value.emoji !== undefined && typeof value.emoji !== "string")
  ) {
    throw new CryptoError("BAD_ENVELOPE", "Invalid title");
  }
  return value as { title: string; emoji?: string };
}

/** Seals the initial queued prompt and attachment references. */
export function sealQueue(queue: ChatQueue, chat: ChatContentKey) {
  return sealContent(queue, chat, "queue");
}

/** Opens a queued prompt; malformed content fails closed instead of sending a partial turn. */
export async function openQueue(box: ContentBox, chat: ChatContentReader): Promise<ChatQueue> {
  const value = await openContent(box, chat, "queue");
  if (
    !value ||
    typeof value !== "object" ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !("model" in value) ||
    typeof value.model !== "string" ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    throw new CryptoError("BAD_ENVELOPE", "Invalid queued prompt");
  }
  return value as ChatQueue;
}

/** Encrypts one file with its own capsule; neither filename nor object key goes into registration. */
export async function encryptFile(file: Blob, chat: ChatContentKey) {
  const fileId = toBase64Url(randomBytes(16));
  const { capsule, capsuleKey } = await createCapsule({
    recipientPublicKey: chat.publicKey,
    aad: aad(chat, "chat_files", fileId, "capsule"),
  });
  try {
    const objectKey = await deriveObjectKey({
      capsuleKey,
      table: "chat_files",
      recordId: fileId,
      field: "bytes",
    });
    const encrypted = await sealSym({
      key: objectKey,
      keyRef: capsule.capsuleId,
      kind: "capsule",
      plaintext: new Uint8Array(await file.arrayBuffer()),
      aad: aad(chat, "chat_files", fileId, "bytes"),
      pad: "content",
    });
    return {
      body: new Blob([wire(encrypted)], { type: "application/octet-stream" }),
      register: {
        fileId,
        capsule: wire(encodeCapsule(capsule)),
        chatEpoch: chat.epoch,
        e2eeParent: chat.e2eeId,
      },
      objectKey,
      fileId,
    };
  } finally {
    capsuleKey.fill(0);
  }
}

/** Adds the object capability only to the in-memory/sealed message URL, never a storage lookup. */
export function fileUrlWithKey(
  url: string,
  fileId: string,
  chatE2eeId: string,
  objectKey: Uint8Array,
) {
  if (objectKey.length !== 32) {
    throw new CryptoError("BAD_INPUT", "Invalid file key");
  }
  return `${url.split("#")[0]}#rf1.${fileId}.${chatE2eeId}.${toBase64Url(objectKey)}`;
}

/** Parses the fragment strictly; nonencrypted URLs return null, malformed rf1 URLs throw. */
export function parseFileFragment(url: string) {
  const hash = url.indexOf("#");
  const fragment = hash === -1 ? "" : url.slice(hash + 1);
  if (!fragment.startsWith("rf1.")) {
    return null;
  }
  const fields = fragment.split(".");
  if (fields.length !== 4) {
    throw new CryptoError("BAD_INPUT", "Invalid encrypted file URL");
  }
  const [, fileId, e2eeId, encodedKey] = fields as [string, string, string, string];
  if (fromBase64Url(fileId).length !== 16 || fromBase64Url(e2eeId).length !== 16) {
    throw new CryptoError("BAD_INPUT", "Invalid file context");
  }
  const objectKey = fromBase64Url(encodedKey);
  if (objectKey.length !== 32) {
    throw new CryptoError("BAD_INPUT", "Invalid file key");
  }
  return { storageUrl: url.slice(0, hash), fileId, e2eeId, objectKey };
}

/** Downloads without a fragment and decrypts locally; the caller supplies the workspace AAD boundary. */
export async function decryptFileUrl(url: string, workspaceId: Id<"workspaces">): Promise<Blob> {
  const fragment = parseFileFragment(url);
  try {
    const response = await fetch(fragment?.storageUrl ?? url);
    if (!response.ok) {
      throw new Error("Unable to download attachment");
    }
    if (!fragment) {
      return response.blob();
    }
    const bytes = await openSym({
      key: fragment.objectKey,
      envelope: new Uint8Array(await response.arrayBuffer()),
      aad: {
        workspace: workspaceId,
        parent: fragment.e2eeId,
        table: "chat_files",
        record: fragment.fileId,
        field: "bytes",
      },
      pad: "content",
    });
    return new Blob([wire(bytes)]);
  } finally {
    fragment?.objectKey.fill(0);
  }
}
