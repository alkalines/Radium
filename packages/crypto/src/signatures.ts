import { ed25519 } from "@noble/curves/ed25519.js";
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
import { SIGNATURE_BYTES, SIGNING_PUBLIC_KEY_BYTES, SUITE_1, type SuiteId } from "./suite";

/** An Ed25519 key pair; `seed` is the RFC 8032 32-byte private key. */
export type SigningKeyPair = { suite: SuiteId; publicKey: Uint8Array; seed: Uint8Array };

/** One Ed25519 backend. Both produce identical public keys and signatures (Ed25519 is deterministic). */
export type Ed25519Implementation = {
  name: "native" | "noble";
  publicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array>;
  sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
};

const SEED_BYTES = 32;

// PKCS#8 PrivateKeyInfo prefix for an Ed25519 key (RFC 8410): WebCrypto imports raw seeds only this way.
const PKCS8_ED25519_PREFIX = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
);

async function importNativeSigningKey(seed: Uint8Array, extractable: boolean) {
  const pkcs8 = concatBytes(PKCS8_ED25519_PREFIX, seed);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bufferSource(pkcs8),
      { name: "Ed25519" },
      extractable,
      ["sign"],
    );
  } finally {
    pkcs8.fill(0);
  }
}

/** WebCrypto Ed25519. Public keys come from the JWK `x` member, the only portable way to derive them. */
const nativeEd25519: Ed25519Implementation = {
  name: "native",
  async publicKeyFromSeed(seed) {
    const key = await importNativeSigningKey(seed, true);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (typeof jwk.x !== "string") {
      throw new CryptoError("BAD_INPUT", "Ed25519 key export failed");
    }
    return fromBase64Url(jwk.x);
  },
  async sign(seed, message) {
    const key = await importNativeSigningKey(seed, false);
    return new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, key, bufferSource(message)),
    );
  },
  async verify(publicKey, message, signature) {
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        bufferSource(publicKey),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        bufferSource(signature),
        bufferSource(message),
      );
    } catch {
      return false;
    }
  },
};

/** `@noble/curves` Ed25519 with RFC 8032 verification (not ZIP-215), matching WebCrypto's acceptance rules. */
const nobleEd25519: Ed25519Implementation = {
  name: "noble",
  async publicKeyFromSeed(seed) {
    return ed25519.getPublicKey(seed);
  },
  async sign(seed, message) {
    return ed25519.sign(message, seed);
  },
  async verify(publicKey, message, signature) {
    try {
      return ed25519.verify(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  },
};

/** Both backends, for interoperability tests; application code uses the selected one implicitly. */
export const ed25519Implementations = { native: nativeEd25519, noble: nobleEd25519 } as const;

// RFC 8032 §7.1 TEST 1 (empty message): the native backend is used only if it reproduces these bytes.
const SELF_TEST_SEED = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
const SELF_TEST_PUBLIC_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const SELF_TEST_SIGNATURE =
  "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc-bRr0lv18FlbviRlUUFDjnoQCw";

async function passesSelfTest(implementation: Ed25519Implementation): Promise<boolean> {
  try {
    const seed = fromBase64Url(SELF_TEST_SEED);
    const publicKey = await implementation.publicKeyFromSeed(seed);
    const signature = await implementation.sign(seed, new Uint8Array(0));
    return (
      equalBytes(publicKey, fromBase64Url(SELF_TEST_PUBLIC_KEY)) &&
      equalBytes(signature, fromBase64Url(SELF_TEST_SIGNATURE)) &&
      (await implementation.verify(publicKey, new Uint8Array(0), signature))
    );
  } catch {
    return false;
  }
}

let selectedImplementation: Promise<Ed25519Implementation> | undefined;

/**
 * WebCrypto Ed25519 when the runtime supports it and passes the RFC 8032 known-answer test, otherwise
 * noble. Selected on first use (no work at import) and cached; the test is deterministic, so this is
 * safe inside Convex queries and mutations that verify signatures.
 */
export function getEd25519(): Promise<Ed25519Implementation> {
  selectedImplementation ??= (async () =>
    (await passesSelfTest(nativeEd25519)) ? nativeEd25519 : nobleEd25519)();
  return selectedImplementation;
}

/** Derives the 32-byte Ed25519 public key for a seed. */
export async function signingPublicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  assertLength(seed, SEED_BYTES, "seed");
  return (await getEd25519()).publicKeyFromSeed(seed);
}

/** Creates a random signing key pair. Uses randomness: clients and Convex actions only. */
export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const seed = randomBytes(SEED_BYTES);
  return { suite: SUITE_1, publicKey: await signingPublicKeyFromSeed(seed), seed };
}

/** Signs `message` (build it with `signingMessage`) and returns the 64-byte signature. */
export async function sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  assertLength(seed, SEED_BYTES, "seed");
  return (await getEd25519()).sign(seed, message);
}

/**
 * Verifies an Ed25519 signature under RFC 8032 rules. Returns `false` (never throws) for a wrong
 * signature, malformed key or wrong lengths, so untrusted inputs can be passed directly. Deterministic:
 * usable in Convex queries and mutations.
 */
export async function verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== SIGNING_PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) {
    return false;
  }
  return (await getEd25519()).verify(publicKey, message, signature);
}

/**
 * Builds the bytes to sign: `label` first, then each part, all length-prefixed (u32 big-endian). The
 * label names the statement (for example `radium/v1/identity`), so a signature over one kind of statement
 * can never be presented as another.
 */
export function signingMessage(label: string, ...parts: Uint8Array[]): Uint8Array {
  return lengthPrefixed([utf8(label), ...parts]);
}
