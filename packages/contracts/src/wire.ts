import { z } from "zod";

/**
 * Schema helpers for values zod has no native type for: row ids and binary fields. Each schema they
 * build is recorded in {@link wireTypes}, so a backend adapter can map it to its own storage type
 * (the Convex backend turns ids into `v.id(table)` and bytes into `v.bytes()` in
 * `packages/backend/src/zod-validators.ts`). Schemas derived from these with `.describe()`/`.meta()`
 * are new instances and lose the mark; wrap them (`.optional()`, `z.array`, …) instead.
 */

/** Row id of `TableName`: an opaque string branded with its table. */
export type Id<TableName extends string> = string & { __tableName: TableName };

/** What a marked schema stands for. */
export type WireType = { kind: "id"; table: string } | { kind: "bytes" };

/** Marks the schemas built by {@link idOf} and {@link bytes}. */
export const wireTypes = z.registry<WireType>();

/** Schema of an id of `table`, typed {@link Id}; validates only that it is a string. */
export function idOf<TableName extends string>(table: TableName) {
  const schema = z.custom<Id<TableName>>((value) => typeof value === "string");
  wireTypes.add(schema, { kind: "id", table });
  return schema;
}

/**
 * Schema of a binary field: an `ArrayBuffer` today (the Convex `v.bytes()` shape). Every binary
 * field uses this helper, so a later switch to base64url text on the wire starts here.
 */
export function bytes() {
  const schema = z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer);
  wireTypes.add(schema, { kind: "bytes" });
  return schema;
}
