import { assertLength, bufferSource, concatBytes, lengthPrefixed, toHex, utf8 } from "./encoding";
import { ENCRYPTION_PUBLIC_KEY_BYTES, SIGNING_PUBLIC_KEY_BYTES } from "./suite";

/** The public half of a user identity: what fingerprints and safety numbers cover. */
type IdentityPublicKeys = { encryptionPublicKey: Uint8Array; signingPublicKey: Uint8Array };

const FINGERPRINT_LABEL = "radium/fingerprint-v1/";
const SAFETY_NUMBER_LABEL = "radium/safety-v1/";
const FINGERPRINT_BYTES = 16;
const SAFETY_NUMBER_DIGITS = 60;

/** Length-prefixed encryption key ‖ signing key, after checking both lengths. */
function encodeIdentity(identity: IdentityPublicKeys): Uint8Array {
  assertLength(identity.encryptionPublicKey, ENCRYPTION_PUBLIC_KEY_BYTES, "encryptionPublicKey");
  assertLength(identity.signingPublicKey, SIGNING_PUBLIC_KEY_BYTES, "signingPublicKey");
  return lengthPrefixed([identity.encryptionPublicKey, identity.signingPublicKey]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(bytes)));
}

/**
 * One fingerprint covering both identity public keys: SHA-256 over `radium/fingerprint-v1/` and the
 * length-prefixed keys, truncated to 128 bits and shown as 8 space-separated groups of 4 hex digits.
 */
export async function fingerprint(input: IdentityPublicKeys): Promise<string> {
  const digest = await sha256(concatBytes(utf8(FINGERPRINT_LABEL), encodeIdentity(input)));
  const hex = toHex(digest.subarray(0, FINGERPRINT_BYTES));
  return hex.match(/.{4}/gu)!.join(" ");
}

/**
 * Safety number two users compare out of band (Keys.md "Trust system"): SHA-256 over `radium/safety-v1/`
 * and both encoded identities in byte order, so both sides compute the same value regardless of who is
 * `a`. The digest is read as a big-endian integer modulo 10^60 (bias below 2^-56) and shown as 12 groups
 * of 5 digits. Unlike DASS's two digits per byte, every digit carries full entropy.
 */
export async function safetyNumber(a: IdentityPublicKeys, b: IdentityPublicKeys): Promise<string> {
  const encodedA = encodeIdentity(a);
  const encodedB = encodeIdentity(b);
  const ordered =
    compareBytes(encodedA, encodedB) <= 0 ? [encodedA, encodedB] : [encodedB, encodedA];

  const digest = await sha256(concatBytes(utf8(SAFETY_NUMBER_LABEL), lengthPrefixed(ordered)));
  const value = BigInt(`0x${toHex(digest)}`) % 10n ** BigInt(SAFETY_NUMBER_DIGITS);
  const digits = value.toString().padStart(SAFETY_NUMBER_DIGITS, "0");
  return digits.match(/.{5}/gu)!.join(" ");
}

/** Lexicographic byte order; equal-length inputs here, so shorter-first never decides. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) {
      return a[index]! - b[index]!;
    }
  }
  return a.length - b.length;
}
