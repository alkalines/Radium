import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { decodeExactBytes } from "contracts/e2ee/contract";
import { CAPSULE_BYTES, decodeCapsule } from "radium-crypto";
import { z } from "zod";
import { takeToken, type RateLimit } from "../auth/ratelimit";
import type { Config } from "../config";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { enqueueJob } from "../jobs/outbox";
import { kvGet, kvSet, kvTake } from "../kv";
import type { Runtime } from "../runtime";
import type { WorkspaceAccess } from "../workspaces/access";
import { listWorkspaces } from "../workspaces/workspaces";
import { chatAccess, requireChatAccess } from "./access";
import { chatFiles } from "./schema";
import { invalidSealedContent, stripFileFragment } from "./sealing";

/**
 * Chat attachments in the object store (Convex `chatroom/files.ts`). The browser uploads an
 * encrypted file with a presigned PUT (or `PUT /api/files/upload/<id>` on local disk), then
 * `register` records it as a pending attachment of the uploader; saving or creating a chat that
 * names the file's URL attaches it (`linkChatFiles`). The server only ever stores opaque
 * envelopes: no plaintext uploads, no file names.
 */

/** Largest accepted attachment; the web Composer enforces the same limit before uploading. */
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
// Content padding adds at most one 4 KiB page; the envelope adds a 31-byte header and 16-byte tag.
export const MAX_ENCRYPTED_CHAT_FILE_BYTES = MAX_CHAT_FILE_BYTES + 4096 + 47;
/** Uploads never sent in a message (removed attachment, closed Tab) are deleted after this. */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Upload intents expire unused after this. */
const UPLOAD_INTENT_TTL_MS = 60 * 60 * 1000;
const PRESIGNED_PUT_SECONDS = 15 * 60;
const PRESIGNED_GET_SECONDS = 60;
/** Rows of one object whose chats are checked for a download (a widely forked file). */
const DOWNLOAD_ROW_BOUND = 50;
/** Keys per `files.release` job. */
const RELEASE_BATCH = 200;
// A bare `type/subtype` token pair; encrypted uploads declare it, so it must stay short and inert.
const MEDIA_TYPE_PATTERN = /^[\w!#$&^.+-]{1,64}\/[\w!#$&^.+-]{1,64}$/;

const UPLOADS: RateLimit = { name: "chat-upload", capacity: 60, periodMs: 60_000 };

export const FILES_RELEASE_JOB = "files.release";
const releasePayload = z.object({ keys: z.array(z.string().max(256)).max(RELEASE_BATCH) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `id` is the shape of a public file id (a random UUID). */
export function isFileId(id: string) {
  return UUID.test(id);
}

/** Object key of an upload: `chat/<uuid>`. */
export const uploadKey = (id: string) => `chat/${id}`;

/** The absolute URL of an uploaded file's part: `${SITE_URL}/api/files/<uuid>`. */
export function fileUrl(config: Pick<Config, "SITE_URL">, id: string) {
  return `${config.SITE_URL}/api/files/${id}`;
}

/**
 * The object key behind a file part URL, or `null` unless it is exactly `fileUrl` of a UUID
 * (after stripping the encryption fragment). Imported Convex URLs are not keys: they resolve
 * through `chat_files.legacy_url`.
 */
export function storageKeyForUrl(config: Pick<Config, "SITE_URL">, url: string): string | null {
  const prefix = `${config.SITE_URL}/api/files/`;
  const stripped = stripFileFragment(url);
  if (!stripped.startsWith(prefix)) return null;
  const id = stripped.slice(prefix.length);
  return isFileId(id) ? uploadKey(id) : null;
}

const intentKey = (id: string) => `upload:${id}`;

/**
 * Starts an upload: any workspace user may upload. Records the intent (`userId:workspace`) that
 * `registerFile` takes once. `uploadUrl` is a presigned PUT, or the relative `/api/files/upload`
 * route on local disk. The presigned URL cannot bound the size; `registerFile` does.
 */
export async function createUpload(
  runtime: Runtime,
  access: Pick<WorkspaceAccess, "workspace">,
  userId: string,
): Promise<{ id: string; uploadUrl: string; method: "PUT" }> {
  const { kv, objects } = runtime.drivers;
  if (!(await takeToken(kv, UPLOADS, userId))) {
    throw new AppError("FORBIDDEN", "Too many uploads. Try again shortly.");
  }
  const id = crypto.randomUUID();
  await kvSet(kv, intentKey(id), `${userId}:${access.workspace.id}`, { ttlMs: UPLOAD_INTENT_TTL_MS });
  const uploadUrl =
    objects.presignPut(uploadKey(id), { expiresInSeconds: PRESIGNED_PUT_SECONDS }) ??
    `/api/files/upload/${id}`;
  return { id, uploadUrl, method: "PUT" };
}

export type RegisterFileInput = {
  id: string;
  mediaType?: string;
  e2ee: { fileId: string; capsule: Uint8Array; chatEpoch: number; e2eeParent: string };
};

/** A UI file part. */
export type FilePart = { type: "file"; mediaType: string; url: string };

/**
 * Records an uploaded object as a pending attachment of the caller in this workspace and returns
 * its file part. The upload intent is single-use and must belong to this user and workspace, so
 * another user cannot claim an upload. Returns `null` (deleting the object when it is oversized)
 * when the intent is unknown, the object is missing or too large, or it is already registered;
 * throwing would not help the caller and a refusal must not reveal which case it was.
 */
export async function registerFile(
  runtime: Runtime,
  access: Pick<WorkspaceAccess, "workspace">,
  userId: string,
  input: RegisterFileInput,
): Promise<FilePart | null> {
  const { e2ee } = input;
  if (input.mediaType !== undefined && !MEDIA_TYPE_PATTERN.test(input.mediaType)) {
    invalidSealedContent();
  }
  if (
    !isFileId(input.id) ||
    !decodeExactBytes(e2ee.fileId, 16) ||
    !decodeExactBytes(e2ee.e2eeParent, 16) ||
    !Number.isSafeInteger(e2ee.chatEpoch) ||
    e2ee.chatEpoch < 1 ||
    e2ee.capsule.byteLength !== CAPSULE_BYTES
  ) {
    // File names belong inside the sealed message, never beside encrypted storage metadata.
    invalidSealedContent();
  }
  try {
    decodeCapsule(e2ee.capsule);
  } catch {
    invalidSealedContent();
  }

  const { db, kv, objects } = runtime.drivers;
  const expected = `${userId}:${access.workspace.id}`;
  // Look before taking, so a caller who guessed an id cannot burn the owner's intent.
  if ((await kvGet(kv, intentKey(input.id))) !== expected) return null;
  if ((await kvTake(kv, intentKey(input.id))) !== expected) return null;

  const key = uploadKey(input.id);
  const stored = await objects.stat(key);
  if (!stored) return null;
  if (stored.size > MAX_ENCRYPTED_CHAT_FILE_BYTES) {
    await objects.delete(key);
    return null;
  }

  // Encrypted uploads are stored as opaque bytes; the declared media type is only metadata.
  const mediaType = input.mediaType ?? "application/octet-stream";
  const inserted = await db
    .insert(chatFiles)
    .values({
      workspace: access.workspace.id,
      userId,
      storageKey: key,
      mediaType,
      size: stored.size,
      fileId: e2ee.fileId,
      capsule: e2ee.capsule,
      chatEpoch: e2ee.chatEpoch,
      e2eeParent: e2ee.e2eeParent,
    })
    .onConflictDoNothing()
    .returning({ id: chatFiles.id });
  if (inserted.length === 0) return null;
  return { type: "file", mediaType, url: fileUrl(runtime.config, input.id) };
}

/**
 * Locates a historical attachment's sealed sidecar by its old storage URL, after authorizing the
 * parent chat. The browser opens the sidecar and re-encrypts the file natively. Null: not a
 * historical attachment of this chat.
 */
export async function historicalFile(db: Database, userId: string, input: { chatId: string; url: string }) {
  const { workspace } = await requireChatAccess(db, userId, input.chatId);
  const [file] = await db
    .select({ id: chatFiles.id, legacyContent: chatFiles.legacyContent })
    .from(chatFiles)
    .where(
      and(
        eq(chatFiles.workspace, workspace.id),
        eq(chatFiles.legacyUrl, stripFileFragment(input.url)),
        eq(chatFiles.chat, input.chatId),
      ),
    )
    .limit(1);
  if (!file?.legacyContent) return null;
  return { recordId: file.id, legacyContent: file.legacyContent };
}

/** Storage-backed URLs among AI SDK message parts; inline data and external URLs are skipped. */
export function storedFileUrls(messages: ReadonlyArray<{ parts: readonly unknown[] }>) {
  const urls = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue;
      if (!("type" in part) || part.type !== "file" || !("url" in part)) continue;
      if (typeof part.url !== "string") continue;
      if (part.url.startsWith("http://") || part.url.startsWith("https://")) {
        urls.add(stripFileFragment(part.url));
      }
    }
  }
  return urls;
}

type FileRow = typeof chatFiles.$inferSelect;

/** A reference row that carries everything needed to open its bytes with the chat's key. */
function isSealedFile(file: FileRow) {
  return (
    file.fileId !== null &&
    file.capsule !== null &&
    file.e2eeParent !== null &&
    file.chatEpoch !== null
  );
}

/** Rows of `workspace` that name `url`: by object key for uploads, `legacy_url` for imports. */
function urlCondition(config: Pick<Config, "SITE_URL">, workspace: string, url: string) {
  const key = storageKeyForUrl(config, url);
  return and(
    eq(chatFiles.workspace, workspace),
    key ? eq(chatFiles.storageKey, key) : eq(chatFiles.legacyUrl, url),
  );
}

/**
 * Gives `chat` a reference to each workspace file in `urls`: a pending upload is attached, a file
 * another chat already references (a fork, a reused attachment) gets its own row. URLs that are
 * not this workspace's files are ignored, so a client cannot attach another workspace's upload.
 *
 * Refused (`E2EE_CONTENT_INVALID`): a historical (`legacy_content`) row, which is tied to its own
 * row id and cannot be attached or copied; with `sealed`, a pending row that is not encrypted;
 * and always, a plaintext row another chat references (plaintext writes are gone).
 *
 * Convex behavior kept: a pending row is not tied to its uploader, so any workspace user who
 * knows the URL can attach it; the URL is an unguessable id that only appears in sealed content.
 *
 * Runs in the caller's transaction (chat create, fork, save).
 */
export async function linkChatFiles(
  tx: Database,
  config: Pick<Config, "SITE_URL">,
  workspace: string,
  chatId: string,
  urls: Iterable<string>,
  options: { sealed?: boolean } = {},
) {
  for (const originalUrl of urls) {
    const url = stripFileFragment(originalUrl);
    const named = urlCondition(config, workspace, url);
    const [own] = await tx
      .select({ id: chatFiles.id })
      .from(chatFiles)
      .where(and(named, eq(chatFiles.chat, chatId)))
      .limit(1);
    if (own) continue;

    const [pending] = await tx
      .select()
      .from(chatFiles)
      .where(and(named, isNull(chatFiles.chat)))
      .limit(1);
    if (pending) {
      // A historical box is tied to its row and original recipient; attaching it cannot grant a chat access.
      if (pending.legacyContent) invalidSealedContent();
      if (options.sealed && !isSealedFile(pending)) invalidSealedContent();
      const attached = await tx
        .update(chatFiles)
        .set({ chat: chatId })
        .where(and(eq(chatFiles.id, pending.id), isNull(chatFiles.chat)))
        .returning({ id: chatFiles.id });
      if (attached.length > 0) continue;
      // Another chat attached it first: reference it as a source below.
    }

    const [source] = await tx
      .select()
      .from(chatFiles)
      .where(and(named, isNotNull(chatFiles.chat)))
      .orderBy(asc(chatFiles.createdAt), asc(chatFiles.id))
      .limit(1);
    if (!source) continue;
    // A sidecar is bound to its own row ID and cannot be copied; the browser re-encrypts a
    // historical attachment as a fresh native upload before it is reused or forked.
    if (source.legacyContent) invalidSealedContent();
    if (!isSealedFile(source) || !source.storageKey) invalidSealedContent();
    await tx
      .insert(chatFiles)
      .values({
        workspace,
        userId: source.userId,
        storageKey: source.storageKey,
        mediaType: source.mediaType,
        filename: source.filename,
        size: source.size,
        fileId: source.fileId,
        capsule: source.capsule,
        chatEpoch: source.chatEpoch,
        e2eeParent: source.e2eeParent,
        chat: chatId,
      })
      .onConflictDoNothing();
  }
}

export type StoredFile = { url: string; storageKey?: string; historical?: boolean };

/**
 * Object keys of this workspace's files among `urls`, for the chat run's model input. A
 * historical attachment has no plaintext object left: it is reported as `historical` so the turn
 * fails explicitly instead of sending its dead URL to a model.
 */
export async function resolveStoredFiles(
  db: Database,
  config: Pick<Config, "SITE_URL">,
  workspace: string,
  urls: Iterable<string>,
): Promise<StoredFile[]> {
  const resolved: StoredFile[] = [];
  for (const url of new Set([...urls].map(stripFileFragment))) {
    const [file] = await db
      .select({ legacyContent: chatFiles.legacyContent, storageKey: chatFiles.storageKey })
      .from(chatFiles)
      .where(urlCondition(config, workspace, url))
      .orderBy(asc(chatFiles.createdAt), asc(chatFiles.id))
      .limit(1);
    if (file?.legacyContent) resolved.push({ url, historical: true });
    else if (file?.storageKey) resolved.push({ url, storageKey: file.storageKey });
  }
  return resolved;
}

/**
 * Queues the release of a chat's stored objects. Call it in the delete-chat transaction BEFORE
 * deleting the chat (the rows go with it by cascade). The `files.release` job deletes each object
 * that no row references any more. Returns the job ids for `dispatchJobs` after commit.
 */
export async function queueChatFileRelease(tx: Database, chatId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ storageKey: chatFiles.storageKey })
    .from(chatFiles)
    .where(and(eq(chatFiles.chat, chatId), isNotNull(chatFiles.storageKey)));
  const keys = rows.map((row) => row.storageKey!);
  const ids: string[] = [];
  for (let start = 0; start < keys.length; start += RELEASE_BATCH) {
    const id = await enqueueJob(tx, {
      kind: FILES_RELEASE_JOB,
      payload: { keys: keys.slice(start, start + RELEASE_BATCH) },
    });
    if (id) ids.push(id);
  }
  return ids;
}

