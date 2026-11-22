import type { Kv } from "../drivers/types";
import { kvRun, kvScript } from "../kv";

/**
 * Token bucket in one Valkey hash. Refills continuously at `capacity` tokens per `period` ms and
 * expires once it would be full again, so an idle key costs nothing. Time comes from the Valkey
 * server, so replicas with skewed clocks share one budget.
 *
 * KEYS[1] bucket; ARGV capacity, period (ms), cost. Returns 1 when the cost was taken.
 */
const TOKEN_BUCKET = kvScript(`
local capacity = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1]) or capacity
local at = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + (now - at) * capacity / period)
local taken = tokens >= cost
if taken then
  tokens = tokens - cost
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], period)
if taken then
  return 1
end
return 0
`);

/** A named budget: at most `capacity` at once, refilled to full over `periodMs`. */
export type RateLimit = { name: string; capacity: number; periodMs: number };

/**
 * Takes one token from `limit`'s bucket for `key`. `false` means the caller is over budget and
 * must refuse the request. Callers pass keys that are already non-identifying where that matters
 * (hashes, not emails), since keys are visible to anyone with Valkey access.
 */
export async function takeToken(kv: Kv, limit: RateLimit, key: string): Promise<boolean> {
  const result = await kvRun(
    kv,
    TOKEN_BUCKET,
    [`ratelimit:${limit.name}:${key}`],
    [String(limit.capacity), String(limit.periodMs), "1"],
  );
  return Number(result) === 1;
}
