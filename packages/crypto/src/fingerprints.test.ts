import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors";
import { fingerprint, safetyNumber } from "./fingerprints";

function identity(fill: number) {
  return {
    encryptionPublicKey: new Uint8Array(1216).fill(fill),
    signingPublicKey: new Uint8Array(32).fill(fill + 1),
  };
}

describe("fingerprint", () => {
  it("is 8 groups of 4 hex digits and covers both keys", async () => {
    const value = await fingerprint(identity(1));
    expect(value).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
    expect(await fingerprint(identity(1))).toBe(value);

    const otherSigning = { ...identity(1), signingPublicKey: new Uint8Array(32).fill(9) };
    const otherEncryption = { ...identity(1), encryptionPublicKey: new Uint8Array(1216).fill(9) };
    expect(await fingerprint(otherSigning)).not.toBe(value);
    expect(await fingerprint(otherEncryption)).not.toBe(value);
  });

  it("rejects keys of the wrong size", async () => {
    await expect(
      fingerprint({
        encryptionPublicKey: new Uint8Array(32),
        signingPublicKey: new Uint8Array(32),
      }),
    ).rejects.toThrow(CryptoError);
  });
});

describe("safetyNumber", () => {
  it("is 12 groups of 5 digits, symmetric, and specific to the pair", async () => {
    const forward = await safetyNumber(identity(1), identity(3));
    expect(forward).toMatch(/^\d{5}( \d{5}){11}$/);
    expect(await safetyNumber(identity(3), identity(1))).toBe(forward);
    expect(await safetyNumber(identity(1), identity(5))).not.toBe(forward);
    expect(await safetyNumber(identity(1), identity(1))).not.toBe(forward);
  });
});
