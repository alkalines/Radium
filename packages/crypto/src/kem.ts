import { KEM_MLKEM768_X25519 as NOBLE_MLKEM768_X25519 } from "@panva/hpke-noble";
import * as HPKE from "hpke";
import { buildAad, type AadParts } from "./aad";
import {
  assertLength,
  bufferSource,
  concatBytes,
  equalBytes,
  fromBase64Url,
  lengthPrefixed,
  randomBytes,
  utf8,
} from "./encoding";
import { CryptoError } from "./errors";
import { hkdf, LABELS } from "./kdf";
import {
  assertSupportedSuite,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  KEY_ID_BYTES,
  SUITE_1,
  type SuiteId,
} from "./suite";

/**
 * An MLKEM768-X25519 (X-Wing) key pair. `seed` is the 32-byte input keying material of HPKE
 * `DeriveKeyPair` (draft-ietf-hpke-pq): both the private and the public key are derived from it, so the
 * seed is the only secret to store. It is never reused for any other KEM or purpose.
 */
export type EncryptionKeyPair = { suite: SuiteId; publicKey: Uint8Array; seed: Uint8Array };

/**
 * A key capsule: one HPKE encapsulation to one recipient public key plus the 32-byte capsule key sealed
 * under it (Keys.md "Key capsules"). Object keys are derived from the capsule key with `deriveObjectKey`.
 */
export type Capsule = {
  suite: SuiteId;
  capsuleId: Uint8Array;
  encapsulated: Uint8Array;
  sealedKey: Uint8Array;
};

/** Which X-Wing implementation backs suite 1 in this runtime. */
export type XWingImplementation = "native" | "noble";

const SEED_BYTES = 32;
const ENCAPSULATED_BYTES = 1120;
const CAPSULE_KEY_BYTES = 32;
const SEALED_CAPSULE_KEY_BYTES = CAPSULE_KEY_BYTES + 16;
const RESPONSE_KEY_BYTES = 32;
const CAPSULE_INFO = "radium/v1/capsule";
// Request contexts get their own HPKE info so an encapsulation made for one use cannot be replayed as the other.
const REQUEST_INFO = "radium/v1/request";

// Known answer for the runtime self-test: ikmR and SHA-256(pkRm) of the MLKEM768-X25519 base-mode vector
// in draft-ietf-hpke-pq (hpkewg/hpke-pq test-vectors.json, commit 6433c8f). A native implementation is
// used only if it reproduces these exact bytes, so native and noble peers always interoperate.
const SELF_TEST_IKM = "yFddE33quZrJj7CHMEjIPDofR-9bQJ9gnAymUvWMg-A";
const SELF_TEST_PUBLIC_KEY_SHA256 = "rUKz2GaWBes1EnO5ReL0v-YphlF7QR5gbCJdltTekJk";

/** Builds the suite-1 HPKE cipher suite on the native WebCrypto X-Wing or on `@panva/hpke-noble`. */
export function createXWingSuite(implementation: XWingImplementation): HPKE.CipherSuite {
  const kem = implementation === "native" ? HPKE.KEM_MLKEM768_X25519 : NOBLE_MLKEM768_X25519;
  return new HPKE.CipherSuite(kem, HPKE.KDF_HKDF_SHA256, HPKE.AEAD_AES_256_GCM);
}

/**
 * Checks that `suite` derives the draft's known public key and completes an encapsulate/decapsulate
 * round trip. Any exception (missing WebCrypto algorithm) counts as failure.
 */
async function passesSelfTest(suite: HPKE.CipherSuite): Promise<boolean> {
  try {
    const keyPair = await suite.DeriveKeyPair(fromBase64Url(SELF_TEST_IKM), false);
    const publicKey = await suite.SerializePublicKey(keyPair.publicKey);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(publicKey)));
    if (!equalBytes(digest, fromBase64Url(SELF_TEST_PUBLIC_KEY_SHA256))) {
      return false;
    }

    const exporterContext = utf8("radium/v1/self-test");
    const { encapsulatedSecret, ctx } = await suite.SetupSender(keyPair.publicKey);
    const recipient = await suite.SetupRecipient(keyPair, encapsulatedSecret);
    return equalBytes(
      await ctx.Export(exporterContext, 32),
      await recipient.Export(exporterContext, 32),
    );
  } catch {
    return false;
  }
}

