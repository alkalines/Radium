import {
  AEAD_ChaCha20Poly1305,
  KEM_MLKEM768_X25519 as NOBLE_MLKEM768_X25519,
} from "@panva/hpke-noble";
import * as HPKE from "hpke";
import { describe, expect, it } from "vitest";
import type { AadParts } from "./aad";
import { randomBytes, toHex, utf8 } from "./encoding";
import { CryptoError } from "./errors";
import {
  createCapsule,
  createXWingSuite,
  deriveObjectKey,
  encryptionPublicKeyFromSeed,
  generateEncryptionKeyPair,
  getXWingSuite,
  openCapsule,
  openRequestRecipient,
  openRequestSender,
  type XWingImplementation,
} from "./kem";
import { XWING_HPKE_VECTOR as vector } from "./kem.vectors";
import { ENCRYPTION_PUBLIC_KEY_BYTES } from "./suite";
import { fromHex } from "./test-helpers";

const aad: AadParts = {
  table: "key_capsules",
  workspace: "ws1",
  parent: "chat1",
  record: "turn1",
  field: "key",
};

async function expectCode(promise: Promise<unknown>, code: CryptoError["code"]) {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof CryptoError && error.code === code,
  );
}

async function nativeXWingWorks(): Promise<boolean> {
  try {
    const suite = createXWingSuite("native");
    const keyPair = await suite.DeriveKeyPair(randomBytes(32), false);
    const { encapsulatedSecret, ctx } = await suite.SetupSender(keyPair.publicKey);
    const recipient = await suite.SetupRecipient(keyPair, encapsulatedSecret);
    return toHex(await ctx.Export(utf8("x"), 8)) === toHex(await recipient.Export(utf8("x"), 8));
  } catch {
    return false;
  }
}

const nativeAvailable = await nativeXWingWorks();
const implementations: XWingImplementation[] = nativeAvailable ? ["native", "noble"] : ["noble"];

describe("X-Wing implementation selection", () => {
  it("prefers native exactly when the runtime supports it", async () => {
    const { implementation } = await getXWingSuite();
    expect(implementation).toBe(nativeAvailable ? "native" : "noble");
  });
});

describe.each(implementations)(
  "draft-ietf-hpke-pq MLKEM768-X25519 vector (%s)",
  (implementation) => {
    // The vector uses ChaCha20Poly1305; the KEM and HKDF-SHA256 key schedule are suite 1's.
    const kem = implementation === "native" ? HPKE.KEM_MLKEM768_X25519 : NOBLE_MLKEM768_X25519;
    const suite = new HPKE.CipherSuite(kem, HPKE.KDF_HKDF_SHA256, AEAD_ChaCha20Poly1305);

    it("derives the recipient key pair from ikmR", async () => {
      const keyPair = await suite.DeriveKeyPair(fromHex(vector.ikmR), true);
      expect(toHex(await suite.SerializePublicKey(keyPair.publicKey))).toBe(vector.pkRm);
      expect(toHex(await suite.SerializePrivateKey(keyPair.privateKey))).toBe(vector.skRm);
      expect(suite.KEM.id).toBe(vector.kemId);
    });

    it("decapsulates enc and reproduces the published ciphertexts and exports", async () => {
      const keyPair = await suite.DeriveKeyPair(fromHex(vector.ikmR), false);
      const context = await suite.SetupRecipient(keyPair, fromHex(vector.enc), {
        info: fromHex(vector.info),
      });

      for (const encryption of vector.encryptions) {
        const opened = await context.Open(fromHex(encryption.ct), fromHex(encryption.aad));
        expect(toHex(opened)).toBe(encryption.pt);
      }
      for (const exported of vector.exports) {
        const value = await context.Export(fromHex(exported.context), exported.length);
        expect(toHex(value)).toBe(exported.value);
      }
    });
  },
);

describe("encryption key pairs", () => {
  it("derives the published public key from the seed (seed = DeriveKeyPair ikm)", async () => {
    expect(toHex(await encryptionPublicKeyFromSeed(fromHex(vector.ikmR)))).toBe(vector.pkRm);
  });

  it("generates 1216-byte public keys and 32-byte seeds", async () => {
    const keyPair = await generateEncryptionKeyPair();
    expect(keyPair.suite).toBe(1);
    expect(keyPair.publicKey.length).toBe(ENCRYPTION_PUBLIC_KEY_BYTES);
    expect(keyPair.seed.length).toBe(32);
    expect(await encryptionPublicKeyFromSeed(keyPair.seed)).toEqual(keyPair.publicKey);
  });

  it("rejects seeds of the wrong size", async () => {
    await expectCode(encryptionPublicKeyFromSeed(randomBytes(31)), "BAD_INPUT");
  });
});

describe.skipIf(!nativeAvailable)("native and noble interoperate", () => {
  const native = createXWingSuite("native");
  const noble = createXWingSuite("noble");

  it("derives identical key pairs from one seed", async () => {
    const seed = randomBytes(32);
    const nativePair = await native.DeriveKeyPair(seed, true);
    const noblePair = await noble.DeriveKeyPair(seed, true);
    expect(await native.SerializePublicKey(nativePair.publicKey)).toEqual(
      await noble.SerializePublicKey(noblePair.publicKey),
    );
    expect(await native.SerializePrivateKey(nativePair.privateKey)).toEqual(
      await noble.SerializePrivateKey(noblePair.privateKey),
    );
  });

  it("opens in one what the other sealed, both directions", async () => {
    const seed = randomBytes(32);
    const message = utf8("capsule key bytes");
    for (const [sender, recipient] of [
      [native, noble],
      [noble, native],
    ] as const) {
      const senderPair = await sender.DeriveKeyPair(seed, false);
      const recipientPair = await recipient.DeriveKeyPair(seed, false);
      const { encapsulatedSecret, ciphertext } = await sender.Seal(senderPair.publicKey, message, {
        info: utf8("info"),
        aad: utf8("aad"),
      });
      const opened = await recipient.Open(recipientPair, encapsulatedSecret, ciphertext, {
        info: utf8("info"),
        aad: utf8("aad"),
      });
      expect(opened).toEqual(message);
    }
  });
});

