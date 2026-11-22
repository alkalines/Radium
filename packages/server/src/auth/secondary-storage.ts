import type { SecondaryStorage } from "@better-auth/core/db";
import type { Kv } from "../drivers/types";
import { kvDelete, kvGet, kvRun, kvScript, kvSet, kvTake } from "../kv";

/**
 * Fixed-window counter: increments KEYS[1] and sets its expiry (ARGV[1], seconds) only when this
 * increment created it, so later increments never extend the window.
 */
const INCREMENT_IN_WINDOW = kvScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`);

/**
 * Better Auth `secondaryStorage` on Valkey: the session cache (Postgres stays the record, see
 * `session.storeSessionInDatabase`), short-lived verification values (OPAQUE login state, reset
 * tokens) and Better Auth's per-address rate-limit counters. Keys are prefixed so they cannot
 * collide with other backend keys.
 */
export function valkeySecondaryStorage(kv: Kv): SecondaryStorage {
  return {
    get: (key) => kvGet(kv, `auth:${key}`),
    getAndDelete: (key) => kvTake(kv, `auth:${key}`),
    async increment(key, ttlSeconds) {
      const ttl = String(Math.max(1, Math.ceil(ttlSeconds)));
      return Number(await kvRun(kv, INCREMENT_IN_WINDOW, [`auth:${key}`], [ttl]));
    },
    async set(key, value, ttlSeconds) {
      await kvSet(kv, `auth:${key}`, value, ttlSeconds ? { ttlMs: ttlSeconds * 1000 } : {});
    },
    async delete(key) {
      await kvDelete(kv, `auth:${key}`);
    },
  };
}
