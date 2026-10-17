import { ConvexError } from "convex/values";
import type { Infer } from "convex/values";
import type { publicKey } from "./contracts.js";

/** Throw a Convex error with a stable machine-readable code. */
export function fail(code: string): never {
  throw new ConvexError({ code });
}

/** Require a non-empty string no longer than the supplied character limit. */
export function boundedString(value: string, max = 256) {
  if (value.length === 0 || value.length > max) fail("INVALID_ARGUMENT");
}

/** Require the lowercase hexadecimal SHA-256 digest used as an enrollment selector. */
export function validateTokenHash(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) fail("INVALID_TOKEN_HASH");
}

/** Enforce the component's storage bounds for normalized public-key fields. */
export function validatePublicKey(key: Infer<typeof publicKey>) {
  boundedString(key.algorithm, 32);
  boundedString(key.material, 4096);
  boundedString(key.thumbprint, 256);
}

/** Require a bounded first-page or cleanup batch size between 1 and 100. */
export function validateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("INVALID_LIMIT");
}
