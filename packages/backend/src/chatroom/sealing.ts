import { generateId } from "ai";
import { ConvexError, v, type Infer } from "convex/values";
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
import { decodeExactBytes, toArrayBuffer } from "../e2ee/contract";

/** A title/queue sealed to a numbered chat key epoch. */
export const sealedBoxValidator = v.object({ epoch: v.number(), box: v.bytes() });
/** One write batch's capsule; its key never crosses the action/mutation boundary. */
export const chatCapsuleValidator = v.object({
  capsuleId: v.string(),
  chatEpoch: v.number(),
  capsule: v.bytes(),
});
/** Positions changed during a turn, plus the new history length for truncation. */
export const sealedWritesValidator = v.object({
  capsule: chatCapsuleValidator,
  rows: v.array(
    v.object({
      position: v.number(),
      messageId: v.string(),
      revision: v.number(),
      envelope: v.bytes(),
    }),
  ),
  length: v.number(),
  fileUrls: v.array(v.string()),
});
/** Validated sealed write batch passed from an action to the persistence mutation. */
export type SealedWrites = Infer<typeof sealedWritesValidator>;
/** Public-only context binding action-generated ciphertext to its chat and workspace. */
export type ChatSealTarget = {
  workspace: string;
  e2eeId: string;
  epoch: number;
  publicKey: Uint8Array;
};

/** Reject malformed envelopes without echoing their content or any attachment secrets. */
export function invalidSealedContent(): never {
  throw new ConvexError({ code: "E2EE_CONTENT_INVALID" });
}

/** Validate the structural capsule encoding and its externally named ID. */
export function validateChatCapsule(value: Infer<typeof chatCapsuleValidator>) {
  if (
    !decodeExactBytes(value.capsuleId, 16) ||
    !Number.isSafeInteger(value.chatEpoch) ||
    value.chatEpoch < 1 ||
    value.capsule.byteLength !== CAPSULE_BYTES
  ) {
    invalidSealedContent();
  }
  try {
    if (toBase64Url(decodeCapsule(new Uint8Array(value.capsule)).capsuleId) !== value.capsuleId) {
      invalidSealedContent();
    }
  } catch {
    invalidSealedContent();
  }
}

/** Validate a box's epoch and size before storing opaque client content. */
export function validateChatBox(
  value: Infer<typeof sealedBoxValidator>,
  epoch: number,
  maxBytes: number,
) {
  if (
    value.epoch !== epoch ||
    value.box.byteLength <= CAPSULE_BYTES ||
    value.box.byteLength > maxBytes
  ) {
    invalidSealedContent();
  }
}

/** Validate a message envelope and bind its header to the named write capsule. */
export function validateMessageEnvelope(envelope: ArrayBuffer, capsuleId: string) {
  if (envelope.byteLength > 1024 * 1024) {
    invalidSealedContent();
  }
  try {
    const decoded = decodeEnvelope(new Uint8Array(envelope));
    if (decoded.kind !== "capsule" || toBase64Url(decoded.keyRef) !== capsuleId) {
      invalidSealedContent();
    }
  } catch {
    invalidSealedContent();
  }
}

/** Seal exactly the selected messages with one fresh per-turn capsule. Actions only. */
export async function sealChatMessages(
  input: ChatSealTarget & {
    messages: Array<{ id?: string }>;
    heads: Array<{ position: number; messageId?: string; revision?: number }>;
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
        input.revisions?.[messageId] === head.revision &&
        messageId !== input.responseMessageId
      ) {
        continue;
      }
      rows.push({
        position,
        messageId,
        revision: (head?.revision ?? 0) + 1,
        envelope: toArrayBuffer(
          await sealWithCapsule({
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
        ),
      });
    }
    return {
      capsule: {
        capsuleId,
        chatEpoch: input.epoch,
        capsule: toArrayBuffer(encodeCapsule(capsule)),
      },
      rows,
      length: input.messages.length,
      fileUrls: input.fileUrls,
    };
  } finally {
    capsuleKey.fill(0);
  }
}

/** Seal title and emoji to the chat's current key without persisting their plaintext. */
export async function sealChatTitle(
  target: ChatSealTarget,
  title: { title: string; emoji: string },
) {
  return {
    epoch: target.epoch,
    box: toArrayBuffer(
      await sealBox({
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
    ),
  };
}

/** Strip all URL fragments before database lookups, storage references or model requests. */
export function stripFileFragment(url: string) {
  return url.split("#", 1)[0]!;
}

/** Prevent attachment object keys from entering legacy plaintext messages or queues. */
export function validatePlaintextAttachments(parts: readonly unknown[]) {
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "file") {
      continue;
    }
    if ("url" in part && typeof part.url === "string" && part.url.includes("#rf1.")) {
      invalidSealedContent();
    }
  }
}

/** Parse an in-memory attachment object key. Malformed encryption fragments fail closed. */
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
  if (!objectKey) {
    invalidSealedContent();
  }
  return { fileId, e2eeParent, objectKey };
}

/** Open an attachment using only its object key, never the chat seed or batch capsule key. */
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
