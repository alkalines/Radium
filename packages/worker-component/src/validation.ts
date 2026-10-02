import { ConvexError } from "convex/values";
import type { Infer } from "convex/values";
import type { publicKey } from "./contracts.js";

export function fail(code: string): never {
  throw new ConvexError({ code });
}

export function boundedString(value: string, max = 256) {
  if (value.length === 0 || value.length > max) fail("INVALID_ARGUMENT");
}

export function validateTokenHash(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) fail("INVALID_TOKEN_HASH");
}

export function validatePublicKey(key: Infer<typeof publicKey>) {
  boundedString(key.algorithm, 32);
  boundedString(key.material, 4096);
  boundedString(key.thumbprint, 256);
}

export function validateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("INVALID_LIMIT");
}
