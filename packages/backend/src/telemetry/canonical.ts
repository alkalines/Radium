/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization: object keys sorted by UTF-16 code
 * units, no whitespace, ECMAScript number and string serialization. Arrays keep their order.
 * Equal JSON values always produce identical strings, so the result is safe to hash.
 *
 * Like `JSON.stringify`, `undefined` object members are omitted. Values JSON cannot represent
 * (non-finite numbers, bigint, functions, symbols, `undefined` array items) throw.
 */
export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  write(value, parts);
  return parts.join("");
}

function write(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number.");
      // ECMAScript Number serialization is the RFC 8785 number format; -0 serializes as 0.
      out.push(JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize a ${typeof value} value.`);
  }

  if (Array.isArray(value)) {
    out.push("[");
    for (let index = 0; index < value.length; index++) {
      if (index > 0) out.push(",");
      const item = value[index];
      if (item === undefined) throw new TypeError("Cannot canonicalize an undefined array item.");
      write(item, out);
    }
    out.push("]");
    return;
  }

  const record = value as Record<string, unknown>;
  // Default sort compares UTF-16 code units, which is the order RFC 8785 requires.
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  out.push("{");
  keys.forEach((key, index) => {
    if (index > 0) out.push(",");
    out.push(JSON.stringify(key), ":");
    write(record[key], out);
  });
  out.push("}");
}
