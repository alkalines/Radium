import { CryptoError } from "./errors";

/**
 * Suite `1`: HPKE base mode MLKEM768-X25519 (0x647a) / HKDF-SHA256 / AES-256-GCM for public-key
 * encryption, AES-256-GCM content encryption, HKDF-SHA-256 and Ed25519 signatures.
 */
export const SUITE_1 = 1;

/** Envelope layout version written by this package (Keys.md "Envelope format"). */
export const ENVELOPE_VERSION = 1;

/** Crypto suite identifier carried by every key record, wrapper, capsule, envelope and signature. */
export type SuiteId = number;

/** Account key ID and envelope `keyRef` length. */
export const KEY_ID_BYTES = 16;
/** Serialized MLKEM768-X25519 public key length. */
export const ENCRYPTION_PUBLIC_KEY_BYTES = 1216;
/** Ed25519 public key length. */
export const SIGNING_PUBLIC_KEY_BYTES = 32;
/** Ed25519 signature length. */
export const SIGNATURE_BYTES = 64;
/** Unpadded `wrapAmk` envelope: 31-byte header + 32-byte AMK + 16-byte tag. */
export const AMK_WRAPPER_BYTES = 79;
/** Unpadded identity secrets envelope: 31-byte header + two 32-byte seeds + 16-byte tag. */
export const IDENTITY_SECRETS_BYTES = 111;

/** Readers dispatch on the suite byte; this package implements only suite 1 so far. */
export function assertSupportedSuite(suite: SuiteId): void {
  if (suite !== SUITE_1) {
    throw new CryptoError("UNSUPPORTED_SUITE", "Unsupported crypto suite");
  }
}
