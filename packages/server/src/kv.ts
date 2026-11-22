import type { Kv } from "./drivers/types";

/**
 * Typed Valkey commands over the driver's raw `send`. Only the commands the backend relies on are
 * here; add one when a caller needs it rather than wrapping the whole protocol.
 */

/** Value of `key`, or `null` when it does not exist. */
export async function kvGet(kv: Kv, key: string): Promise<string | null> {
  const value = await kv.send("GET", [key]);
  return typeof value === "string" ? value : null;
}

/** Sets `key`, expiring after `ttlMs`; with `onlyIfAbsent`, returns `false` if it already existed. */
export async function kvSet(
  kv: Kv,
  key: string,
  value: string,
  options: { ttlMs?: number; onlyIfAbsent?: boolean } = {},
): Promise<boolean> {
  const args = [key, value];
  if (options.ttlMs !== undefined) {
    args.push("PX", String(Math.max(1, Math.ceil(options.ttlMs))));
  }
  if (options.onlyIfAbsent) {
    args.push("NX");
  }
  // `SET … NX` answers null when the key exists; plain `SET` always answers OK.
  return (await kv.send("SET", args)) !== null;
}

/** Deletes `key` and returns whether it existed. */
export async function kvDelete(kv: Kv, key: string): Promise<boolean> {
  return Number(await kv.send("DEL", [key])) > 0;
}

/** Atomically reads and deletes `key`: the single-use read behind challenges and handoffs. */
export async function kvTake(kv: Kv, key: string): Promise<string | null> {
  const value = await kv.send("GETDEL", [key]);
  return typeof value === "string" ? value : null;
}

/** A Lua script run with `EVALSHA`, loaded on first use or after a server restart. */
export type KvScript = { source: string; sha: Promise<string> };

/** Declares a script; its SHA-1 (the `EVALSHA` handle) is computed once. */
export function kvScript(source: string): KvScript {
  const sha = crypto.subtle
    .digest("SHA-1", new TextEncoder().encode(source))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  return { source, sha };
}

/**
 * Runs `script` atomically. Uses the cached script and falls back to sending the source only when
 * the server answers `NOSCRIPT` (first use, restart or `SCRIPT FLUSH`).
 */
export async function kvRun(
  kv: Kv,
  script: KvScript,
  keys: string[],
  args: string[],
): Promise<unknown> {
  const tail = [String(keys.length), ...keys, ...args];
  try {
    return await kv.send("EVALSHA", [await script.sha, ...tail]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) {
      throw error;
    }
    return await kv.send("EVAL", [script.source, ...tail]);
  }
}
