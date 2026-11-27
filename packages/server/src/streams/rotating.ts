import type { Kv } from "../drivers/types";
import { newId } from "../db/ids";
import { kvRun, kvScript } from "../kv";
import type { StreamServer } from "./server";

/**
 * Rotating streams (`docs/Backend_Migration/Live_Data.md`, Durable Streams): user and workspace
 * events, Worker inboxes and chat signals live at `<scope>/<gen>`, for example
 * `u/<user>/events/<gen>`. The protocol says a deleted path should not be reused, so each scope
 * moves to a new generation instead of being truncated.
 *
 * Valkey keeps the bookkeeping, all of which can be lost without losing data (the streams only
 * carry topic names and ids; readers resync on a new generation):
 *
 * - `streams:gen:<scope>`: the scope's current generation, created by the first reader;
 * - `streams:live`: sorted set of current `<scope>/<gen>` paths by creation time;
 * - `streams:retired`: closed paths by retirement time, deleted a day later.
 *
 * {@link rotateStreams} retires generations older than a day: it closes them with a final
 * `{topic: "rotate"}` message, which sends readers back for the current generation, and the next
 * reader creates a new one. A scope nobody reads gets no new stream.
 */

/** Rotating scopes: `<kind>/<id>/<name>`. */
export type StreamScope =
  | `u/${string}/events`
  | `w/${string}/events`
  | `k/${string}/inbox`
  | `c/${string}/signals`;

/** Age at which a generation is retired, and how long a retired one stays readable. */
export const STREAM_GENERATION_MS = 24 * 60 * 60_000;
/**
 * Sliding expiry of a rotating stream: the backstop if the bookkeeping is lost (expiry hides a
 * stream; its bytes stay until a delete, task 14 Phase 0).
 */
const ROTATING_TTL_SECONDS = 3 * 24 * 60 * 60;
/** Generations one batch retires or deletes. */
const ROTATION_BATCH = 200;
/** Time one rotation run keeps draining; under its five-minute lease. */
const ROTATION_BUDGET_MS = 3 * 60_000;
/** The final message of a retired generation. */
export const ROTATE_EVENT = { topic: "rotate" } as const;

const generationKey = (scope: string) => `streams:gen:${scope}`;
const LIVE_KEY = "streams:live";
const RETIRED_KEY = "streams:retired";

/**
 * KEYS[1] generation key, KEYS[2] live set; ARGV scope, candidate generation. Returns the current
 * generation, registering the candidate when there is none, so concurrent first readers agree.
 */
const CURRENT_GENERATION = kvScript(`
local current = redis.call('GET', KEYS[1])
if current then
  return current
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], now, ARGV[1] .. '/' .. ARGV[2])
return ARGV[2]
`);

/**
 * KEYS[1] live set, KEYS[2] retired set, KEYS[3] generation key; ARGV path, generation, now (ms).
 * Moves `path` from live to retired and clears the scope's current generation if it is still this
 * one. Retirement is stamped with the caller's clock, the same one its deletion cutoff uses.
 */
const RETIRE_GENERATION = kvScript(`
if redis.call('GET', KEYS[3]) == ARGV[2] then
  redis.call('DEL', KEYS[3])
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`);

/**
 * The current stream of `scope` for a reader: created on first use (an idempotent `PUT`, so
 * racing readers are fine). Readers that find it closed or missing later ask again.
 */
export async function currentStream(kv: Kv, streams: StreamServer, scope: StreamScope): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const generation = String(
      await kvRun(kv, CURRENT_GENERATION, [generationKey(scope), LIVE_KEY], [scope, newId().replaceAll("-", "")]),
    );
    const path = `${scope}/${generation}`;
    if (await streams.create(path, { ttlSeconds: ROTATING_TTL_SECONDS })) return path;
    // Closed by a rotation that ran between the lookup and the create: retire it here too, so
    // the next lookup registers a new generation.
    await kvRun(kv, RETIRE_GENERATION, [LIVE_KEY, RETIRED_KEY, generationKey(scope)], [path, generation, String(Date.now())]);
  }
  throw new Error("No current stream");
}

/**
 * Current streams of `scopes` for a writer, in one round trip; scopes nobody has read yet are
 * left out (there is nobody to tell).
 */
export async function existingStreams(kv: Kv, scopes: readonly StreamScope[]): Promise<string[]> {
  if (scopes.length === 0) return [];
  const generations = (await kv.send("MGET", scopes.map(generationKey))) as unknown[];
  const paths: string[] = [];
  scopes.forEach((scope, index) => {
    const generation = generations[index];
    if (typeof generation === "string") paths.push(`${scope}/${generation}`);
  });
  return paths;
}

/**
 * Retires generations older than {@link STREAM_GENERATION_MS} and deletes those retired that long
 * ago (`streams:rotate` task, every five minutes). Each phase drains in batches until it is done
 * or {@link ROTATION_BUDGET_MS} has passed; a batch with a failure ends its phase, and the next
 * run retries it.
 *
 * A generation is closed (with its `rotate` message) before it leaves the live set, so a failed
 * close never leaves readers on a generation writers have stopped using. A reader that creates
 * the scope in between finds it closed and retires it itself (`currentStream`).
 */
export async function rotateStreams(kv: Kv, streams: StreamServer, now: number) {
  const cutoff = String(now - STREAM_GENERATION_MS);
  const started = Date.now();
  const inBudget = () => Date.now() - started < ROTATION_BUDGET_MS;
  const due = async (key: string) =>
    ((await kv.send("ZRANGEBYSCORE", [key, "-inf", cutoff, "LIMIT", "0", String(ROTATION_BATCH)])) as unknown[]).map(
      String,
    );

  let retired = 0;
  let complete = false;
  while (!complete && inBudget()) {
    const batch = await due(LIVE_KEY);
    complete = batch.length < ROTATION_BATCH;
    for (const member of batch) {
      const slash = member.lastIndexOf("/");
      try {
        await streams.append(member, [ROTATE_EVENT], { close: true });
      } catch {
        console.error("streams: generation not closed");
        complete = true;
        continue;
      }
      await kvRun(
        kv,
        RETIRE_GENERATION,
        [LIVE_KEY, RETIRED_KEY, generationKey(member.slice(0, slash))],
        [member, member.slice(slash + 1), String(now)],
      );
      retired++;
    }
  }

  let deleted = 0;
  complete = false;
  while (!complete && inBudget()) {
    const batch = await due(RETIRED_KEY);
    complete = batch.length < ROTATION_BATCH;
    for (const member of batch) {
      try {
        await streams.delete(member);
      } catch {
        console.error("streams: retired generation not deleted");
        complete = true;
        continue;
      }
      await kv.send("ZREM", [RETIRED_KEY, member]);
      deleted++;
    }
  }
  return { retired, deleted };
}