/** Keys among `keys` that some `chat_files` row still references. */
export async function referencedKeys(db: Database, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ storageKey: chatFiles.storageKey })
    .from(chatFiles)
    .where(inArray(chatFiles.storageKey, keys));
  return new Set(rows.map((row) => row.storageKey!));
}

/** Deletes each object in `keys` that no `chat_files` row references; returns how many. */
export async function deleteUnreferencedObjects(runtime: Runtime, keys: string[]): Promise<number> {
  const referenced = await referencedKeys(runtime.drivers.db, keys);
  let deleted = 0;
  for (const key of keys) {
    if (referenced.has(key)) continue;
    await runtime.drivers.objects.delete(key);
    deleted += 1;
  }
  return deleted;
}

/** Handler of the `files.release` outbox job. */
export async function runReleaseJob(runtime: Runtime, payload: unknown) {
  const { keys } = releasePayload.parse(payload);
  await deleteUnreferencedObjects(runtime, keys);
}

/**
 * Whether `userId` may download the object `storageKey`: the uploader of a still-pending upload,
 * or anyone who passes the chat access function for a chat that references it. Personal-chat
 * privacy therefore holds: the workspace owner cannot fetch a member's personal-chat attachment.
 * At most {@link DOWNLOAD_ROW_BOUND} referencing rows are considered, newest first.
 */
