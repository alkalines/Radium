import { describe, expect, it } from "vitest";
import {
  equalBytes,
  fromBase64Url,
  lengthPrefixed,
  randomBytes,
  toBase64Url,
  utf8,
} from "./encoding";
import { CryptoError } from "./errors";

describe("base64url", () => {
  it("round-trips every remainder length without padding", () => {
    for (let length = 0; length < 70; length++) {
      const bytes = randomBytes(length);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it("matches RFC 4648 test vectors in the URL alphabet", () => {
    expect(toBase64Url(utf8("foobar"))).toBe("Zm9vYmFy");
    expect(toBase64Url(utf8("fo"))).toBe("Zm8");
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
  });

  it("rejects padding, the standard alphabet, impossible lengths and non-canonical trailing bits", () => {
    for (const text of ["Zm8=", "+/8", "Zm9vY", "Zm9", "Zm8 ", "Zm9\u00e9"]) {
      // "Zm9" decodes "fo" with a non-zero trailing bit pattern; canonical is "Zm8".
      expect(() => fromBase64Url(text), text).toThrow(CryptoError);
    }
  });
});

describe("equalBytes", () => {
  it("compares content and length", () => {
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(false);
  });
});

describe("lengthPrefixed", () => {
  it("keeps part boundaries unambiguous", () => {
    const ab = lengthPrefixed([utf8("a"), utf8("bc")]);
    const abShifted = lengthPrefixed([utf8("ab"), utf8("c")]);
    expect(equalBytes(ab, abShifted)).toBe(false);
    expect(ab).toEqual(Uint8Array.of(0, 0, 0, 1, 0x61, 0, 0, 0, 2, 0x62, 0x63));
  });
});
