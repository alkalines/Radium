import { ConvexError, v } from "convex/values";
import type { ModelMessage } from "ai";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { workspaceMutation } from "../../convex/helpers";
import { decodeExactBytes } from "../e2ee/contract";
import { CAPSULE_BYTES, decodeCapsule } from "radium-crypto";
import {
  invalidSealedContent,
  openFileBytes,
  parseFileFragment,
  stripFileFragment,
} from "./sealing";

/**
 * Chat attachments live in Convex File Storage, never inline in chat documents. The browser
 * uploads through `generateUploadUrl`, then `register` records the uploader and workspace and
 * returns the AI SDK file part whose `url` is the storage URL persisted in messages.
 *
 * Storage URLs are unguessable capability URLs (anyone holding one can fetch the file), the
 * standard Convex model. No query lists `chat_files`, so workspace ownership never reveals a
 * member's personal-chat attachments. Rows are per-chat references: saving or forking a chat
 * links the files its messages mention, and the file is deleted with its last reference.
 */

/** Largest accepted attachment; the web Composer enforces the same limit before uploading. */
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
// Content padding adds at most one 4 KiB page; the envelope adds a 31-byte header and 16-byte tag.
const MAX_ENCRYPTED_CHAT_FILE_BYTES = MAX_CHAT_FILE_BYTES + 4096 + 47;
// Uploads never sent in a message (removed attachment, closed Tab) are deleted after this.
const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 64;
// A bare `type/subtype` token pair; encrypted uploads declare it, so it must stay short and inert.
const MEDIA_TYPE_PATTERN = /^[\w!#$&^.+-]{1,64}\/[\w!#$&^.+-]{1,64}$/;

const fileUIPartValidator = v.object({
  type: v.literal("file"),
  mediaType: v.string(),
  filename: v.optional(v.string()),
  url: v.string(),
});

/** Upload URL for one attachment. Any workspace member may upload. */
export const generateUploadUrl = workspaceMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Record an uploaded file as a pending attachment of the caller in this workspace and return its
 * file part. A storage ID can be registered once, so another user cannot claim an upload. Returns
 * `null` (deleting the upload) when the file is missing or larger than `MAX_CHAT_FILE_BYTES`;
 * throwing would roll the deletion back.
 */
export const register = workspaceMutation({
  args: {
    storageId: v.id("_storage"),
    filename: v.optional(v.string()),
    /** Declared media type of an encrypted upload, e.g. `image/png`; plaintext uploads use storage's. */
    mediaType: v.optional(v.string()),
    e2ee: v.optional(
      v.object({
        fileId: v.string(),
        capsule: v.bytes(),
        chatEpoch: v.number(),
        e2eeParent: v.string(),
      }),
    ),
  },
  returns: v.union(fileUIPartValidator, v.null()),
  handler: async (ctx, args) => {
    if (args.mediaType !== undefined && (!args.e2ee || !MEDIA_TYPE_PATTERN.test(args.mediaType))) {
      throw new ConvexError({ code: "E2EE_CONTENT_INVALID" });
    }
    if (args.e2ee) {
      if (
        args.filename !== undefined ||
        !decodeExactBytes(args.e2ee.fileId, 16) ||
        !decodeExactBytes(args.e2ee.e2eeParent, 16) ||
        !Number.isSafeInteger(args.e2ee.chatEpoch) ||
        args.e2ee.chatEpoch < 1 ||
        args.e2ee.capsule.byteLength !== CAPSULE_BYTES
      ) {
        // File names belong inside the sealed message, never beside encrypted storage metadata.
        throw new ConvexError({ code: "E2EE_CONTENT_INVALID" });
      }
      try {
        decodeCapsule(new Uint8Array(args.e2ee.capsule));
      } catch {
        throw new ConvexError({ code: "E2EE_CONTENT_INVALID" });
      }
    }
    const stored = await ctx.db.system.get("_storage", args.storageId);
    if (!stored) return null;

    const claimed = await ctx.db
      .query("chat_files")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (claimed) return null;

    const url = await ctx.storage.getUrl(args.storageId);
    const maxBytes = args.e2ee ? MAX_ENCRYPTED_CHAT_FILE_BYTES : MAX_CHAT_FILE_BYTES;
    if (!url || stored.size > maxBytes) {
      await ctx.storage.delete(args.storageId);
      return null;
    }

    // Encrypted uploads are stored as opaque bytes: the storage row's content type is the
    // uploader's HTTP header and never trusted; the declared media type is only metadata.
    const mediaType = args.e2ee
      ? (args.mediaType ?? "application/octet-stream")
      : stored.contentType || "application/octet-stream";
    const filename = args.e2ee ? undefined : args.filename?.trim().slice(0, 255) || undefined;
    await ctx.db.insert("chat_files", {
      workspace: ctx.workspace._id,
      userId: ctx.identity._id,
      storageId: args.storageId,
      url,
      mediaType,
      filename,
      size: stored.size,
      ...(args.e2ee ?? {}),
    });
    return { type: "file" as const, mediaType, url, ...(filename ? { filename } : {}) };
  },
});

/** Storage-backed URLs among AI SDK message parts; inline data and external URLs are skipped. */
export function storedFileUrls(messages: ReadonlyArray<{ parts: readonly unknown[] }>) {
  const urls = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type !== "file" || typeof record.url !== "string") continue;
      if (record.url.startsWith("http://") || record.url.startsWith("https://")) {
        urls.add(stripFileFragment(record.url));
      }
    }
  }
  return urls;
}

