import type { Kv } from "../drivers/types";
import { kvDelete, kvRun, kvScript } from "../kv";

/**
 * Worker presence (Convex `worker_presence`), a Valkey hash per Worker: `presence:<worker>` with
 * `at` (server time of the last heartbeat, epoch ms) and `dir` (the Worker's reported temp
 * directory). Presence is advisory display state (`contracts/worker/presence`): online means a
 * report within the online window. The hash lives for a week so "last seen" and the chat
 * temp-directory fallback survive the way Convex's durable row did; every heartbeat refreshes it.
 */

/** Expiry of a Worker's presence; each heartbeat restarts it. */
export const WORKER_PRESENCE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Bound on a reported temp directory (an absolute host path). */
export const WORKER_TEMP_DIRECTORY_MAX = 4096;

/** At most this many Workers per presence read. */
export const WORKER_PRESENCE_READ_MAX = 500;

const presenceKey = (worker: string) => `presence:${worker}`;

/** KEYS[1] presence hash; ARGV dir, ttl. Stamps server time, so Worker clocks never matter. */
const REPORT_PRESENCE = kvScript(`
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('HSET', KEYS[1], 'at', now, 'dir', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return now
`);

/** KEYS presence hashes; answers `{at, dir}` per key in one round trip. */
const READ_PRESENCE = kvScript(`
local result = {}
for index, key in ipairs(KEYS) do
  result[index] = redis.call('HMGET', key, 'at', 'dir')
end
return result
`);

/** Records a heartbeat of `worker` with its temp directory; returns the stamped time. */
export async function reportWorkerPresence(
  kv: Kv,
  worker: string,
  tempDirectory: string,
): Promise<number> {
  return Number(
    await kvRun(kv, REPORT_PRESENCE, [presenceKey(worker)], [tempDirectory, String(WORKER_PRESENCE_TTL_MS)]),
  );
}

/**
 * Last heartbeat and temp directory of each of `workerIds` that reported within the presence
 * TTL; Workers without presence are absent. One round trip.
 */
export async function workerPresence(
  kv: Kv,
  workerIds: readonly string[],
): Promise<Map<string, { lastSeenAt: number; tempDirectory: string }>> {
  const presence = new Map<string, { lastSeenAt: number; tempDirectory: string }>();
  const ids = [...new Set(workerIds)];
  if (ids.length === 0) return presence;
  if (ids.length > WORKER_PRESENCE_READ_MAX) {
    throw new Error("Too many Workers in one presence read");
  }
  const rows = (await kvRun(kv, READ_PRESENCE, ids.map(presenceKey), [])) as unknown[];
  ids.forEach((id, index) => {
    const row = rows[index];
    if (!Array.isArray(row)) return;
    const [at, dir] = row as unknown[];
    const lastSeenAt = Number(at);
    if (typeof dir !== "string" || at === null || !Number.isSafeInteger(lastSeenAt)) return;
    presence.set(id, { lastSeenAt, tempDirectory: dir });
  });
  return presence;
}

/** Forgets `worker`'s presence (revocation). */
export async function deleteWorkerPresence(kv: Kv, worker: string): Promise<void> {
  await kvDelete(kv, presenceKey(worker));
}
