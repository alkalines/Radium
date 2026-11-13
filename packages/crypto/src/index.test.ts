// Dependencies are evaluated here, before the spy: @noble/curves probes the RNG once while its curve
// modules load (to decide on scalar blinding) and tolerates any result. In Convex that probe reads the
// deploy-time seeded generator and is discarded. The test below covers this package's own modules.
import "@noble/curves/ed25519.js";
import "@panva/hpke-noble";
import "@scure/bip39";
import "@scure/bip39/wordlists/english.js";
import "hpke";
import { describe, expect, it, vi } from "vitest";

describe("radium-crypto entry point", () => {
  it("uses no randomness while its own modules are imported", async () => {
    vi.resetModules();
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");
    try {
      // Dynamic on purpose: the module graph must be evaluated after the spy is installed.
      await import("./index");
      expect(getRandomValues).not.toHaveBeenCalled();
    } finally {
      getRandomValues.mockRestore();
    }
  });

  it("exports the contract API", async () => {
    const api = await import("./index");
    expect(Object.keys(api).sort()).toEqual(
      [
        "AMK_WRAPPER_BYTES",
        "CAPSULE_BYTES",
        "CryptoError",
        "ENCRYPTION_PUBLIC_KEY_BYTES",
        "ENVELOPE_VERSION",
        "IDENTITY_SECRETS_BYTES",
        "KEY_ID_BYTES",
        "LABELS",
        "SIGNATURE_BYTES",
        "SIGNING_PUBLIC_KEY_BYTES",
        "SUITE_1",
        "buildAad",
        "chatKeyStatement",
        "createAccountKeys",
        "createCapsule",
        "decimal",
        "decodeCapsule",
        "decodeEnvelope",
        "deriveKek",
        "deriveObjectKey",
        "encodeCapsule",
        "encodeEnvelope",
        "encryptionPublicKeyFromSeed",
        "equalBytes",
        "fingerprint",
        "fromBase64Url",
        "generateEncryptionKeyPair",
        "generateRecoveryKey",
        "generateShortSecret",
        "generateSigningKeyPair",
        "grantStatement",
        "hkdf",
        "hmacSha256",
        "identitySelfSignature",
        "objectKeyFor",
        "openBox",
        "openCapsule",
        "openIdentitySecrets",
        "openRequestRecipient",
        "openRequestSender",
        "openSym",
        "openWithCapsule",
        "pad",
        "phraseToEntropy",
        "randomBytes",
        "rosterStatement",
        "safetyNumber",
        "sealBox",
        "sealIdentitySecrets",
        "sealSym",
        "sealWithCapsule",
        "sha256",
        "sign",
        "signingMessage",
        "signingPublicKeyFromSeed",
        "toBase64Url",
        "unpad",
        "unwrapAmk",
        "utf8",
        "verify",
        "verifyIdentitySelfSignature",
        "wrapAmk",
      ].sort(),
    );
  });
});
