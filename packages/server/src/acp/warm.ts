import { ACP_COLD_AFTER_MS, ACP_WARM_SESSIONS_MAX } from "contracts/acp/contract";
import type { Kv } from "../drivers/types";
import { kvDelete, kvRun, kvScript } from "../kv";

/*
 * Warm ACP sessions and their viewers (Convex `acp_sessions.warm`/`warmSince` and `chat_viewers`),
 * in Valkey (`docs/Backend_Migration/Live_Data.md`, ACP Sessions):
 *
 * - `acp:warm:<worker>`: sorted set, member the chat id, score when it was warmed (ms). A warm
 *   session is one the Worker keeps live; the Worker reads its warm set to know which agent
 *   sessions to stream. Watching and prompting warm a chat; `acp.cool` takes it out again.
 * - `acp:warm-workers`: the Workers whose warm set may be non-empty, so cooling iterates warm
 *   sets without `KEYS`. Added in the warming script, removed by cooling once a set is empty.
 * - `acp:viewers:<chat>`: sorted set, member a Tab id, score its last heartbeat (ms).
 *
 * Every script takes `now` from the caller, so cooling can be judged against explicit times.
 */

/** Safety expiry of an untouched warm set; every warming refreshes it. */
const WARM_SET_TTL_MS = 24 * 60 * 60_000;
/** Viewer sets outlive their newest heartbeat by the cooling window, then expire. */
const VIEWERS_TTL_MS = 2 * ACP_COLD_AFTER_MS;

const warmKey = (worker: string) => `acp:warm:${worker}`;
const viewersKey = (chat: string) => `acp:viewers:${chat}`;
const WARM_WORKERS = "acp:warm-workers";

/**
 * Lua fragment: warms ARGV[1] in KEYS[1] (the Worker's warm set) at ARGV[3] unless it already is
 * (then a refresh, ARGV[6] = "1", moves its warming time); returns 1 already warm, 2 warmed now,
 * 0 at the cap ARGV[2]. The cap check and the add are one script, so two concurrent warmings can
 * never both take the last slot. KEYS[2] is the warm-Worker set, ARGV[4] the set TTL, ARGV[5]
 * the Worker id.
 */
const WARM_STEP = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  if ARGV[6] == '1' then redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1]) end
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[5])
return 2
`;

const ADMIT_WARM = kvScript(WARM_STEP);

/**
 * KEYS[3] the chat's viewer set; ARGV[7] the Tab, ARGV[8] the stale-viewer cutoff, ARGV[9] the
 * viewer set TTL. Records the heartbeat (dropping Tabs silent past the cooling window, and all but
 * the newest 32 Tabs, since cooling reads only the newest), then warms.
 */
const WATCH = kvScript(`
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[7])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[8])
redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -33)
redis.call('PEXPIRE', KEYS[3], ARGV[9])
${WARM_STEP}
`);

/**
 * KEYS[1] warm set, KEYS[2] viewer set, KEYS[3] warm-Worker set; ARGV chat, cutoff, Worker.
 * Takes the chat out only when it was warmed and last viewed at or before the cutoff, checked in
 * the same script as the removal so a concurrent heartbeat or prompt keeps it warm. Returns 1
 * when cooled.
 */
const COOL = kvScript(`
local since = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not since or tonumber(since) > tonumber(ARGV[2]) then
  return 0