let selectedSuite:
  | Promise<{ implementation: XWingImplementation; suite: HPKE.CipherSuite }>
  | undefined;

/**
 * The suite-1 cipher suite for this runtime: native X-Wing when it passes the self-test, else noble.
 * Selected once on first use (never at import: Convex forbids randomness during module evaluation) and
 * cached for the life of the module.
 */
export function getXWingSuite(): Promise<{
  implementation: XWingImplementation;
  suite: HPKE.CipherSuite;
}> {
  selectedSuite ??= (async () => {
    const native = await createNativeSuiteIfAvailable();
    if (native !== undefined && (await passesSelfTest(native))) {
      return { implementation: "native" as const, suite: native };
    }
    return { implementation: "noble" as const, suite: createXWingSuite("noble") };
  })();
  return selectedSuite;
}

function createNativeSuiteIfAvailable(): HPKE.CipherSuite | undefined {
  try {
    return createXWingSuite("native");
  } catch {
    return undefined;
  }
}

async function deriveKeyPair(seed: Uint8Array) {
  assertLength(seed, SEED_BYTES, "seed");
  const { suite } = await getXWingSuite();
  return { suite, keyPair: await suite.DeriveKeyPair(seed, false) };
}

async function deserializeRecipientKey(publicKey: Uint8Array) {
  assertLength(publicKey, ENCRYPTION_PUBLIC_KEY_BYTES, "recipientPublicKey");
  const { suite } = await getXWingSuite();
  try {
    return { suite, key: await suite.DeserializePublicKey(publicKey) };
  } catch {
    throw new CryptoError("BAD_INPUT", "Invalid encryption public key");
  }
}

/** Derives the 1216-byte public key for an encryption seed. */
export async function encryptionPublicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const { suite, keyPair } = await deriveKeyPair(seed);
  return suite.SerializePublicKey(keyPair.publicKey);
}

/** Creates a random encryption key pair. Uses randomness: clients and Convex actions only. */
export async function generateEncryptionKeyPair(): Promise<EncryptionKeyPair> {
  const seed = randomBytes(SEED_BYTES);
  return { suite: SUITE_1, publicKey: await encryptionPublicKeyFromSeed(seed), seed };
}

function capsuleInfo(capsuleId: Uint8Array): Uint8Array {
  return concatBytes(utf8(CAPSULE_INFO), capsuleId);
}

/**
 * Creates a capsule for one write batch: a random 32-byte capsule key sealed by HPKE single-shot to
 * `recipientPublicKey`, with info `radium/v1/capsule ‖ capsuleId` and `buildAad(aad)` as HPKE AAD.
 * Returns the capsule to store and the capsule key to derive object keys from; the capsule key must not
 * be persisted or sent anywhere. Uses randomness: clients and Convex actions only.
 */
export async function createCapsule(input: {
  recipientPublicKey: Uint8Array;
  aad: AadParts;
}): Promise<{ capsule: Capsule; capsuleKey: Uint8Array }> {
  const { suite, key } = await deserializeRecipientKey(input.recipientPublicKey);
  const capsuleId = randomBytes(KEY_ID_BYTES);
  const capsuleKey = randomBytes(CAPSULE_KEY_BYTES);

  const { encapsulatedSecret, ciphertext } = await suite.Seal(key, capsuleKey, {
    info: capsuleInfo(capsuleId),
    aad: buildAad(input.aad),
  });

  return {
    capsule: { suite: SUITE_1, capsuleId, encapsulated: encapsulatedSecret, sealedKey: ciphertext },
    capsuleKey,
  };
}

/**
 * Recovers the capsule key with the recipient's encryption seed. Throws `BAD_ENVELOPE` for a malformed
 * capsule, `UNSUPPORTED_SUITE` for an unknown suite and `DECRYPT_FAILED` for a wrong recipient, AAD,
 * capsule ID or any modified byte (X-Wing's implicit rejection turns a wrong key into an AEAD failure).
 */
