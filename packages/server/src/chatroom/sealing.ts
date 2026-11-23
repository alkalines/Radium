import { generateId } from "ai";
import {
  CAPSULE_BYTES,
  createCapsule,
  decodeCapsule,
  decodeEnvelope,
  encodeCapsule,
  openSym,
  sealBox,
  sealWithCapsule,
  toBase64Url,
  utf8,
} from "radium-crypto";
import { z } from "zod";
import { decodeExactBytes } from "contracts/e2ee/contract";
import { base64urlBytes } from "contracts/wire";
import { AppError } from "../errors";

/**
 * Validation of sealed chat content the server stores but cannot read, and the server-side sealing
 * of new content it produced itself (assistant turns, titles). Ported from Convex
 * `src/chatroom/sealing.ts`; AAD strings are unchanged (imported ciphertext names `aisdk_chats`).
 */

/** Largest sealed message envelope. */
export const MAX_MESSAGE_ENVELOPE_BYTES = 1024 * 1024;
/** Largest sealed title box. */
export const MAX_TITLE_BOX_BYTES = 2048;
/** Largest sealed queued prompt box. */
export const MAX_QUEUE_BOX_BYTES = 64 * 1024;

/** A title or queue sealed to a numbered chat key epoch. */
export const sealedBoxInput = z.object({
  epoch: z.number().int(),
  box: base64urlBytes(MAX_QUEUE_BOX_BYTES),
});
export type SealedBox = z.output<typeof sealedBoxInput>;

/** One write batch's capsule. */
export const chatCapsuleInput = z.object({
  capsuleId: z.string().max(32),
  chatEpoch: z.number().int(),
  capsule: base64urlBytes(CAPSULE_BYTES),
});
export type ChatCapsule = z.output<typeof chatCapsuleInput>;

/** Positions changed during a turn, plus the new history length for truncation. */
export type SealedWrites = {
  capsule: ChatCapsule;
  rows: Array<{ position: number; messageId: string; revision: number; envelope: Uint8Array }>;
  length: number;
  fileUrls: string[];
};

/** Public-only context binding server-generated ciphertext to its chat and workspace. */
export type ChatSealTarget = {
  workspace: string;
  e2eeId: string;
  epoch: number;
  publicKey: Uint8Array;
};

/** Refuses malformed sealed content without echoing it or any attachment secret. */
export function invalidSealedContent(): never {
  throw new AppError("BAD_REQUEST", "E2EE_CONTENT_INVALID");
}

/** Validates the structural capsule encoding and its externally named id. */
export function validateChatCapsule(value: ChatCapsule) {
  if (
    !decodeExactBytes(value.capsuleId, 16) ||
    !Number.isSafeInteger(value.chatEpoch) ||
    value.chatEpoch < 1 ||
    value.capsule.byteLength !== CAPSULE_BYTES
  ) {
    invalidSealedContent();
  }
  let capsuleId: string;
  try {
    capsuleId = toBase64Url(decodeCapsule(value.capsule).capsuleId);
  } catch {
    invalidSealedContent();
  }
  if (capsuleId !== value.capsuleId) invalidSealedContent();
}

/** Validates a box's epoch and size before storing opaque client content. */
export function validateChatBox(value: SealedBox, epoch: number, maxBytes: number) {
  if (
    value.epoch !== epoch ||
    value.box.byteLength <= CAPSULE_BYTES ||
    value.box.byteLength > maxBytes
  ) {
    invalidSealedContent();
  }
}

/** Validates a message envelope and binds its header to the named write capsule. */
export function validateMessageEnvelope(envelope: Uint8Array, capsuleId: string) {
  if (envelope.byteLength > MAX_MESSAGE_ENVELOPE_BYTES) invalidSealedContent();
  let keyRef: string;
  try {
    const decoded = decodeEnvelope(envelope);
    if (decoded.kind !== "capsule") invalidSealedContent();
    keyRef = toBase64Url(decoded.keyRef);
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalidSealedContent();
  }
  if (keyRef !== capsuleId) invalidSealedContent();
}

