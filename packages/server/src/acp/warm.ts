import { ACP_WARM_SESSIONS_MAX } from "contracts/acp/contract";
import type { Kv } from "../drivers/types";
import { kvDelete, kvRun, kvScript } from "../kv";

/**
 * Warm ACP sessions (Convex `acp_sessions.warm`/`warmSince`), a Valkey sorted set per Worker:
 * `acp:warm:<worker>`, member the chat id, score the moment it was warmed (server time, ms). A
 * warm session is one the Worker keeps live; the Worker reads its warm set to know which agent
 * sessions to open. Cooling (`acp.cool`, Phase 4) takes chats out again.
 */

/** Safety expiry of an untouched set; every warming refreshes it. */
const WARM_SET_TTL_MS = 24 * 60 * 60_000;

const warmKey = (worker: string) => `acp:warm:${worker}`;

/**
 * KEYS[1] warm set; ARGV chat, cap, ttl. Returns 1 when the chat was already warm, 2 when it was
 * warmed now, 0 when the Worker is at its cap. The cap check and the add are one script, so two
 * concurrent warmings can never both take the last slot.
 */
const ADMIT_WARM = kvScript(`
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 2
`);

/**
 * Warms `chat` on `worker` unless it already is; `false` when the Worker already has
 * `ACP_WARM_SESSIONS_MAX` warm sessions, so its warm list (bounded by the same cap) never silently
 * drops one.
 */
export async function admitWarm(kv: Kv, worker: string, chat: string): Promise<boolean> {
  const result = await kvRun(
    kv,
    ADMIT_WARM,
    [warmKey(worker)],
    [chat, String(ACP_WARM_SESSIONS_MAX), String(WARM_SET_TTL_MS)],
  );
  return Number(result) !== 0;
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

/** Takes `chat` out of `worker`'s warm set (the chat was deleted). */
export async function removeWarm(kv: Kv, worker: string, chat: string): Promise<void> {
  await kv.send("ZREM", [warmKey(worker), chat]);
}

/** Drops every warm session of `worker` (revocation). */
export async function clearWarmSessions(kv: Kv, worker: string): Promise<void> {
  await kvDelete(kv, warmKey(worker));
}