end
local newest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
if newest[2] and tonumber(newest[2]) > tonumber(ARGV[2]) then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[3], ARGV[3])
end
return 1
`);

/** KEYS[1] warm set, KEYS[2] warm-Worker set; forgets the Worker once its warm set is empty. */
const FORGET_IDLE_WORKER = kvScript(`
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
end
return 0
`);

const warmArgs = (worker: string, chat: string, now: number, refresh: boolean) => [
  chat,
  String(ACP_WARM_SESSIONS_MAX),
  String(now),
  String(WARM_SET_TTL_MS),
  worker,
  refresh ? "1" : "0",
];

/**
 * Prompt warming: warms `chat` on `worker`, or moves its warming time to `now` when it already is
 * warm (a prompt is activity that cooling must see). `false` when the Worker already has
 * `ACP_WARM_SESSIONS_MAX` warm sessions, so its warm list (bounded by the same cap) never silently
 * drops one.
 */
export async function admitWarm(kv: Kv, worker: string, chat: string, now = Date.now()): Promise<boolean> {
  const result = await kvRun(kv, ADMIT_WARM, [warmKey(worker), WARM_WORKERS], warmArgs(worker, chat, now, true));
  return Number(result) !== 0;
}

/**
 * A viewer heartbeat of Tab `tab` on `chat`, then warming as {@link admitWarm} does (without
 * moving an existing warming time), in one script.
 *
 * @returns `"warmed"` on a cold → warm transition, `"warm"` when it already was, `"full"` when
 *   the Worker is at its warm cap (the heartbeat is still recorded).
 */
export async function watchWarm(
  kv: Kv,
  input: { worker: string; chat: string; tab: string; now: number },
): Promise<"warmed" | "warm" | "full"> {
  const result = Number(
    await kvRun(
      kv,
      WATCH,
      [warmKey(input.worker), WARM_WORKERS, viewersKey(input.chat)],
      [
        ...warmArgs(input.worker, input.chat, input.now, false),
        input.tab,
        String(input.now - ACP_COLD_AFTER_MS),
        String(VIEWERS_TTL_MS),
      ],
    ),
  );
  return result === 2 ? "warmed" : result === 1 ? "warm" : "full";
}

/** Whether `chat` is warm on `worker`. */
export async function isWarm(kv: Kv, worker: string, chat: string): Promise<boolean> {
  return (await kv.send("ZSCORE", [warmKey(worker), chat])) !== null;
}

/** The warm chats of `worker`, oldest warming first (at most the cap). */
export async function warmChats(kv: Kv, worker: string): Promise<string[]> {
  const members = (await kv.send("ZRANGE", [
    warmKey(worker),
    "0",
    String(ACP_WARM_SESSIONS_MAX - 1),
  ])) as unknown[];
  return members.map(String);
}

/**
 * One page of the Workers that may hold warm sessions (`SSCAN`); `cursor` `"0"` starts over and
 * comes back once the whole set was visited.
 */
export async function warmWorkersPage(kv: Kv, cursor: string): Promise<{ cursor: string; workers: string[] }> {
  const [next, members] = (await kv.send("SSCAN", [WARM_WORKERS, cursor, "COUNT", "100"])) as [unknown, unknown[]];
  return { cursor: String(next), workers: members.map(String) };
}

/**
 * The chats of `worker` warmed at or before `cutoff` (cooling candidates), or none, in which case
 * an empty warm set also drops the Worker from the warm-Worker set.
 */
export async function coolingCandidates(kv: Kv, worker: string, cutoff: number): Promise<string[]> {
  const members = (await kv.send("ZRANGEBYSCORE", [
    warmKey(worker),
    "-inf",
    String(cutoff),
    "LIMIT",
    "0",
    String(ACP_WARM_SESSIONS_MAX),
  ])) as unknown[];
  if (members.length === 0) await kvRun(kv, FORGET_IDLE_WORKER, [warmKey(worker), WARM_WORKERS], [worker]);
  return members.map(String);
}

/**
 * Cools `chat` on `worker` when it was warmed and last viewed at or before `cutoff`; `false` when
 * a heartbeat or prompt since then keeps it warm (or it already is cold).
 */
export async function coolWarm(kv: Kv, worker: string, chat: string, cutoff: number): Promise<boolean> {
  const result = await kvRun(
    kv,
    COOL,
    [warmKey(worker), viewersKey(chat), WARM_WORKERS],
    [chat, String(cutoff), worker],
  );
  return Number(result) === 1;
}

/** Takes `chat` out of `worker`'s warm set and drops its viewers (the chat was deleted). */
export async function removeWarm(kv: Kv, worker: string, chat: string): Promise<void> {
  await kv.send("ZREM", [warmKey(worker), chat]);
  await kvDelete(kv, viewersKey(chat));
}

/** Drops every warm session of `worker` (revocation). */
export async function clearWarmSessions(kv: Kv, worker: string): Promise<void> {
  await kvDelete(kv, warmKey(worker));
  await kv.send("SREM", [WARM_WORKERS, worker]);
}
