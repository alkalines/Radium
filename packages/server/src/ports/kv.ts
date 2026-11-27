/**
 * Sends one raw command to Valkey and resolves with its reply. Adapters wrap `Bun.redis.send` or
 * `ioredis.call`; both return strings, numbers, `null` and nested arrays for the commands used here.
 * Map replies differ (Bun speaks RESP3 and returns objects, ioredis returns flat arrays), so
 * callers of map-returning commands must normalize.
 */
export type RedisCommand = (command: string, args: string[]) => Promise<unknown>;

/** A Lua script run with `EVALSHA`, falling back to `EVAL` once per server after a script flush or restart. */
export interface KvScript {
  readonly source: string;
  sha1(): Promise<string>;
}

/** Key/value access to Valkey shared by every runtime. Keys are global: callers own their prefixes. */
export interface Kv {
  get(key: string): Promise<string | null>;
  /**
   * Stores `value`. With `onlyIfAbsent`, resolves `false` when the key already existed and leaves it
   * untouched; otherwise always resolves `true`.
   */
  set(
    key: string,
    value: string,
    options?: { ttlMs?: number; onlyIfAbsent?: boolean },
  ): Promise<boolean>;
  /** Deletes keys; resolves with how many existed. */
  delete(...keys: string[]): Promise<number>;
  /** Atomically increments an integer key (missing counts as 0) and resolves with the new value. */
  increment(key: string): Promise<number>;
  /** Sets a time to live; resolves `false` when the key does not exist. */
  expire(key: string, ttlMs: number): Promise<boolean>;
  /** Runs a Lua script atomically. */
  eval(script: KvScript, keys: string[], args: string[]): Promise<unknown>;
  /** Raw command for operations without a typed helper (streams, pings). */
  command: RedisCommand;
}

/** Declares a Lua script once at module level so its SHA-1 is computed once per process. */
export function defineScript(source: string): KvScript {
  let digest: Promise<string> | undefined;

  return {
    source,
    sha1() {
      digest ??= crypto.subtle.digest("SHA-1", new TextEncoder().encode(source)).then((buffer) => {
        return Array.from(new Uint8Array(buffer), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      });
      return digest;
    },
  };
}

export function createKv(command: RedisCommand): Kv {
  return {
    async get(key) {
      return (await command("GET", [key])) as string | null;
    },

    async set(key, value, options = {}) {
      const args = [key, value];
      if (options.ttlMs !== undefined) args.push("PX", String(options.ttlMs));
      if (options.onlyIfAbsent) args.push("NX");
      return (await command("SET", args)) === "OK";
    },

    async delete(...keys) {
      if (keys.length === 0) return 0;
      return Number(await command("DEL", keys));
    },

    async increment(key) {
      return Number(await command("INCR", [key]));
    },

    async expire(key, ttlMs) {
      return Number(await command("PEXPIRE", [key, String(ttlMs)])) === 1;
    },

    async eval(script, keys, args) {
      const tail = [String(keys.length), ...keys, ...args];
      try {
        return await command("EVALSHA", [await script.sha1(), ...tail]);
      } catch (error) {
        // The script cache is empty after a Valkey restart or SCRIPT FLUSH; EVAL reloads it.
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        return await command("EVAL", [script.source, ...tail]);
      }
    },

    command,
  };
}