describe("capsules", () => {
  it("round-trips the capsule key and has the documented sizes", async () => {
    const recipient = await generateEncryptionKeyPair();
    const { capsule, capsuleKey } = await createCapsule({
      recipientPublicKey: recipient.publicKey,
      aad,
    });

    expect(capsule.suite).toBe(1);
    expect(capsule.capsuleId.length).toBe(16);
    expect(capsule.encapsulated.length).toBe(1120);
    expect(capsule.sealedKey.length).toBe(48);
    expect(capsuleKey.length).toBe(32);
    expect(await openCapsule({ seed: recipient.seed, capsule, aad })).toEqual(capsuleKey);
  });

  it("fails for a wrong recipient, wrong AAD, wrong capsule ID or swapped encapsulation", async () => {
    const recipient = await generateEncryptionKeyPair();
    const other = await generateEncryptionKeyPair();
    const { capsule } = await createCapsule({ recipientPublicKey: recipient.publicKey, aad });
    const { capsule: second } = await createCapsule({
      recipientPublicKey: recipient.publicKey,
      aad,
    });

    await expectCode(openCapsule({ seed: other.seed, capsule, aad }), "DECRYPT_FAILED");
    await expectCode(
      openCapsule({ seed: recipient.seed, capsule, aad: { ...aad, record: "turn2" } }),
      "DECRYPT_FAILED",
    );
    await expectCode(
      openCapsule({
        seed: recipient.seed,
        capsule: { ...capsule, capsuleId: second.capsuleId },
        aad,
      }),
      "DECRYPT_FAILED",
    );
    await expectCode(
      openCapsule({
        seed: recipient.seed,
        capsule: { ...capsule, encapsulated: second.encapsulated },
        aad,
      }),
      "DECRYPT_FAILED",
    );
    await expectCode(
      openCapsule({
        seed: recipient.seed,
        capsule: { ...capsule, sealedKey: second.sealedKey },
        aad,
      }),
      "DECRYPT_FAILED",
    );
  });

  it("rejects malformed capsules and unknown suites before decrypting", async () => {
    const recipient = await generateEncryptionKeyPair();
    const { capsule } = await createCapsule({ recipientPublicKey: recipient.publicKey, aad });

    await expectCode(
      openCapsule({
        seed: recipient.seed,
        capsule: { ...capsule, sealedKey: capsule.sealedKey.slice(1) },
        aad,
      }),
      "BAD_ENVELOPE",
    );
    await expectCode(
      openCapsule({ seed: recipient.seed, capsule: { ...capsule, suite: 2 }, aad }),
      "UNSUPPORTED_SUITE",
    );
    await expectCode(createCapsule({ recipientPublicKey: randomBytes(32), aad }), "BAD_INPUT");
  });

  it("derives a distinct object key per table, record and field", async () => {
    const capsuleKey = randomBytes(32);
    const base = { capsuleKey, table: "messages", recordId: "m1", field: "content" };
    const key = await deriveObjectKey(base);

    expect(key.length).toBe(32);
    expect(await deriveObjectKey(base)).toEqual(key);
    expect(await deriveObjectKey({ ...base, table: "titles" })).not.toEqual(key);
    expect(await deriveObjectKey({ ...base, recordId: "m2" })).not.toEqual(key);
    expect(await deriveObjectKey({ ...base, field: "title" })).not.toEqual(key);
    expect(await deriveObjectKey({ ...base, table: "messagesm1", recordId: "" })).not.toEqual(key);
  });
});

describe("request contexts", () => {
  it("encrypt in order to the recipient and share a response key", async () => {
    const worker = await generateEncryptionKeyPair();
    const sender = await openRequestSender(worker.publicKey);
    const first = await sender.seal(utf8("first"), utf8("aad-1"));
    const second = await sender.seal(utf8("second"), utf8("aad-2"));

    const recipient = await openRequestRecipient(worker.seed, sender.encapsulated);
    expect(recipient.responseKey).toEqual(sender.responseKey);
    expect(sender.responseKey.length).toBe(32);
    expect(await recipient.open(first, utf8("aad-1"))).toEqual(utf8("first"));
    expect(await recipient.open(second, utf8("aad-2"))).toEqual(utf8("second"));
  });

  it("fails for out-of-order messages, wrong AAD and a wrong recipient", async () => {
    const worker = await generateEncryptionKeyPair();
    const sender = await openRequestSender(worker.publicKey);
    await sender.seal(utf8("first"), utf8("aad"));
    const second = await sender.seal(utf8("second"), utf8("aad"));

    const recipient = await openRequestRecipient(worker.seed, sender.encapsulated);
    await expectCode(recipient.open(second, utf8("aad")), "DECRYPT_FAILED");

    const fresh = await openRequestSender(worker.publicKey);
    const message = await fresh.seal(utf8("hello"), utf8("aad"));
    const freshRecipient = await openRequestRecipient(worker.seed, fresh.encapsulated);
    await expectCode(freshRecipient.open(message, utf8("other")), "DECRYPT_FAILED");

    const stranger = await generateEncryptionKeyPair();
    const wrongRecipient = await openRequestRecipient(stranger.seed, fresh.encapsulated);
    expect(wrongRecipient.responseKey).not.toEqual(fresh.responseKey);
    await expectCode(wrongRecipient.open(message, utf8("aad")), "DECRYPT_FAILED");
  });
});
