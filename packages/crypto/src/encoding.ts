import { CryptoError } from "./errors";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Built on first decode rather than at import, so importing the package does no work.
let base64UrlLookup: Int16Array | undefined;

function getBase64UrlLookup(): Int16Array {
  if (base64UrlLookup === undefined) {
    const lookup = new Int16Array(128).fill(-1);
    for (let index = 0; index < BASE64URL_ALPHABET.length; index++) {
      lookup[BASE64URL_ALPHABET.charCodeAt(index)] = index;
    }
    base64UrlLookup = lookup;
  }
  return base64UrlLookup;
}

/** Encodes bytes as unpadded base64url (RFC 4648 §5), the wire form of every byte field in key bundles. */
export function toBase64Url(bytes: Uint8Array): string {
  let text = "";
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    text +=
      BASE64URL_ALPHABET[chunk >> 18]! +
      BASE64URL_ALPHABET[(chunk >> 12) & 63]! +
      BASE64URL_ALPHABET[(chunk >> 6) & 63]! +
      BASE64URL_ALPHABET[chunk & 63]!;
  }

  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index]! << 16;
    text += BASE64URL_ALPHABET[chunk >> 18]! + BASE64URL_ALPHABET[(chunk >> 12) & 63]!;
  } else if (remaining === 2) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    text +=
      BASE64URL_ALPHABET[chunk >> 18]! +
      BASE64URL_ALPHABET[(chunk >> 12) & 63]! +
      BASE64URL_ALPHABET[(chunk >> 6) & 63]!;
  }

  return text;
}

/**
 * Decodes unpadded base64url strictly: padding, whitespace, the standard-alphabet `+`/`/`, impossible
 * lengths and non-zero trailing bits are rejected, so every byte string has exactly one accepted
 * encoding and length checks after decoding are meaningful. Throws `CryptoError("BAD_INPUT")`.
 */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) {
    throw new CryptoError("BAD_INPUT", "Invalid base64url length");
  }

  const lookup = getBase64UrlLookup();
  const output = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bufferedBits = 0;
  let outputIndex = 0;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? lookup[code]! : -1;
    if (value < 0) {
      throw new CryptoError("BAD_INPUT", "Invalid base64url character");
    }

    buffer = ((buffer << 6) | value) & 0xffffff;
    bufferedBits += 6;
    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      output[outputIndex++] = (buffer >> bufferedBits) & 0xff;
    }
  }

  // Leftover bits must be zero, otherwise two different strings would decode to the same bytes.
  if ((buffer & ((1 << bufferedBits) - 1)) !== 0) {
    throw new CryptoError("BAD_INPUT", "Non-canonical base64url encoding");
  }

  return output;
}

/** UTF-8 encodes text (labels, AAD parts, IDs). */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Returns cryptographically secure random bytes from `crypto.getRandomValues`.
 *
 * Convex queries and mutations seed this deterministically, so callers there must not use it for keys,
 * nonces or encapsulations (Keys.md "Convex runtime"); actions and clients may.
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new CryptoError("BAD_INPUT", "Invalid random length");
  }

  const bytes = new Uint8Array(length);
  // getRandomValues fills at most 65536 bytes per call.
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, length)));
  }
  return bytes;
}

/**
 * Compares two byte strings. For equal lengths the running time does not depend on where they differ;
 * different lengths return `false` immediately (lengths of keys and tags are public).
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

/** Concatenates byte strings into a new array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/**
 * Concatenates parts as `u32-be length ‖ bytes` each, the unambiguous encoding behind AAD, signing
 * messages, fingerprints and object-key info: no two different part lists produce the same bytes.
 */
export function lengthPrefixed(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += 4 + part.length;
  }

  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    output.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return output;
}

/** Lowercase hexadecimal, used for displayed fingerprints and test vectors. */
export function toHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}

/** Throws `BAD_INPUT` unless `bytes` has exactly `length` bytes; message names the field, never the value. */
export function assertLength(bytes: Uint8Array, length: number, name: string): void {
  if (bytes.length !== length) {
    throw new CryptoError("BAD_INPUT", `${name} must be ${length} bytes`);
  }
}

/**
 * Narrows a `Uint8Array` for WebCrypto, whose typings require an `ArrayBuffer` backing store. Every
 * array this package handles is ArrayBuffer-backed; a SharedArrayBuffer view would be rejected by
 * WebCrypto at runtime.
 */
export function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}
