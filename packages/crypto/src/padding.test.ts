import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors";
import { pad, unpad } from "./padding";

describe("pad", () => {
  it("uses 32-byte buckets for short fields (sizes include the 4-byte prefix)", () => {
    const cases: Array<[number, number]> = [
      [0, 32],
      [28, 32],
      [29, 64],
      [60, 64],
      [61, 96],
    ];
    for (const [dataLength, expected] of cases) {
      expect(pad(new Uint8Array(dataLength), "short").length, `${dataLength}`).toBe(expected);
    }
  });

  it("uses powers of two up to 4 KiB, then 4 KiB multiples, for content", () => {
    const cases: Array<[number, number]> = [
      [0, 32],
      [28, 32],
      [29, 64],
      [100, 128],
      [1000, 1024],
      [4092, 4096],
      [4093, 8192],
      [8188, 8192],
      [8189, 12288],
      [100_000, 102_400],
    ];
    for (const [dataLength, expected] of cases) {
      expect(pad(new Uint8Array(dataLength), "content").length, `${dataLength}`).toBe(expected);
    }
  });

  it("round-trips through unpad", () => {
    const data = new TextEncoder().encode("hello radium");
    expect(unpad(pad(data, "short"))).toEqual(data);
    expect(unpad(pad(data, "content"))).toEqual(data);
    expect(unpad(pad(new Uint8Array(0), "content"))).toEqual(new Uint8Array(0));
  });
});

describe("unpad", () => {
  it("rejects non-zero fill, a length beyond the buffer and a truncated prefix", () => {
    const padded = pad(Uint8Array.of(1, 2, 3), "short");

    const dirtyFill = padded.slice();
    dirtyFill[padded.length - 1] = 1;
    expect(() => unpad(dirtyFill)).toThrow(CryptoError);

    const overlong = padded.slice();
    overlong[3] = 200;
    expect(() => unpad(overlong)).toThrow(CryptoError);

    expect(() => unpad(Uint8Array.of(0, 0, 0))).toThrow(CryptoError);
  });
});
