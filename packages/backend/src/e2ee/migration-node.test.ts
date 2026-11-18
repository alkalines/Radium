import { toBase64Url, utf8 } from "radium-crypto";
import { describe, expect, it } from "vitest";
import { MAX_SEAL_PLAINTEXT_BYTES } from "./migration-contract";
import { base64UrlInto, base64UrlLength, legacyPlaintext } from "./migration-node";

function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 131 + 17) & 255;
  return bytes;
}

describe("legacy sidecar serialization", () => {
  it("encodes base64url exactly like the shared encoder for every remainder", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 64, 65, 66, 4099]) {
      const source = pattern(length);
      const target = new Uint8Array(base64UrlLength(length) + 2);
      const end = base64UrlInto(source, target, 1);
      expect(end, `${length}`).toBe(1 + base64UrlLength(length));
      expect(new TextDecoder().decode(target.subarray(1, end)), `${length}`).toBe(toBase64Url(source));
      expect(target[0]).toBe(0);
      expect(target[end]).toBe(0);
    }
  });

  it("keeps the JSON format of an attachment sidecar byte-for-byte", () => {
    const value = { filename: "a \"quoted\" name.png", mediaType: "image/png", size: 5, note: null, gone: undefined };
    for (const length of [0, 1, 2, 3, 1000]) {
      const bytes = pattern(length);
      const plain = legacyPlaintext(value, { field: "fileBytes", encoding: "base64", bytes });
      expect(new TextDecoder().decode(plain)).toBe(JSON.stringify({ ...value, fileBytes: toBase64Url(bytes) }));
    }
    const empty = legacyPlaintext({}, { field: "fileBytes", encoding: "base64", bytes: pattern(4) });
    expect(new TextDecoder().decode(empty)).toBe(JSON.stringify({ fileBytes: toBase64Url(pattern(4)) }));
  });

  it("splices text sources as one escaped JSON string and keeps a leading BOM", () => {
    const text = "\ufeffline\n\"two\" \u2028 \ud83d\ude00";
    const plain = legacyPlaintext({ meta: { role: "user" } }, { field: "content", encoding: "text", bytes: utf8(text) });
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ meta: { role: "user" }, content: text });
    expect(new TextDecoder().decode(plain)).toBe(JSON.stringify({ meta: { role: "user" }, content: text }));
    expect(() => legacyPlaintext({}, { field: "content", encoding: "text", bytes: new Uint8Array([0xff, 0xfe, 0x41]) })).toThrow();
  });

  it("serializes content without a storage source as plain JSON", () => {
    expect(new TextDecoder().decode(legacyPlaintext({ title: "t", n: 1 }))).toBe(JSON.stringify({ title: "t", n: 1 }));
  });

  it("rejects an over-bound plaintext before allocating it", () => {
    const huge = { length: Math.ceil((MAX_SEAL_PLAINTEXT_BYTES * 3) / 4) + 1 } as unknown as Uint8Array;
    expect(() => legacyPlaintext({}, { field: "fileBytes", encoding: "base64", bytes: huge })).toThrow("sealing bound");
  });
});
