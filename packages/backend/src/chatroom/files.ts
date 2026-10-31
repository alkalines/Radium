import { v } from "convex/values";
import type { ModelMessage } from "ai";
import type { Id } from "../../convex/_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { workspaceMutation } from "../../convex/helpers";

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
// Uploads never sent in a message (removed attachment, closed Tab) are deleted after this.
const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 64;

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
  args: { storageId: v.id("_storage"), filename: v.optional(v.string()) },
  returns: v.union(fileUIPartValidator, v.null()),
  handler: async (ctx, args) => {
    const stored = await ctx.db.system.get("_storage", args.storageId);
    if (!stored) return null;

    const claimed = await ctx.db
      .query("chat_files")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (claimed) return null;

    const url = await ctx.storage.getUrl(args.storageId);
    if (!url || stored.size > MAX_CHAT_FILE_BYTES) {
      await ctx.storage.delete(args.storageId);
      return null;
    }

    const mediaType = stored.contentType || "application/octet-stream";
    const filename = args.filename?.trim().slice(0, 255) || undefined;
    await ctx.db.insert("chat_files", {
      workspace: ctx.workspace._id,
      userId: ctx.identity._id,
      storageId: args.storageId,
      url,
      mediaType,
      filename,
      size: stored.size,
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
        urls.add(record.url);
      }
    }
  }
  return urls;
}

/**
 * Give `chat` a reference to each workspace file in `urls`: a pending upload is attached, a file
 * another chat already references (a fork, a reused attachment) gets its own row. URLs that are
 * not this workspace's files are ignored, so a client cannot attach another workspace's upload.
 */
export async function linkChatFiles(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  chat: Id<"aisdk_chats">,
  urls: Iterable<string>,
) {
  for (const url of urls) {
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
    for (const url of new Set(args.urls)) {
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

  const resolved = await ctx.runQuery(internal.chat_files.resolveStoredFiles, { workspace, urls });
  const bytesByUrl = new Map<string, Uint8Array>();
  for (const { url, storageId } of resolved) {
    const blob = await ctx.storage.get(storageId);
    if (blob) bytesByUrl.set(url, new Uint8Array(await blob.arrayBuffer()));
  }

  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((part) => {
      const url = storageUrlOf(part);
      const bytes = url ? bytesByUrl.get(url) : undefined;
      if (!bytes) return part;
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