export async function openCapsule(input: {
  seed: Uint8Array;
  capsule: Capsule;
  aad: AadParts;
}): Promise<Uint8Array> {
  const { capsule } = input;
  assertSupportedSuite(capsule.suite);
  if (
    capsule.capsuleId.length !== KEY_ID_BYTES ||
    capsule.encapsulated.length !== ENCAPSULATED_BYTES ||
    capsule.sealedKey.length !== SEALED_CAPSULE_KEY_BYTES
  ) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed capsule");
  }

  const { suite, keyPair } = await deriveKeyPair(input.seed);
  try {
    return await suite.Open(keyPair, capsule.encapsulated, capsule.sealedKey, {
      info: capsuleInfo(capsule.capsuleId),
      aad: buildAad(input.aad),
    });
  } catch {
    throw new CryptoError("DECRYPT_FAILED", "Decryption failed");
  }
}

/**
 * Derives the AES-256-GCM key of one object from a capsule key: HKDF with info
 * `radium/v1/object ‖ table ‖ recordId ‖ field`, each part length-prefixed so no two objects share an
 * info string. Holding an object key opens exactly that object.
 */
export async function deriveObjectKey(input: {
  capsuleKey: Uint8Array;
  table: string;
  recordId: string;
  field: string;
}): Promise<Uint8Array> {
  assertLength(input.capsuleKey, CAPSULE_KEY_BYTES, "capsuleKey");
  const info = lengthPrefixed([
    utf8(LABELS.object),
    utf8(input.table),
    utf8(input.recordId),
    utf8(input.field),
  ]);
  return hkdf(input.capsuleKey, info, 32);
}

/**
 * Opens an HPKE base-mode sender context to a recipient (a Worker) for one request (Keys.md "Request
 * keys"). `seal` encrypts successive messages; the recipient must open them in the same order. Both sides
 * export the same `responseKey` (exporter context `radium/v1/response`) to encrypt replies. Base mode does
 * not authenticate the sender: anyone can create such a context, so recipients must authorize requests by
 * other means (user signatures). Keep the context and response key in memory for the request only.
 */
export async function openRequestSender(recipientPublicKey: Uint8Array): Promise<{
  encapsulated: Uint8Array;
  seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  responseKey: Uint8Array;
}> {
  const { suite, key } = await deserializeRecipientKey(recipientPublicKey);
  const { encapsulatedSecret, ctx } = await suite.SetupSender(key, { info: utf8(REQUEST_INFO) });
  const responseKey = await ctx.Export(utf8(LABELS.response), RESPONSE_KEY_BYTES);

  return {
    encapsulated: encapsulatedSecret,
    seal: (plaintext, aad) => ctx.Seal(plaintext, aad),
    responseKey,
  };
}

/**
 * The recipient side of `openRequestSender`. `open` throws `DECRYPT_FAILED` for a wrong key, AAD,
 * order or modified ciphertext. A wrong `encapsulated` value is not detected here (implicit rejection
 * yields unrelated keys); it surfaces as `DECRYPT_FAILED` on the first `open`.
 */
export async function openRequestRecipient(
  seed: Uint8Array,
  encapsulated: Uint8Array,
): Promise<{
  open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  responseKey: Uint8Array;
}> {
  if (encapsulated.length !== ENCAPSULATED_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed encapsulation");
  }

  const { suite, keyPair } = await deriveKeyPair(seed);
  let ctx: HPKE.RecipientContext;
  try {
    ctx = await suite.SetupRecipient(keyPair, encapsulated, { info: utf8(REQUEST_INFO) });
  } catch {
    throw new CryptoError("DECRYPT_FAILED", "Decryption failed");
  }
  const responseKey = await ctx.Export(utf8(LABELS.response), RESPONSE_KEY_BYTES);

  return {
    open: async (ciphertext, aad) => {
      try {
        return await ctx.Open(ciphertext, aad);
      } catch {
        throw new CryptoError("DECRYPT_FAILED", "Decryption failed");
      }
    },
    responseKey,
  };
}
