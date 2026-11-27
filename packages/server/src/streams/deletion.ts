import { z } from "zod";
import type { Database } from "../drivers/types";
import { enqueueJob } from "../jobs/outbox";
import type { Runtime } from "../runtime";
import { isStreamPath } from "./server";

/**
 * Durable deletion of streams whose owner row is deleted in a transaction (a chat's run and ACP
 * epoch streams when the chat is deleted). Expiry would hide them but keep their bytes on disk
 * (task 14, Phase 0), so the deletion is an outbox job written in the same transaction.
 */

/** Outbox job: delete the streams named in the payload. */
export const STREAMS_DELETE_JOB = "streams.delete";

const MAX_PATHS = 100;
const deletePayload = z.object({ paths: z.array(z.string().refine(isStreamPath)).max(MAX_PATHS) });

/**
 * Queues the deletion of `paths` in the caller's transaction; returns the job ids to dispatch
 * after commit (none when there is nothing to delete).
 */
export async function queueStreamDeletion(tx: Database, paths: readonly string[]): Promise<(string | null)[]> {
  const jobs: (string | null)[] = [];
  for (let start = 0; start < paths.length; start += MAX_PATHS) {
    jobs.push(
      await enqueueJob(tx, { kind: STREAMS_DELETE_JOB, payload: { paths: paths.slice(start, start + MAX_PATHS) } }),
    );
  }
  return jobs;
}

/** How long a deletion the stream server refused waits before the next try. */
const RETRY_DELAY_MS = 15 * 60_000;

/**
 * Outbox handler of {@link STREAMS_DELETE_JOB}; deleting a missing stream succeeds, so retries
 * are safe. Streams that cannot be deleted now are queued again as a new job instead of failing
 * this one: an outbox job is parked after its last attempt, and a parked deletion would leave a
 * deleted chat's plaintext run stream on disk for good (nothing else still knows its path).
 */
export async function runStreamsDeleteJob(runtime: Runtime, payload: unknown) {
  const { paths } = deletePayload.parse(payload);
  const failed: string[] = [];
  for (const path of paths) {
    try {
      await runtime.streams.delete(path);
    } catch {
      failed.push(path);
    }
  }
  if (failed.length > 0) {
    console.error("streams: deletion deferred");
    await enqueueJob(runtime.drivers.db, {
      kind: STREAMS_DELETE_JOB,
      payload: { paths: failed },
      runAt: new Date(Date.now() + RETRY_DELAY_MS),
    });
  }
}