/**
 * Seals exactly the changed messages with one fresh per-turn capsule. A message whose stored head
 * has the same id and the revision the client sent is skipped; the response message is always
 * written.
 */
export async function sealChatMessages(
  input: ChatSealTarget & {
    messages: Array<{ id?: string }>;
    heads: Array<{ position: number; messageId: string | null; revision: number | null }>;
    revisions?: Record<string, number>;
    responseMessageId?: string;
    fileUrls: string[];
  },
): Promise<SealedWrites> {
  const { capsule, capsuleKey } = await createCapsule({
    recipientPublicKey: input.publicKey,
    aad: {
      workspace: input.workspace,
      table: "e2ee_capsules",
      parent: input.e2eeId,
      record: String(input.epoch),
      field: "capsule",
    },
  });
  const capsuleId = toBase64Url(capsule.capsuleId);
  const heads = new Map(input.heads.map((head) => [head.position, head]));
  const rows: SealedWrites["rows"] = [];
  try {
    for (const [position, original] of input.messages.entries()) {
      const message = original.id ? original : { ...original, id: generateId() };
      const messageId = message.id!;
      const head = heads.get(position);
      if (
        head &&
        head.messageId === messageId &&
        head.revision !== null &&
        input.revisions?.[messageId] === head.revision &&
        messageId !== input.responseMessageId
      ) {
        continue;
      }
      rows.push({
        position,
        messageId,
        revision: (head?.revision ?? 0) + 1,
        envelope: await sealWithCapsule({
          capsuleKey,
          capsuleId: capsule.capsuleId,
          plaintext: utf8(JSON.stringify(message)),
          pad: "content",
          aad: {
            workspace: input.workspace,
            table: "chat_messages",
            parent: input.e2eeId,
            record: messageId,
            field: "message",
          },
        }),
      });
    }
    return {
      capsule: { capsuleId, chatEpoch: input.epoch, capsule: encodeCapsule(capsule) },
      rows,
      length: input.messages.length,
      fileUrls: input.fileUrls,
    };
  } finally {
    capsuleKey.fill(0);
  }
}

/** Seals title and emoji to the chat's current key without persisting their plaintext. */
export async function sealChatTitle(
  target: ChatSealTarget,
  title: { title: string; emoji: string },
): Promise<SealedBox> {
  return {
    epoch: target.epoch,
    box: await sealBox({
      recipientPublicKey: target.publicKey,
      plaintext: utf8(JSON.stringify(title)),
      pad: "short",
      aad: {
        workspace: target.workspace,
        table: "aisdk_chats",
        parent: target.e2eeId,
        record: String(target.epoch),
        field: "title",
      },
    }),
  };
}

/** Strips every URL fragment before database lookups, storage references or model requests. */
export function stripFileFragment(url: string) {
  return url.split("#", 1)[0]!;
}

/** Parses an in-memory attachment object key. Malformed encryption fragments fail closed. */
export function parseFileFragment(url: string) {
  const fragment = url.slice(url.indexOf("#") + 1);
  if (!url.includes("#") || !fragment.startsWith("rf1.")) {
    return null;
  }
  const [version, fileId, e2eeParent, key, extra] = fragment.split(".");
  if (
    version !== "rf1" ||
    !fileId ||
    !e2eeParent ||
    !key ||
    extra !== undefined ||
    !decodeExactBytes(fileId, 16) ||
    !decodeExactBytes(e2eeParent, 16)
  ) {
    invalidSealedContent();
  }
  const objectKey = decodeExactBytes(key, 32);
  if (!objectKey) invalidSealedContent();
  return { fileId, e2eeParent, objectKey };
}

/** Opens an attachment with only its object key, never the chat seed or a batch capsule key. */
export async function openFileBytes(workspace: string, url: string, envelope: Uint8Array) {
  const fragment = parseFileFragment(url);
  if (!fragment) {
    return envelope;
  }
  try {
    return await openSym({
      key: fragment.objectKey,
      envelope,
      pad: "content",
      aad: {
        workspace,
        table: "chat_files",
        parent: fragment.e2eeParent,
        record: fragment.fileId,
        field: "bytes",
      },
    });
  } finally {
    fragment.objectKey.fill(0);
  }
}
