/**
 * Id of a new row: a UUIDv7 string (RFC 9562), so ids sort roughly by creation time and index
 * inserts stay local. Imported Convex rows keep their own `_id`; never parse or assume an id
 * format, since both kinds share every `text` id column.
 */
export function newId(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  // 48-bit big-endian Unix milliseconds.
  let millis = now;
  for (let index = 5; index >= 0; index--) {
    bytes[index] = millis % 256;
    millis = Math.floor(millis / 256);
  }

  // Version 7 in the high nibble of byte 6, RFC 4122 variant in the top bits of byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
