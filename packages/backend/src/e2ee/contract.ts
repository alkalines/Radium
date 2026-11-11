import { v } from "convex/values";
import {
  AMK_WRAPPER_BYTES,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  fromBase64Url,
  IDENTITY_SECRETS_BYTES,
  KEY_ID_BYTES,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  SUITE_1,
  toBase64Url,
} from "radium-crypto";
import * as z from "zod";

/**
 * Wire format of the account key bundle the OPAQUE plugin carries as its app payload
 * (docs/E2EE/Keys.md, "Account"). Every value is ciphertext or public key material: the server
 * never receives the AMK, a private seed, an export key or a password. Byte values travel as
 * unpadded base64url and are checked against exact decoded lengths, so a payload's size is fixed
 * by its shape and unknown keys are rejected (audit I5).
 */

/** OPAQUE flows that register a new credential and therefore carry a key bundle. */
export type RegistrationFlow = "sign-up" | "change-password" | "reset-password" | "attach";

/** Convex validator of {@link RegistrationFlow}. */
export const registrationFlowValidator = v.union(
  v.literal("sign-up"),
  v.literal("change-password"),
  v.literal("reset-password"),
  v.literal("attach"),
);

/**
 * Lifecycle of an account identity. `pending` was committed with a credential that may not be
 * active yet; `active` is the identity of the account's current credential; `retired` was
 * replaced (reset with new keys) and is kept so a later recovery key or device can still open
 * personal data sealed to it. Identity rows are never deleted.
 */
export const identityStatusValidator = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("retired"),
);

/** How long an offered device-recovery slot stays takeable. */
export const DEVICE_RECOVERY_TTL_MS = 15 * 60 * 1000;

/** Decoded size of a device-recovery slot id (`hkdf(secret, deviceRecoveryId, 32)`). */
export const DEVICE_RECOVERY_SLOT_BYTES = 32;

/**
 * Upper bound of a plugin credential version (32 random bytes in base64url today). Checked so
 * internal functions never store unbounded strings even if the plugin's format changes.
 */
export const MAX_CREDENTIAL_VERSION_LENGTH = 128;

/** Thrown for any malformed bundle; the message never echoes payload content. */
export class InvalidKeyBundleError extends Error {
  constructor() {
    super("Invalid key bundle");
    this.name = "InvalidKeyBundleError";
  }
}

/** Unpadded base64url length of `byteLength` bytes. */
function encodedLength(byteLength: number) {
  return Math.ceil((byteLength * 4) / 3);
}

/**
 * Decodes unpadded base64url of exactly `byteLength` bytes, or `null`. `fromBase64Url` accepts
 * only the canonical spelling, so one byte string has exactly one accepted text form (key ids and
 * slot ids are stored and indexed as text). The length check comes first so oversized input is
 * never decoded.
 */
export function decodeExactBytes(text: string, byteLength: number): Uint8Array | null {
  if (text.length !== encodedLength(byteLength)) {
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text);
  } catch {
    return null;
  }
  return bytes.length === byteLength ? bytes : null;
}

/** Copies bytes into a standalone `ArrayBuffer`, the representation of `v.bytes()`. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** Encodes stored `v.bytes()` for the wire. */
export function encodeBytes(buffer: ArrayBuffer): string {
  return toBase64Url(new Uint8Array(buffer));
}

/** Zod schema of a base64url field decoding to exactly `byteLength` bytes, parsed to bytes. */
function bytesField(byteLength: number) {
  return z
    .string()
    .max(encodedLength(byteLength))
    .transform((text, ctx) => {
      const bytes = decodeExactBytes(text, byteLength);
      if (!bytes) {
        ctx.addIssue({ code: "custom", message: `expected ${byteLength} bytes` });
        return z.NEVER;
      }
      return toArrayBuffer(bytes);
    });
}

/** Zod schema of a key id: validated as 16 bytes but kept as its canonical text. */
const keyIdField = z
  .string()
  .max(encodedLength(KEY_ID_BYTES))
  .refine((text) => decodeExactBytes(text, KEY_ID_BYTES) !== null, "expected a 16-byte key id");

const identityRecordSchema = z.strictObject({
  keyId: keyIdField,
  suite: z.literal(SUITE_1),
  encryptionPublicKey: bytesField(ENCRYPTION_PUBLIC_KEY_BYTES),
  signingPublicKey: bytesField(SIGNING_PUBLIC_KEY_BYTES),
  secrets: bytesField(IDENTITY_SECRETS_BYTES),
  selfSignature: bytesField(SIGNATURE_BYTES),
});

const newKeysPayloadSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("new-keys"),
  passwordWrapper: bytesField(AMK_WRAPPER_BYTES),
  recoveryWrapper: bytesField(AMK_WRAPPER_BYTES),
  identity: identityRecordSchema,
});

const rewrapPayloadSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("rewrap"),
  passwordWrapper: bytesField(AMK_WRAPPER_BYTES),
  keyId: keyIdField,
});

/** A decoded identity record; byte fields are ready to store. */
export type IdentityRecord = z.output<typeof identityRecordSchema>;

/** Sign-up, or reset with new keys: a fresh identity and its AMK wrappers. */
export type NewKeysPayload = z.output<typeof newKeysPayloadSchema>;

/** Password change, or reset with a recovery key or another device: same AMK, new wrapper. */
export type RewrapPayload = z.output<typeof rewrapPayloadSchema>;

export type RegistrationPayload = NewKeysPayload | RewrapPayload;

/**
 * Parses the payload of a registration flow. Sign-up and attach (a classic account migrating,
 * which has no keys yet) must create keys; password change must keep them; reset accepts either
 * (recovery key or other device → `rewrap`, lost everything or enrolment of a classic account →
 * `new-keys`). An absent payload is rejected, so no OPAQUE credential exists without a bundle.
 *
 * @throws InvalidKeyBundleError without details of the rejected input.
 */
export function parseRegistrationPayload(
  payload: unknown,
  flow: RegistrationFlow,
): RegistrationPayload {
  let schema: z.ZodType<RegistrationPayload>;
  if (flow === "sign-up" || flow === "attach") {
    schema = newKeysPayloadSchema;
  } else if (flow === "change-password") {
    schema = rewrapPayloadSchema;
  } else {
    schema = z.discriminatedUnion("kind", [newKeysPayloadSchema, rewrapPayloadSchema]);
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new InvalidKeyBundleError();
  }
  return result.data;
}

/** Wire form of an identity, as returned to the client by `loadPayload`. */
export type IdentityRecordWire = {
  keyId: string;
  suite: number;
  encryptionPublicKey: string;
  signingPublicKey: string;
  secrets: string;
  selfSignature: string;
};

/** `loadPayload` result for sign-in: the current credential's wrapper and identity. */
export type SignInPayloadWire = { v: 1; passwordWrapper: string; identity: IdentityRecordWire };

/**
 * `loadPayload` result for reset verify. `identity: null` means the account has no keys (no OPAQUE
 * account created by Radium is in that state).
 */
export type ResetPayloadWire =
  | { v: 1; recoveryWrapper: string; identity: IdentityRecordWire }
  | { v: 1; identity: null };
