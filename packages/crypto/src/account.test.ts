import { describe, expect, it } from "vitest";
import {
  createAccountKeys,
  deriveKek,
  identitySelfSignature,
  openIdentitySecrets,
  sealIdentitySecrets,
  unwrapAmk,
  verifyIdentitySelfSignature,
  wrapAmk,
  type AmkWrapperPurpose,
} from "./account";
import { randomBytes } from "./encoding";
import { decodeEnvelope } from "./envelope";
import { CryptoError } from "./errors";
import { generateEncryptionKeyPair } from "./kem";
import { generateSigningKeyPair } from "./signatures";
import {
  AMK_WRAPPER_BYTES,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  IDENTITY_SECRETS_BYTES,
  KEY_ID_BYTES,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
} from "./suite";

async function expectCode(promise: Promise<unknown>, code: CryptoError["code"]) {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof CryptoError && error.code === code,
  );
}

const account = await createAccountKeys();
const { amk, identity } = account;

function published(secrets: Uint8Array) {
  return {
    amk,
    keyId: identity.keyId,
    suite: identity.suite,
    envelope: secrets,
    encryptionPublicKey: identity.encryption.publicKey,
    signingPublicKey: identity.signing.publicKey,
  };
}

describe("createAccountKeys", () => {
  it("produces keys whose sizes match the exported wire constants", async () => {
    expect(amk.length).toBe(32);
    expect(identity.keyId.length).toBe(KEY_ID_BYTES);
    expect(identity.suite).toBe(1);
    expect(identity.encryption.publicKey.length).toBe(ENCRYPTION_PUBLIC_KEY_BYTES);
    expect(identity.signing.publicKey.length).toBe(SIGNING_PUBLIC_KEY_BYTES);
    expect(account.recovery.words.length).toBe(24);

    const kek = await deriveKek(randomBytes(64), "accountKek");
    expect((await wrapAmk({ kek, amk, keyId: identity.keyId, purpose: "password" })).length).toBe(
      AMK_WRAPPER_BYTES,
    );
    expect((await sealIdentitySecrets({ amk, identity })).length).toBe(IDENTITY_SECRETS_BYTES);
    expect((await identitySelfSignature(identity)).length).toBe(SIGNATURE_BYTES);
  });
});

describe("deriveKek", () => {
  it("gives unrelated keys per label and rejects short secrets", async () => {
    const secret = randomBytes(32);
    const keys = await Promise.all(
      (["accountKek", "recoveryKek", "deviceRecovery"] as const).map((label) =>
        deriveKek(secret, label),
      ),
    );
    expect(new Set(keys.map((key) => key.join(","))).size).toBe(3);
    await expectCode(deriveKek(randomBytes(15), "deviceRecovery"), "BAD_INPUT");
  });
});