/** A reference row that carries everything needed to open its bytes with the chat's key. */
function isSealedFile(file: Doc<"chat_files">) {
  return (
    file.fileId !== undefined &&
    file.capsule !== undefined &&
    file.e2eeParent !== undefined &&
    file.chatEpoch !== undefined
  );
}

/**
 * Give `chat` a reference to each workspace file in `urls`: a pending upload is attached, a file
 * another chat already references (a fork, a reused attachment) gets its own row. URLs that are
 * not this workspace's files are ignored, so a client cannot attach another workspace's upload.
 * With `sealed`, every new upload linked must be encrypted (a plaintext one would silently
 * downgrade the attachment of a keyed chat). Files another chat already references are linked as
 * they are: a legacy plaintext attachment carried into a fork was stored in plaintext before and
 * gains no new exposure; the content migration seals it later.
 */
export async function linkChatFiles(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  chat: Id<"aisdk_chats">,
  urls: Iterable<string>,
  options: { sealed?: boolean } = {},
) {
  for (const originalUrl of urls) {
    const url = stripFileFragment(originalUrl);
    const fileReference = (reference: Id<"aisdk_chats"> | undefined) =>
      ctx.db
        .query("chat_files")
        .withIndex("by_workspace_and_url_and_chat", (q) =>
          q.eq("workspace", workspace).eq("url", url).eq("chat", reference),
        )
        .first();
    if (await fileReference(chat)) continue;

    const pending = await fileReference(undefined);
    if (pending) {
      if (options.sealed && !isSealedFile(pending)) invalidSealedContent();
      await ctx.db.patch("chat_files", pending._id, { chat });
      continue;
    }

    const source = await ctx.db
      .query("chat_files")
      .withIndex("by_workspace_and_url_and_chat", (q) =>
        q.eq("workspace", workspace).eq("url", url),
      )
      .first();
    if (!source) continue;
    await ctx.db.insert("chat_files", {
      workspace,
      userId: source.userId,
      storageId: source.storageId,
      url,
      mediaType: source.mediaType,
      filename: source.filename,
      size: source.size,
      fileId: source.fileId,
      capsule: source.capsule,
      chatEpoch: source.chatEpoch,
      e2eeParent: source.e2eeParent,
      chat,
    });
  }
}

/** Delete a reference row, and the stored file once no other row references it. */
async function deleteFileReference(
  ctx: MutationCtx,
  file: { _id: Id<"chat_files">; storageId: Id<"_storage"> },
) {
  await ctx.db.delete("chat_files", file._id);
  const remaining = await ctx.db
    .query("chat_files")
    .withIndex("by_storageId", (q) => q.eq("storageId", file.storageId))
    .first();
  if (!remaining) await ctx.storage.delete(file.storageId);
}

/**
 * Delete up to one batch of a deleted chat's file references; returns whether more remain.
 * Callers reschedule until it returns `false`.
 */
export async function deleteChatFileBatch(ctx: MutationCtx, chat: Id<"aisdk_chats">) {
  const files = await ctx.db
    .query("chat_files")
    .withIndex("by_chat", (q) => q.eq("chat", chat))
    .take(CLEANUP_BATCH_SIZE);
  for (const file of files) await deleteFileReference(ctx, file);
  return files.length === CLEANUP_BATCH_SIZE;
}

/**
 * Delete one batch of `_storage` files older than `cutoff` that no repository row references:
 * uploads never registered, or telemetry files whose blob write failed. A persisted cursor makes
 * each file checked once; files referenced then are deleted with their last reference instead.
 * Returns whether the scan reached `cutoff`.
 */
async function sweepUnreferencedStorage(ctx: MutationCtx, cutoff: number) {
  const cursor = await ctx.db.query("storage_sweeps").first();
  const files = await ctx.db.system
    .query("_storage")
    .withIndex("by_creation_time", (q) =>
      q.gt("_creationTime", cursor?.scannedThrough ?? 0).lt("_creationTime", cutoff),
    )
    .take(CLEANUP_BATCH_SIZE);
  for (const file of files) {
    const chatFile = await ctx.db
      .query("chat_files")
      .withIndex("by_storageId", (q) => q.eq("storageId", file._id))
      .first();
    const telemetryBlob = chatFile
      ? null
      : await ctx.db
          .query("telemetry_blobs")
          .withIndex("by_storage", (q) => q.eq("storage", file._id))
          .first();
    if (!chatFile && !telemetryBlob) await ctx.storage.delete(file._id);
  }

  const last = files.at(-1);
  if (last && cursor) {
    await ctx.db.patch("storage_sweeps", cursor._id, { scannedThrough: last._creationTime });
  } else if (last) {
    await ctx.db.insert("storage_sweeps", { scannedThrough: last._creationTime });
  }
  return files.length < CLEANUP_BATCH_SIZE;
}

