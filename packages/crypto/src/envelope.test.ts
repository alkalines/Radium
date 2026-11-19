import { describe, expect, it } from "vitest";
import type { AadParts } from "./aad";
import { randomBytes, utf8 } from "./encoding";
import { decodeEnvelope, encodeEnvelope, openSym, sealSym } from "./envelope";
import { CryptoError } from "./errors";

const aad: AadParts = {
  table: "messages",
  workspace: "ws1",
  parent: "chat1",
  record: "msg1",
  field: "content",
};
const key = randomBytes(32);
const keyRef = randomBytes(16);
const plaintext = utf8("the quick brown fox");

async function expectCode(promise: Promise<unknown>, code: CryptoError["code"]) {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof CryptoError && error.code === code,
  );
}

describe("sealSym / openSym", () => {
  it("round-trips with padding by default and exposes the header", async () => {
    const envelope = await sealSym({ key, keyRef, plaintext, aad });
    const decoded = decodeEnvelope(envelope);

    expect(decoded).toMatchObject({ version: 1, suite: 1, kind: "sym", keyRef });
    // 31-byte header + 32-byte content bucket + 16-byte tag
    expect(envelope.length).toBe(31 + 32 + 16);
    expect(await openSym({ key, envelope, aad })).toEqual(plaintext);
    expect(encodeEnvelope(decoded)).toEqual(envelope);
  });

  it("uses a fresh nonce per seal", async () => {
    const first = decodeEnvelope(await sealSym({ key, keyRef, plaintext, aad }));
    const second = decodeEnvelope(await sealSym({ key, keyRef, plaintext, aad }));
    expect(first.nonce).not.toEqual(second.nonce);
  });

  it("supports unpadded and capsule-kind envelopes", async () => {
    const envelope = await sealSym({ key, keyRef, plaintext, aad, kind: "capsule", pad: "none" });
    expect(envelope.length).toBe(31 + plaintext.length + 16);
    expect(decodeEnvelope(envelope).kind).toBe("capsule");
    expect(await openSym({ key, envelope, aad, pad: "none" })).toEqual(plaintext);
  });

  it("fails for a wrong key or any wrong AAD part", async () => {
    const envelope = await sealSym({ key, keyRef, plaintext, aad });
    await expectCode(openSym({ key: randomBytes(32), envelope, aad }), "DECRYPT_FAILED");

    for (const part of Object.keys(aad) as Array<keyof AadParts>) {
      await expectCode(
        openSym({ key, envelope, aad: { ...aad, [part]: `${aad[part]}x` } }),
        "DECRYPT_FAILED",
      );
    }
    // Moving a value between adjacent parts changes the length-prefixed encoding too.
    await expectCode(
      openSym({ key, envelope, aad: { ...aad, parent: "chat1msg1", record: "" } }),
      "DECRYPT_FAILED",
    );
  });

  it("fails when any header byte is modified", async () => {
    const envelope = await sealSym({ key, keyRef, plaintext, aad });

    const flippedKind = envelope.slice();
    flippedKind[2] = 1; // sym -> capsule
    await expectCode(openSym({ key, envelope: flippedKind, aad }), "DECRYPT_FAILED");

    for (const offset of [3, 10, 18]) {
      const wrongKeyRef = envelope.slice();
      wrongKeyRef[offset]! ^= 1;
      await expectCode(openSym({ key, envelope: wrongKeyRef, aad }), "DECRYPT_FAILED");
    }

    const wrongNonce = envelope.slice();
    wrongNonce[20]! ^= 1;
    await expectCode(openSym({ key, envelope: wrongNonce, aad }), "DECRYPT_FAILED");

    const wrongSuite = envelope.slice();
    wrongSuite[1] = 2;
    await expectCode(openSym({ key, envelope: wrongSuite, aad }), "UNSUPPORTED_SUITE");

    const wrongVersion = envelope.slice();
    wrongVersion[0] = 2;
    await expectCode(openSym({ key, envelope: wrongVersion, aad }), "BAD_ENVELOPE");

    const unknownKind = envelope.slice();
    unknownKind[2] = 3;
    await expectCode(openSym({ key, envelope: unknownKind, aad }), "BAD_ENVELOPE");
  });

  it("fails for a modified or truncated body", async () => {
    const envelope = await sealSym({ key, keyRef, plaintext, aad });

    const flippedBody = envelope.slice();
    flippedBody[envelope.length - 1]! ^= 1;
    await expectCode(openSym({ key, envelope: flippedBody, aad }), "DECRYPT_FAILED");

    await expectCode(
      openSym({ key, envelope: envelope.slice(0, envelope.length - 1), aad }),
      "DECRYPT_FAILED",
    );
    await expectCode(openSym({ key, envelope: envelope.slice(0, 31 + 15), aad }), "BAD_ENVELOPE");
  });

  it("rejects wrong key and keyRef sizes", async () => {
    await expectCode(sealSym({ key: randomBytes(16), keyRef, plaintext, aad }), "BAD_INPUT");
    await expectCode(sealSym({ key, keyRef: randomBytes(15), plaintext, aad }), "BAD_INPUT");
  });
});
