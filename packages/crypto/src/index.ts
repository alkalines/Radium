/**
 * Radium end-to-end encryption primitives (docs/E2EE/Keys.md), suite 1. Web APIs only; importing this
 * module does no work and uses no randomness, so it is safe in Convex queries and mutations, which may
 * still only call the deterministic functions (verification, decoding), never key, nonce or capsule
 * creation.
 */
export { CryptoError, type CryptoErrorCode } from "./errors";
export {
  AMK_WRAPPER_BYTES,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  ENVELOPE_VERSION,
  IDENTITY_SECRETS_BYTES,
  KEY_ID_BYTES,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  SUITE_1,
  type SuiteId,
} from "./suite";
export { equalBytes, fromBase64Url, randomBytes, toBase64Url, utf8 } from "./encoding";
export { hkdf, LABELS } from "./kdf";
export { buildAad, type AadParts } from "./aad";
export { pad, unpad } from "./padding";
export { decodeEnvelope, encodeEnvelope, openSym, sealSym, type Envelope } from "./envelope";
export {
  createCapsule,
  deriveObjectKey,
  encryptionPublicKeyFromSeed,
  generateEncryptionKeyPair,
  openCapsule,
  openRequestRecipient,
  openRequestSender,
  type Capsule,
  type EncryptionKeyPair,
} from "./kem";
export {
  generateSigningKeyPair,
  sign,
  signingMessage,
  signingPublicKeyFromSeed,
  verify,
  type SigningKeyPair,
} from "./signatures";
export { fingerprint, safetyNumber } from "./fingerprints";
export { generateRecoveryKey, generateShortSecret, phraseToEntropy } from "./phrases";
export {
  createAccountKeys,
  deriveKek,
  identitySelfSignature,
  openIdentitySecrets,
  sealIdentitySecrets,
  unwrapAmk,
  verifyIdentitySelfSignature,
  wrapAmk,
  type AccountKeyId,
  type AmkWrapperPurpose,
  type IdentityKeys,
} from "./account";
