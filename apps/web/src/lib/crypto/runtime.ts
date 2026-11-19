import type { ConvexReactClient } from "convex/react";
import { CryptoError, randomBytes, toBase64Url } from "radium-crypto";
import { keyManager, KeysLockedError } from "./key-manager";
let client: ConvexReactClient | null = null;
const clearers = new Set<() => void>();
let previousUser: string | null = null;
let subscribed = false;
let generation = 0;
/** Binds the existing authenticated client; no second transport or query cache is created. */
export function configureCryptoClient(value: ConvexReactClient): void {
  client = value;
  if (subscribed) return;
  subscribed = true;
  keyManager.subscribe(() => {
    const status = keyManager.getSnapshot();
    const userId = "userId" in status ? status.userId : null;
    if (status.state !== "unlocked" || userId !== previousUser) {
      generation++;
      for (const clear of clearers) clear();
    }
    if (previousUser && userId !== previousUser) {
      try {
        localStorage.removeItem(`radium.e2ee.pub.v1:${previousUser}`);
      } catch {
        /* Storage may be disabled. */
      }
    }
    previousUser = userId;
  });
}
/** Uses the application's authenticated Convex client. */
export function cryptoClient(): ConvexReactClient {
  if (!client) throw new CryptoError("BAD_INPUT", "Encryption client is not mounted");
  return client;
}
/** Returns the key manager's signed-in identity, including while locked. */
export function currentUserId(): string {
  const status = keyManager.getSnapshot();
  if (!("userId" in status)) throw new KeysLockedError();
  return status.userId;
}
/** Registers secret cleanup on lock, sign-out and account switches. */
export function onSecretsCleared(clear: () => void): void {
  clearers.add(clear);
}
/** Monotonic in-memory lock generation; asynchronous crypto must not refill caches after lock. */
export function secretGeneration(): number {
  return generation;
}
/** Produces a 128-bit unpadded base64url public identifier. */
export function newKeyId(): string {
  return toBase64Url(randomBytes(16));
}
/** Converts Convex bytes to a view without copying. */
export function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
/** Produces an exact ArrayBuffer for Convex's bytes validator. */
export function buffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}
/** Reads a non-secret monotonic device marker. */
export function highWater(name: string): number {
  try {
    const n = Number(localStorage.getItem(name));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
/** Advances a non-secret device marker without lowering it. */
export function advanceHighWater(name: string, value: number): void {
  try {
    localStorage.setItem(name, String(Math.max(highWater(name), value)));
  } catch {
    /* New devices cannot detect historical rollback. */
  }
}
