import { describe, expect, it } from "vitest";
import { toHex } from "./encoding";
import { CryptoError } from "./errors";
import { hkdf, LABELS } from "./kdf";
import { fromHex } from "./test-helpers";

describe("hkdf", () => {
  it("matches RFC 5869 test case 1", async () => {
    const okm = await hkdf(
      fromHex("0b".repeat(22)),
      fromHex("f0f1f2f3f4f5f6f7f8f9"),
      42,
      fromHex("000102030405060708090a0b0c"),
    );
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  it("matches RFC 5869 test case 3 (empty salt and info)", async () => {
    const okm = await hkdf(fromHex("0b".repeat(22)), new Uint8Array(0), 42);
    expect(toHex(okm)).toBe(
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    );
  });

  it("separates labels and rejects empty key material", async () => {
    const ikm = fromHex("11".repeat(32));
    expect(await hkdf(ikm, LABELS.accountKek)).not.toEqual(await hkdf(ikm, LABELS.recoveryKek));
    await expect(hkdf(new Uint8Array(0), LABELS.object)).rejects.toThrow(CryptoError);
    await expect(hkdf(ikm, LABELS.object, 255 * 32 + 1)).rejects.toThrow(CryptoError);
  });

  it("keeps the label strings fixed and distinct", () => {
    const values = Object.values(LABELS);
    expect(new Set(values).size).toBe(values.length);
    expect(LABELS).toEqual({
      accountKek: "radium/v1/account-kek",
      recoveryKek: "radium/v1/recovery-kek",
      deviceRecovery: "radium/v1/device-recovery",
      deviceRecoveryId: "radium/v1/device-recovery-id",
      object: "radium/v1/object",
      response: "radium/v1/response",
      invite: "radium/v1/invite",
      workspacePhrase: "radium/v1/workspace-phrase",
      workspacePhraseMac: "radium/v1/workspace-phrase-mac",
      inviteMac: "radium/v1/invite-mac",
      trustStore: "radium/v1/trust-store",
      deviceWrap: "radium/v1/device-wrap",
    });
  });
});
