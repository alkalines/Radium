import type { AadParts } from "./aad";
import { assertLength, concatBytes, equalBytes, randomBytes, toBase64Url } from "./encoding";
import { decodeEnvelope, openSym, sealSym } from "./envelope";
import { CryptoError } from "./errors";
import { hkdf, LABELS } from "./kdf";
import {
  encryptionPublicKeyFromSeed,
  generateEncryptionKeyPair,
  type EncryptionKeyPair,
} from "./kem";
import { generateRecoveryKey } from "./phrases";
import {
  generateSigningKeyPair,
  sign,
  signingMessage,
  signingPublicKeyFromSeed,
  verify,
  type SigningKeyPair,
} from "./signatures";
import {
  AMK_WRAPPER_BYTES,
  assertSupportedSuite,
  IDENTITY_SECRETS_BYTES,
  KEY_ID_BYTES,
  SUITE_1,
  type SuiteId,
} from "./suite";

/** 16 random bytes naming one identity key set; also the `keyRef` of every account envelope. */
export type AccountKeyId = Uint8Array;

/** A user's identity key set (Keys.md "Account"): encryption and signing key pairs under one key ID. */
export type IdentityKeys = {
  keyId: AccountKeyId;
  suite: SuiteId;
  encryption: EncryptionKeyPair;
  signing: SigningKeyPair;
};

/** What an AMK wrapper unlocks with; each purpose has its own AAD record so wrappers cannot be swapped. */
export type AmkWrapperPurpose = "password" | "recovery" | "device-recovery";

const AMK_BYTES = 32;
const SEED_BYTES = 32;
// Shortest secret a KEK may come from: the 16-byte device-recovery secret.
const MIN_KEK_SECRET_BYTES = 16;
const ACCOUNT_TABLE = "account_keys";
const IDENTITY_STATEMENT = "radium/v1/identity";
const WRAPPER_PURPOSES: readonly AmkWrapperPurpose[] = ["password", "recovery", "device-recovery"];

/** AAD for account envelopes: table `account_keys`, no workspace, parent = base64url(keyId). */
function accountAad(keyId: AccountKeyId, record: string, field: "amk" | "secrets"): AadParts {
  return { table: ACCOUNT_TABLE, workspace: "", parent: toBase64Url(keyId), record, field };
}

/**
 * Decodes an account envelope and checks it has the expected exact size and names `keyId`. A different
 * keyRef means the envelope belongs to another identity: reported as `DECRYPT_FAILED`, like a wrong key.
 */
function checkAccountEnvelope(
  envelope: Uint8Array,
  keyId: AccountKeyId,
  expectedBytes: number,
): void {
  assertLength(keyId, KEY_ID_BYTES, "keyId");
  if (envelope.length !== expectedBytes) {
    throw new CryptoError("BAD_ENVELOPE", "Unexpected envelope size");
  }
  if (!equalBytes(decodeEnvelope(envelope).keyRef, keyId)) {
    throw new CryptoError("DECRYPT_FAILED", "Decryption failed");
  }
}

function assertWrapperPurpose(purpose: AmkWrapperPurpose): void {
  if (!WRAPPER_PURPOSES.includes(purpose)) {
    throw new CryptoError("BAD_INPUT", "Invalid wrapper purpose");
  }
}

/**
 * Creates everything a new account needs on the client: a random 32-byte account master key (AMK), a
 * fresh identity (random key ID, encryption and signing key pairs) and a recovery key to show once.
 * Nothing here leaves the client unencrypted; persist only `wrapAmk`/`sealIdentitySecrets` outputs and
 * public keys. Uses randomness.
 */
export async function createAccountKeys(): Promise<{
  amk: Uint8Array;
  identity: IdentityKeys;
  recovery: { entropy: Uint8Array; words: string[] };
}> {
  const amk = randomBytes(AMK_BYTES);
  const identity: IdentityKeys = {
    keyId: randomBytes(KEY_ID_BYTES),
    suite: SUITE_1,
    encryption: await generateEncryptionKeyPair(),
    signing: await generateSigningKeyPair(),
  };
  return { amk, identity, recovery: generateRecoveryKey() };
}

/**
 * Derives a 32-byte key-encryption key from an unlock secret: the OPAQUE export key (`accountKek`), the
 * recovery key entropy (`recoveryKek`) or the device-recovery secret (`deviceRecovery`). Each label
 * yields an unrelated key for the same input. Throws `BAD_INPUT` for secrets shorter than 16 bytes.
 */
export async function deriveKek(
  secret: Uint8Array,
  label: "accountKek" | "recoveryKek" | "deviceRecovery",
): Promise<Uint8Array> {
  if (secret.length < MIN_KEK_SECRET_BYTES) {
    throw new CryptoError("BAD_INPUT", "KEK secret too short");
  }
  return hkdf(secret, LABELS[label], 32);
}

/**
 * Wraps the AMK under a KEK as an unpadded 79-byte envelope (`AMK_WRAPPER_BYTES`), keyRef = keyId and AAD
 * record = purpose, so a password wrapper cannot be presented as a recovery wrapper or for another
 * identity. Uses randomness (nonce).
 */
export async function wrapAmk(input: {
  kek: Uint8Array;
  amk: Uint8Array;
  keyId: AccountKeyId;
  purpose: AmkWrapperPurpose;
}): Promise<Uint8Array> {
  assertLength(input.amk, AMK_BYTES, "amk");
  assertLength(input.keyId, KEY_ID_BYTES, "keyId");
  assertWrapperPurpose(input.purpose);

  return sealSym({
    key: input.kek,
    keyRef: input.keyId,
    plaintext: input.amk,
    aad: accountAad(input.keyId, input.purpose, "amk"),
    kind: "sym",
    pad: "none",
  });
}