describe("AMK wrappers", () => {
  it("round-trip for every purpose with keyRef = keyId", async () => {
    for (const purpose of ["password", "recovery", "device-recovery"] as const) {
      const kek = randomBytes(32);
      const envelope = await wrapAmk({ kek, amk, keyId: identity.keyId, purpose });
      expect(decodeEnvelope(envelope).keyRef).toEqual(identity.keyId);
      expect(await unwrapAmk({ kek, envelope, keyId: identity.keyId, purpose })).toEqual(amk);
    }
  });

  it("separate purposes even under the same KEK", async () => {
    const kek = randomBytes(32);
    const purposes: AmkWrapperPurpose[] = ["password", "recovery", "device-recovery"];
    for (const purpose of purposes) {
      const envelope = await wrapAmk({ kek, amk, keyId: identity.keyId, purpose });
      for (const other of purposes.filter((candidate) => candidate !== purpose)) {
        await expectCode(
          unwrapAmk({ kek, envelope, keyId: identity.keyId, purpose: other }),
          "DECRYPT_FAILED",
        );
      }
    }
  });

  it("fail for a wrong KEK, keyId, tampered keyRef or wrong size", async () => {
    const kek = randomBytes(32);
    const envelope = await wrapAmk({ kek, amk, keyId: identity.keyId, purpose: "password" });
    const otherKeyId = randomBytes(16);

    await expectCode(
      unwrapAmk({ kek: randomBytes(32), envelope, keyId: identity.keyId, purpose: "password" }),
      "DECRYPT_FAILED",
    );
    await expectCode(
      unwrapAmk({ kek, envelope, keyId: otherKeyId, purpose: "password" }),
      "DECRYPT_FAILED",
    );

    // Rewriting keyRef to match another keyId still fails: the AAD parent is the original keyId.
    const relabeled = envelope.slice();
    relabeled.set(otherKeyId, 3);
    await expectCode(
      unwrapAmk({ kek, envelope: relabeled, keyId: otherKeyId, purpose: "password" }),
      "DECRYPT_FAILED",
    );

    await expectCode(
      unwrapAmk({
        kek,
        envelope: envelope.slice(0, AMK_WRAPPER_BYTES - 1),
        keyId: identity.keyId,
        purpose: "password",
      }),
      "BAD_ENVELOPE",
    );
  });

  it("does not open identity secrets as a wrapper or vice versa", async () => {
    const secrets = await sealIdentitySecrets({ amk, identity });
    await expectCode(
      unwrapAmk({ kek: amk, envelope: secrets, keyId: identity.keyId, purpose: "password" }),
      "BAD_ENVELOPE",
    );
  });
});

describe("identity secrets", () => {
  it("round-trip under the AMK", async () => {
    const secrets = await sealIdentitySecrets({ amk, identity });
    expect(await openIdentitySecrets(published(secrets))).toEqual(identity);
  });

  it("reject mismatched published public keys", async () => {
    const secrets = await sealIdentitySecrets({ amk, identity });
    const otherEncryption = await generateEncryptionKeyPair();
    const otherSigning = await generateSigningKeyPair();

    await expectCode(
      openIdentitySecrets({
        ...published(secrets),
        encryptionPublicKey: otherEncryption.publicKey,
      }),
      "DECRYPT_FAILED",
    );
    await expectCode(
      openIdentitySecrets({ ...published(secrets), signingPublicKey: otherSigning.publicKey }),
      "DECRYPT_FAILED",
    );
  });

  it("reject a wrong AMK, keyId or suite", async () => {
    const secrets = await sealIdentitySecrets({ amk, identity });
    await expectCode(
      openIdentitySecrets({ ...published(secrets), amk: randomBytes(32) }),
      "DECRYPT_FAILED",
    );
    await expectCode(
      openIdentitySecrets({ ...published(secrets), keyId: randomBytes(16) }),
      "DECRYPT_FAILED",
    );
    await expectCode(openIdentitySecrets({ ...published(secrets), suite: 2 }), "UNSUPPORTED_SUITE");
  });
});

describe("identity self-signature", () => {
  it("verifies for the published record and fails for any changed field", async () => {
    const signature = await identitySelfSignature(identity);
    const record = {
      keyId: identity.keyId,
      suite: identity.suite,
      encryptionPublicKey: identity.encryption.publicKey,
      signingPublicKey: identity.signing.publicKey,
      signature,
    };
    expect(await verifyIdentitySelfSignature(record)).toBe(true);

    const other = await generateEncryptionKeyPair();
    expect(await verifyIdentitySelfSignature({ ...record, keyId: randomBytes(16) })).toBe(false);
    expect(await verifyIdentitySelfSignature({ ...record, suite: 2 })).toBe(false);
    expect(
      await verifyIdentitySelfSignature({ ...record, encryptionPublicKey: other.publicKey }),
    ).toBe(false);
    expect(
      await verifyIdentitySelfSignature({
        ...record,
        signingPublicKey: (await generateSigningKeyPair()).publicKey,
      }),
    ).toBe(false);
  });
});
