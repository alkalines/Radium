import { CryptoError } from "./errors";

const LENGTH_PREFIX_BYTES = 4;
const SHORT_BUCKET_BYTES = 32;
const CONTENT_MIN_BYTES = 32;
const CONTENT_PAGE_BYTES = 4096;
const MAX_DATA_BYTES = 0xffffffff - LENGTH_PREFIX_BYTES;

/** Padded size for `framedLength` (data plus the 4-byte prefix) under Keys.md "Padding". */
function paddedLength(framedLength: number, mode: "short" | "content"): number {
  if (mode === "short") {
    return Math.ceil(framedLength / SHORT_BUCKET_BYTES) * SHORT_BUCKET_BYTES;
  }

  if (framedLength > CONTENT_PAGE_BYTES) {
    return Math.ceil(framedLength / CONTENT_PAGE_BYTES) * CONTENT_PAGE_BYTES;
  }

  // Next power of two, starting at the short bucket size so tiny content does not get finer buckets.
  let bucket = CONTENT_MIN_BYTES;
  while (bucket < framedLength) {
    bucket *= 2;
  }
  return bucket;
}

/**
 * Hides plaintext length before encryption. Output: 4-byte big-endian data length, the data, then zero
 * fill up to the bucket. `short` (titles, names, notification bodies) uses 32-byte buckets; `content`
 * uses powers of two from 32 bytes up to 4 KiB, then 4 KiB multiples. Sizes include the prefix.
 */
export function pad(data: Uint8Array, mode: "short" | "content"): Uint8Array {
  if (data.length > MAX_DATA_BYTES) {
    throw new CryptoError("BAD_INPUT", "Data too large to pad");
  }

  const padded = new Uint8Array(paddedLength(LENGTH_PREFIX_BYTES + data.length, mode));
  new DataView(padded.buffer).setUint32(0, data.length);
  padded.set(data, LENGTH_PREFIX_BYTES);
  return padded;
}

/**
 * Reverses `pad` for either mode. Rejects a length prefix beyond the buffer and any non-zero fill, so a
 * padded plaintext has exactly one valid reading. Throws `BAD_INPUT`.
 */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_PREFIX_BYTES) {
    throw new CryptoError("BAD_INPUT", "Invalid padding");
  }

  const dataLength = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  const dataEnd = LENGTH_PREFIX_BYTES + dataLength;
  if (dataEnd > padded.length) {
    throw new CryptoError("BAD_INPUT", "Invalid padding");
  }

  let fill = 0;
  for (let index = dataEnd; index < padded.length; index++) {
    fill |= padded[index]!;
  }
  if (fill !== 0) {
    throw new CryptoError("BAD_INPUT", "Invalid padding");
  }

  return padded.slice(LENGTH_PREFIX_BYTES, dataEnd);
}
