import { bufferSource, utf8 } from "./encoding";
import { CryptoError } from "./errors";

/**
 * Every HKDF `info` label Radium uses, in one place so a label is never reused for a second purpose.
 * Reusing a label across purposes would let a key derived for one use open data of another.
 */
export const LABELS = {
  accountKek: "radium/v1/account-kek",
  recoveryKek: "radium/v1/recovery-kek",
  deviceRecovery: "radium/v1/device-recovery",
  deviceRecoveryId: "radium/v1/device-recovery-id",
  object: "radium/v1/object",
  response: "radium/v1/response",
  invite: "radium/v1/invite",
  workspacePhrase: "radium/v1/workspace-phrase",
  workspacePhraseMac: "radium/v1/workspace-phrase-mac",
  inviteMac: "radium/v1/invite-mac",
  trustStore: "radium/v1/trust-store",
  deviceWrap: "radium/v1/device-wrap",
} as const;

// HKDF-SHA-256 can expand at most 255 hash blocks.
const MAX_HKDF_BYTES = 255 * 32;

/**
 * HKDF-SHA-256 (RFC 5869) through WebCrypto. `info` strings are UTF-8 encoded; pass one of `LABELS`
 * (or bytes built from one). The default salt is empty, which RFC 5869 defines as equivalent to 32
 * zero bytes. `ikm` must be non-empty high-entropy key material (export keys, random secrets), not a
 * password. Throws `BAD_INPUT` for empty `ikm` or an impossible length.
 */
export async function hkdf(
  ikm: Uint8Array,
  info: string | Uint8Array,
  length = 32,
  salt: Uint8Array = new Uint8Array(0),
): Promise<Uint8Array> {
  if (ikm.length === 0) {
    throw new CryptoError("BAD_INPUT", "HKDF input key material is empty");
  }
  if (!Number.isInteger(length) || length < 1 || length > MAX_HKDF_BYTES) {
    throw new CryptoError("BAD_INPUT", "Invalid HKDF output length");
  }

  const infoBytes = typeof info === "string" ? utf8(info) : info;
  const key = await crypto.subtle.importKey("raw", bufferSource(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bufferSource(salt), info: bufferSource(infoBytes) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}