/**
 * Hourly cron: delete stored files nothing references and uploads that were never sent, both
 * once older than `PENDING_UPLOAD_TTL_MS`.
 */
export const prunePendingUploads = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - PENDING_UPLOAD_TTL_MS;
    // Runs first: pending rows still reference their files, so the sweep skips what the
    // pending pass below deletes.
    const sweptAll = await sweepUnreferencedStorage(ctx, cutoff);
    // `by_chat` orders pending rows by creation time, oldest first.
    const pending = await ctx.db
      .query("chat_files")
      .withIndex("by_chat", (q) => q.eq("chat", undefined).lt("_creationTime", cutoff))
      .take(CLEANUP_BATCH_SIZE);
    for (const file of pending) await deleteFileReference(ctx, file);
    if (pending.length === CLEANUP_BATCH_SIZE || !sweptAll) {
      await ctx.scheduler.runAfter(0, internal.chat_files.prunePendingUploads, {});
    }
    return null;
  },
});

/** Storage IDs of this workspace's files among `urls`, for the chat action's model input. */
export const resolveStoredFiles = internalQuery({
  args: { workspace: v.id("workspaces"), urls: v.array(v.string()) },
  returns: v.array(v.object({ url: v.string(), storageId: v.id("_storage") })),
  handler: async (ctx, args) => {
    const resolved: Array<{ url: string; storageId: Id<"_storage"> }> = [];
    for (const url of new Set(args.urls.map(stripFileFragment))) {
      const file = await ctx.db
        .query("chat_files")
        .withIndex("by_workspace_and_url_and_chat", (q) =>
          q.eq("workspace", args.workspace).eq("url", url),
        )
        .first();
      if (file) resolved.push({ url, storageId: file.storageId });
    }
    return resolved;
  },
});

/**
 * Replace storage-URL file parts in model input with the stored bytes. Upstream providers would
 * otherwise have to fetch the deployment's storage URL themselves, which fails for private or
 * local self-hosted deployments and for endpoints that only accept inline file data.
 * Persisted messages keep the URL; only this request's model input carries bytes.
 */
export async function inlineStoredFiles(
  ctx: ActionCtx,
  workspace: Id<"workspaces">,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const urls: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      const url = storageUrlOf(part);
      if (url) urls.push(url);
    }
  }
  if (urls.length === 0) return messages;

  // Never pass object-key fragments across the action/query boundary.
  const resolved = await ctx.runQuery(internal.chat_files.resolveStoredFiles, {
    workspace,
    urls: urls.map(stripFileFragment),
  });
  const storageIds = new Map(resolved.map(({ url, storageId }) => [url, storageId]));
  const bytesByUrl = new Map<string, Uint8Array>();
  for (const url of new Set(urls)) {
    const fragment = parseFileFragment(url);
    fragment?.objectKey.fill(0);
    const storageId = storageIds.get(stripFileFragment(url));
    if (!storageId) {
      if (fragment) {
        throw new Error("Encrypted attachment unavailable");
      }
      continue;
    }
    const blob = await ctx.storage.get(storageId);
    if (!blob) {
      if (fragment) {
        throw new Error("Encrypted attachment unavailable");
      }
      continue;
    }
    bytesByUrl.set(
      url,
      await openFileBytes(workspace, url, new Uint8Array(await blob.arrayBuffer())),
    );
  }

  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((part) => {
      const url = storageUrlOf(part);
      const bytes = url ? bytesByUrl.get(url) : undefined;
      if (!bytes) {
        if (!url || part.type !== "file") return part;
        const data = part.data;
        if (!data || typeof data !== "object" || !("type" in data) || data.type !== "url")
          return part;
        return { ...part, data: { ...data, url: new URL(stripFileFragment(url)) } };
      }
      return { ...part, data: { type: "data" as const, data: bytes } };
    });
    return { ...message, content } as ModelMessage;
  });
}

/** URL of a model file part that still points at a URL (as AI SDK converts UI file parts). */
function storageUrlOf(part: unknown) {
  if (!part || typeof part !== "object") return undefined;
  const record = part as { type?: unknown; data?: unknown };
  if (record.type !== "file" || !record.data || typeof record.data !== "object") return undefined;
  const data = record.data as { type?: unknown; url?: unknown };
  if (data.type !== "url" || !(data.url instanceof URL)) return undefined;
  return data.url.href;
}
