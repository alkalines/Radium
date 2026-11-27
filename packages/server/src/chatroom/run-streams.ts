import { eq } from "drizzle-orm";
import type { Database, Kv } from "../drivers/types";
import { kvSet } from "../kv";
import { chatRuns } from "./schema";

/**
 * Names shared by the built-in run generator (`./run.ts`) and the paths that end runs from
 * outside it (chat deletion, `chats.stop`).
 */

/** The stream of run `runId` of chat `chatId`. */
export function runStreamPath(chatId: string, runId: string) {
  return `c/${chatId}/runs/${runId}`;
}

/** Valkey flag a running generator polls; set by `chats.stop` and chat deletion. */
export function runStopKey(runId: string) {
  return `chat:stop:${runId}`;
}

/** Longest a stop flag can matter: past it the run has ended or its lease has gone stale. */
const STOP_FLAG_TTL_MS = 10 * 60_000;

/** Asks run `runId`'s generator to stop at its next poll. */
export async function requestRunStop(kv: Kv, runId: string) {
  await kvSet(kv, runStopKey(runId), "1", { ttlMs: STOP_FLAG_TTL_MS });
}

/** The runs of chat `chatId` that still have a stream (ended runs are kept until retention). */
export async function chatRunsWithStreams(db: Database, chatId: string) {
  const rows = await db
    .select({ id: chatRuns.id, status: chatRuns.status })
    .from(chatRuns)
    .where(eq(chatRuns.chat, chatId));
  return rows.map((row) => ({ ...row, path: runStreamPath(chatId, row.id) }));
}