export async function authorizeFileDownload(
  db: Database,
  userId: string,
  storageKey: string,
): Promise<boolean> {
  const rows = await db
    .select({ chat: chatFiles.chat, userId: chatFiles.userId })
    .from(chatFiles)
    .where(eq(chatFiles.storageKey, storageKey))
    .orderBy(desc(chatFiles.createdAt), desc(chatFiles.id))
    .limit(DOWNLOAD_ROW_BOUND);
  for (const row of rows) {
    if (row.chat === null) {
      if (row.userId === userId) return true;
    } else if (await chatAccess(db, userId, row.chat)) {
      return true;
    }
  }
  return false;
}

/**
 * The object key of an imported Convex file URL, if the user may download it: a row with that
 * `legacy_url` in a workspace the user can reach, authorized like any other download.
 */
export async function resolveLegacyDownload(
  db: Database,
  userId: string,
  url: string,
): Promise<string | null> {
  const workspaces = (await listWorkspaces(db, userId)).map((workspace) => workspace.id);
  if (workspaces.length === 0) return null;
  const rows = await db
    .select({ storageKey: chatFiles.storageKey, chat: chatFiles.chat, userId: chatFiles.userId })
    .from(chatFiles)
    .where(
      and(
        inArray(chatFiles.workspace, workspaces),
        eq(chatFiles.legacyUrl, stripFileFragment(url)),
        isNotNull(chatFiles.storageKey),
      ),
    )
    .orderBy(desc(chatFiles.createdAt), desc(chatFiles.id))
    .limit(DOWNLOAD_ROW_BOUND);
  for (const row of rows) {
    if (row.chat === null ? row.userId === userId : await chatAccess(db, userId, row.chat)) {
      return row.storageKey;
    }
  }
  return null;
}
