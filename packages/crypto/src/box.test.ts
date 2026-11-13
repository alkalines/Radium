import { describe, expect, it } from "vitest";
import type { AadParts } from "./aad";
import {
  CAPSULE_BYTES,
  decodeCapsule,
  encodeCapsule,
  hmacSha256,
  openBox,
  openWithCapsule,
  sealBox,
  sealWithCapsule,
} from "./box";
import { randomBytes, utf8 } from "./encoding";
import { CryptoError } from "./errors";
import { createCapsule, generateEncryptionKeyPair, openCapsule } from "./kem";

const aad: AadParts = {
  table: "e2ee_chat_key_wraps",
  workspace: "ws1",
  parent: "chat1",
  record: "1",
  field: "key1",
};

async function expectCode(promise: Promise<unknown>, code: CryptoError["code"]) {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof CryptoError && error.code === code,
  );
}

describe("sealBox / openBox", () => {
  it("round-trips and rejects a wrong recipient, AAD or a box spliced from two boxes", async () => {
    const recipient = await generateEncryptionKeyPair();
    const other = await generateEncryptionKeyPair();
    const plaintext = randomBytes(32);

    const box = await sealBox({
      recipientPublicKey: recipient.publicKey,
      plaintext,
      aad,
      pad: "none",
    });
    expect(await openBox({ seed: recipient.seed, box, aad, pad: "none" })).toEqual(plaintext);

    await expectCode(openBox({ seed: other.seed, box, aad, pad: "none" }), "DECRYPT_FAILED");
    await expectCode(
      openBox({ seed: recipient.seed, box, aad: { ...aad, record: "2" }, pad: "none" }),
      "DECRYPT_FAILED",
    );

    // Capsule of one box with the envelope of another: the keyRef no longer names the capsule.
    const second = await sealBox({
      recipientPublicKey: recipient.publicKey,
      plaintext,
      aad,
      pad: "none",
    });
    const spliced = new Uint8Array([
      ...box.subarray(0, CAPSULE_BYTES),
      ...second.subarray(CAPSULE_BYTES),
    ]);
    await expectCode(
      openBox({ seed: recipient.seed, box: spliced, aad, pad: "none" }),
      "BAD_ENVELOPE",
    );
    await expectCode(
      openBox({ seed: recipient.seed, box: box.subarray(0, CAPSULE_BYTES), aad }),
      "BAD_ENVELOPE",
    );
  });
});

describe("capsule batches", () => {
  it("encodes capsules losslessly and opens each object only under its own AAD", async () => {
    const chat = await generateEncryptionKeyPair();
    const capsuleAad = { ...aad, table: "e2ee_capsules", field: "capsule" };
    const { capsule, capsuleKey } = await createCapsule({
      recipientPublicKey: chat.publicKey,
      aad: capsuleAad,
    });
    const encoded = encodeCapsule(capsule);
    expect(encoded.length).toBe(CAPSULE_BYTES);
    expect(decodeCapsule(encoded)).toEqual(capsule);

    const first = { ...aad, table: "chat_messages", record: "m1", field: "message" };
    const second = { ...first, record: "m2" };
    const envelope = await sealWithCapsule({
      capsuleKey,
      capsuleId: capsule.capsuleId,
      plaintext: utf8("hello"),
      aad: first,
    });

    const reopenedKey = await openCapsule({
      seed: chat.seed,
      capsule: decodeCapsule(encoded),
      aad: capsuleAad,
    });
    expect(await openWithCapsule({ capsuleKey: reopenedKey, envelope, aad: first })).toEqual(
      utf8("hello"),
    );
    await expectCode(
      openWithCapsule({ capsuleKey: reopenedKey, envelope, aad: second }),
      "DECRYPT_FAILED",
    );
  });
});

describe("hmacSha256", () => {
  it("separates part boundaries", async () => {
    const key = randomBytes(32);
    const joined = await hmacSha256(key, [utf8("ab"), utf8("c")]);
    const split = await hmacSha256(key, [utf8("a"), utf8("bc")]);
    expect(joined).not.toEqual(split);
  });
});
