import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { defineTask } from "nitro/task";
import { chatFiles } from "../../chatroom/schema";
import {
  deleteUnreferencedObjects,
  PENDING_UPLOAD_TTL_MS,
} from "../../chatroom/files";
import { kvDelete, kvGet, kvSet } from "../../kv";
import { useProcessRuntime, type Runtime } from "../../runtime";
import { claimLease } from "../lease";

/** Pending rows removed per run; a backlog drains over the following runs. */
const PENDING_BATCH = 200;
/** Objects listed per page and pages per run. */
const LIST_PAGE = 200;
const LIST_PAGES = 5;
const CURSOR_KEY = "files-orphans:cursor";
const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One orphan pass: (a) pending attachments never sent, older than the TTL, and their objects when
 * nothing else references them; (b) `chat/` objects older than the TTL that no row references
 * (uploads never registered, failed release jobs), scanned from a cursor kept in Valkey. Never
 * touches `files/` keys: imported sidecar envelopes are referenced from many tables.
 */
export async function runFileOrphans(runtime: Runtime, now = Date.now()) {
  const { db, kv, objects } = runtime.drivers;
  const cutoff = new Date(now - PENDING_UPLOAD_TTL_MS);

  // Imported pending rows carrying a sidecar are history, not abandoned uploads.
  const pending = await db
    .select({ id: chatFiles.id, storageKey: chatFiles.storageKey })
    .from(chatFiles)
    .where(
      and(isNull(chatFiles.chat), isNull(chatFiles.legacyContent), lt(chatFiles.createdAt, cutoff)),
    )
    .orderBy(asc(chatFiles.createdAt), asc(chatFiles.id))
    .limit(PENDING_BATCH);
  const removed: string[] = [];
  const keys: string[] = [];
  for (const row of pending) {
    // Attached since the read: no longer pending, keep it.
    const [gone] = await db
      .delete(chatFiles)
      .where(and(eq(chatFiles.id, row.id), isNull(chatFiles.chat)))
      .returning({ id: chatFiles.id });
    if (!gone) continue;
    removed.push(row.id);
    if (row.storageKey?.startsWith("chat/")) keys.push(row.storageKey);
  }
  const pendingObjects = await deleteUnreferencedObjects(runtime, keys);

  let cursor = await kvGet(kv, CURSOR_KEY);
  let unreferenced = 0;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const listed = await objects.list({ prefix: "chat/", cursor, limit: LIST_PAGE });
    const old = listed.keys
      .filter((object) => object.lastModified.getTime() < cutoff.getTime())
      .map((object) => object.key);
    unreferenced += await deleteUnreferencedObjects(runtime, old);
    cursor = listed.cursor;
    if (cursor === null) break;
  }
  if (cursor === null) await kvDelete(kv, CURSOR_KEY);
  else await kvSet(kv, CURSOR_KEY, cursor, { ttlMs: CURSOR_TTL_MS });

  return { pendingRows: removed.length, objects: pendingObjects + unreferenced };
}

/** Runs hourly (`nitro.config.ts`); the lease lets one replica run each interval. */
export default defineTask<
  { pendingRows: number; objects: number } | { skipped: true }
>({
  meta: { name: "files:orphans", description: "Delete abandoned chat uploads" },
  async run() {
    const runtime = await useProcessRuntime();
    if (!(await claimLease(runtime.drivers.kv, "files:orphans", 55 * 60_000))) {
      return { result: { skipped: true } };
    }
    return { result: await runFileOrphans(runtime) };
  },
});
