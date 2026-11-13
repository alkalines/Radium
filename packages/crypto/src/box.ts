import type { AadParts } from "./aad";
import { assertLength, bufferSource, concatBytes, lengthPrefixed, utf8 } from "./encoding";
import { openSym, sealSym } from "./envelope";
import { CryptoError } from "./errors";
import { createCapsule, deriveObjectKey, openCapsule, type Capsule } from "./kem";
import { assertSupportedSuite, KEY_ID_BYTES } from "./suite";

const ENCAPSULATED_BYTES = 1120;
const SEALED_CAPSULE_KEY_BYTES = 48;

/** Encoded capsule: suite(1) ‖ capsuleId(16) ‖ encapsulated(1120) ‖ sealedKey(48). */
export const CAPSULE_BYTES = 1 + KEY_ID_BYTES + ENCAPSULATED_BYTES + SEALED_CAPSULE_KEY_BYTES;

/** Serializes a capsule for storage (`e2ee_capsules.capsule`, the head of a sealed box). */
export function encodeCapsule(capsule: Capsule): Uint8Array {
  assertLength(capsule.capsuleId, KEY_ID_BYTES, "capsuleId");
  assertLength(capsule.encapsulated, ENCAPSULATED_BYTES, "encapsulated");
  assertLength(capsule.sealedKey, SEALED_CAPSULE_KEY_BYTES, "sealedKey");
  return concatBytes(
    Uint8Array.of(capsule.suite),
    capsule.capsuleId,
    capsule.encapsulated,
    capsule.sealedKey,
  );
}

/**
 * Parses an encoded capsule. Throws `BAD_ENVELOPE` for a wrong length and `UNSUPPORTED_SUITE` for a
 * suite this package cannot open. Returned fields are copies.
 */
export function decodeCapsule(bytes: Uint8Array): Capsule {
  if (bytes.length !== CAPSULE_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed capsule");
  }
  const suite = bytes[0]!;
  assertSupportedSuite(suite);
  let offset = 1;
  const capsuleId = bytes.slice(offset, offset + KEY_ID_BYTES);
  offset += KEY_ID_BYTES;
  const encapsulated = bytes.slice(offset, offset + ENCAPSULATED_BYTES);
  offset += ENCAPSULATED_BYTES;
  const sealedKey = bytes.slice(offset);
  return { suite, capsuleId, encapsulated, sealedKey };
}

/** The object key of `aad.record`/`aad.field` under a capsule key (`deriveObjectKey` on the AAD's names). */
export function objectKeyFor(capsuleKey: Uint8Array, aad: AadParts): Promise<Uint8Array> {
  return deriveObjectKey({ capsuleKey, table: aad.table, recordId: aad.record, field: aad.field });
}

/**
 * Encrypts one object of a write batch under its object key: `kind: capsule`, `keyRef` = the capsule
 * ID. All objects of one batch share the capsule; `aad.record`/`aad.field` must be unique per object.
 * Uses randomness (nonce).
 */
export async function sealWithCapsule(input: {
  capsuleKey: Uint8Array;
  capsuleId: Uint8Array;
  plaintext: Uint8Array;
  aad: AadParts;
  pad?: "short" | "content" | "none";
}): Promise<Uint8Array> {
  return sealSym({
    key: await objectKeyFor(input.capsuleKey, input.aad),
    keyRef: input.capsuleId,
    plaintext: input.plaintext,
    aad: input.aad,
    kind: "capsule",
    pad: input.pad,
  });
}

/** Opens a `sealWithCapsule` envelope with the capsule key. Throws as `openSym`. */
export async function openWithCapsule(input: {
  capsuleKey: Uint8Array;
  envelope: Uint8Array;
  aad: AadParts;
  pad?: "short" | "content" | "none";
}): Promise<Uint8Array> {
  return openSym({
    key: await objectKeyFor(input.capsuleKey, input.aad),
    envelope: input.envelope,
    aad: input.aad,
    pad: input.pad,
  });
}

/**
 * A self-contained sealed object: a fresh capsule to `recipientPublicKey` followed by one envelope
 * under the derived object key, both bound to `aad`. Used for single objects (grants, chat key wraps,
 * titles, queued prompts). Uses randomness.
 */
export async function sealBox(input: {
  recipientPublicKey: Uint8Array;
  plaintext: Uint8Array;
  aad: AadParts;
  pad?: "short" | "content" | "none";
}): Promise<Uint8Array> {
  const { capsule, capsuleKey } = await createCapsule({
    recipientPublicKey: input.recipientPublicKey,
    aad: input.aad,
  });
  const envelope = await sealWithCapsule({
    capsuleKey,
    capsuleId: capsule.capsuleId,
    plaintext: input.plaintext,
    aad: input.aad,
    pad: input.pad,
  });
  capsuleKey.fill(0);
  return concatBytes(encodeCapsule(capsule), envelope);
}

/**
 * Opens a `sealBox` result with the recipient's encryption seed. Throws `BAD_ENVELOPE` for a
 * malformed box (including an envelope whose keyRef is not the capsule's ID) and `DECRYPT_FAILED`
 * for a wrong key, AAD or any modified byte.
 */
export async function openBox(input: {
  seed: Uint8Array;
  box: Uint8Array;
  aad: AadParts;
  pad?: "short" | "content" | "none";
}): Promise<Uint8Array> {
  if (input.box.length <= CAPSULE_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed box");
  }
  const capsule = decodeCapsule(input.box.subarray(0, CAPSULE_BYTES));
  const envelope = input.box.subarray(CAPSULE_BYTES);
  // keyRef sits after version, suite and kind; it must name this box's own capsule.
  const keyRef = envelope.subarray(3, 3 + KEY_ID_BYTES);
  if (keyRef.length !== KEY_ID_BYTES || !keyRef.every((byte, i) => byte === capsule.capsuleId[i])) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed box");
  }
  const capsuleKey = await openCapsule({ seed: input.seed, capsule, aad: input.aad });
  try {
    return await openWithCapsule({ capsuleKey, envelope, aad: input.aad, pad: input.pad });
  } finally {
    capsuleKey.fill(0);
  }
}

/** SHA-256 digest. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(bytes)));
}

/**
 * HMAC-SHA-256 of the length-prefixed `parts` under `key` (access link and workspace phrase join
 * proofs). `key` must be a 32-byte derived key, never a password.
 */
export async function hmacSha256(key: Uint8Array, parts: Uint8Array[]): Promise<Uint8Array> {
  assertLength(key, 32, "key");
  const imported = await crypto.subtle.importKey(
    "raw",
    bufferSource(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", imported, bufferSource(lengthPrefixed(parts)));
  return new Uint8Array(mac);
}

/** UTF-8 of a decimal integer, the encoding of epochs and versions inside statements. */
export function decimal(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CryptoError("BAD_INPUT", "Invalid integer");
  }
  return utf8(String(value));
}