/**
 * Opens a `wrapAmk` envelope. Throws `BAD_ENVELOPE` for a wrong size and `DECRYPT_FAILED` for a wrong
 * KEK, keyId or purpose, or any modified byte.
 */
export async function unwrapAmk(input: {
  kek: Uint8Array;
  envelope: Uint8Array;
  keyId: AccountKeyId;
  purpose: AmkWrapperPurpose;
}): Promise<Uint8Array> {
  assertWrapperPurpose(input.purpose);
  checkAccountEnvelope(input.envelope, input.keyId, AMK_WRAPPER_BYTES);

  return openSym({
    key: input.kek,
    envelope: input.envelope,
    aad: accountAad(input.keyId, input.purpose, "amk"),
    pad: "none",
  });
}

/**
 * Encrypts the identity's private seeds (encryption seed ‖ signing seed, 64 bytes) under the AMK as an
 * unpadded 111-byte envelope (`IDENTITY_SECRETS_BYTES`), AAD record `identity`. Uses randomness (nonce).
 */
export async function sealIdentitySecrets(input: {
  amk: Uint8Array;
  identity: IdentityKeys;
}): Promise<Uint8Array> {
  const { identity } = input;
  assertLength(input.amk, AMK_BYTES, "amk");
  assertLength(identity.keyId, KEY_ID_BYTES, "keyId");
  assertSupportedSuite(identity.suite);
  assertLength(identity.encryption.seed, SEED_BYTES, "encryption seed");
  assertLength(identity.signing.seed, SEED_BYTES, "signing seed");

  const plaintext = concatBytes(identity.encryption.seed, identity.signing.seed);
  try {
    return await sealSym({
      key: input.amk,
      keyRef: identity.keyId,
      plaintext,
      aad: accountAad(identity.keyId, "identity", "secrets"),
      kind: "sym",
      pad: "none",
    });
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Decrypts identity seeds and re-derives both public keys from them. If either differs from the
 * published `encryptionPublicKey`/`signingPublicKey`, throws `DECRYPT_FAILED`: the record was assembled
 * from mismatched parts and must not be used. Also throws `DECRYPT_FAILED` for a wrong AMK or keyId,
 * `BAD_ENVELOPE` for a wrong size and `UNSUPPORTED_SUITE` for an unknown suite.
 */
export async function openIdentitySecrets(input: {
  amk: Uint8Array;
  keyId: AccountKeyId;
  suite: SuiteId;
  envelope: Uint8Array;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
}): Promise<IdentityKeys> {
  assertSupportedSuite(input.suite);
  checkAccountEnvelope(input.envelope, input.keyId, IDENTITY_SECRETS_BYTES);

  const plaintext = await openSym({
    key: input.amk,
    envelope: input.envelope,
    aad: accountAad(input.keyId, "identity", "secrets"),
    pad: "none",
  });
  const encryptionSeed = plaintext.slice(0, SEED_BYTES);
  const signingSeed = plaintext.slice(SEED_BYTES, 2 * SEED_BYTES);
  plaintext.fill(0);

  const encryptionPublicKey = await encryptionPublicKeyFromSeed(encryptionSeed);
  const signingPublicKey = await signingPublicKeyFromSeed(signingSeed);
  if (
    !equalBytes(encryptionPublicKey, input.encryptionPublicKey) ||
    !equalBytes(signingPublicKey, input.signingPublicKey)
  ) {
    encryptionSeed.fill(0);
    signingSeed.fill(0);
    throw new CryptoError("DECRYPT_FAILED", "Identity keys do not match the published public keys");
  }

  return {
    keyId: input.keyId.slice(),
    suite: input.suite,
    encryption: { suite: input.suite, publicKey: encryptionPublicKey, seed: encryptionSeed },
    signing: { suite: input.suite, publicKey: signingPublicKey, seed: signingSeed },
  };
}

/** The statement an identity self-signature covers: key ID, suite byte and both public keys. */
function identityStatement(
  keyId: AccountKeyId,
  suite: SuiteId,
  encryptionPublicKey: Uint8Array,
  signingPublicKey: Uint8Array,
): Uint8Array {
  return signingMessage(
    IDENTITY_STATEMENT,
    keyId,
    Uint8Array.of(suite),
    encryptionPublicKey,
    signingPublicKey,
  );
}

/**
 * Signs the identity's own public record with its signing key, binding the encryption key, key ID and
 * suite to the signing key. Returns the 64-byte signature.
 */
export async function identitySelfSignature(identity: IdentityKeys): Promise<Uint8Array> {
  assertSupportedSuite(identity.suite);
  const statement = identityStatement(
    identity.keyId,
    identity.suite,
    identity.encryption.publicKey,
    identity.signing.publicKey,
  );
  return sign(identity.signing.seed, statement);
}

/**
 * Checks an identity record's self-signature. Returns `false` for any mismatch, malformed input or
 * unsupported suite. Proves only that the record is internally consistent, not who owns it (that is the
 * trust system's job). Deterministic: usable in Convex mutations.
 */
export async function verifyIdentitySelfSignature(input: {
  keyId: AccountKeyId;
  suite: SuiteId;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
  signature: Uint8Array;
}): Promise<boolean> {
  if (input.suite !== SUITE_1 || input.keyId.length !== KEY_ID_BYTES) {
    return false;
  }
  const statement = identityStatement(
    input.keyId,
    input.suite,
    input.encryptionPublicKey,
    input.signingPublicKey,
  );
  return verify(input.signingPublicKey, statement, input.signature);
}
