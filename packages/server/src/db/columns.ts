import { sql } from "drizzle-orm";
import { check, customType, jsonb, text, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { newId } from "./ids";

/**
 * Column conventions shared by every domain schema (`docs/Backend_Migration/Runtime.md`,
 * database conventions). Domains own their tables; only these building blocks are shared.
 */

/** `text` primary key; new rows get a UUIDv7, imported rows keep their Convex `_id`. */
export const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => newId());

/** Microsecond `timestamptz`, the type of every point in time. */
export const instant = (name: string) => timestamp(name, { precision: 6, withTimezone: true });

/** `created_at`, replacing Convex `_creationTime`. Orderings by it break ties by `id`. */
export const createdAt = () => instant("created_at").notNull().defaultNow();

/** `bytea` read and written as `Uint8Array` (drivers return a `Buffer`, which is one). */
export const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  codec: "bytea",
});

/**
 * The stored form of a contracts shape inside `jsonb`: every binary field (`ArrayBuffer` in
 * `contracts/wire` `bytes()`) is unpadded base64url text, the planned wire format. Binary at the
 * top level of a row is a `bytea` column instead ({@link bytes}).
 */
export type StoredJson<T> = T extends ArrayBuffer | Uint8Array
  ? string
  : T extends readonly (infer Item)[]
    ? StoredJson<Item>[]
    : T extends object
      ? { [Key in keyof T]: StoredJson<T[Key]> }
      : T;

/**
 * `jsonb` for a nested shape that SQL never filters on, typed as the stored form of `T`. Services
 * parse it with the contracts zod schema at the boundary; shapes SQL queries become columns.
 */
export const json = <T>(name: string) => jsonb(name).$type<StoredJson<T>>();

/**
 * The values of a contracts enum (a zod union of string literals, a literal, or `z.enum`), so a
 * `text` enum column and its {@link checkIn} constraint follow the contract instead of a copy.
 */
export function literals<const Value extends string>(
  schema: z.ZodType<Value>,
): [Value, ...Value[]] {
  const values = literalValues(schema);
  if (values.length === 0) throw new Error("literals: the schema has no values");
  return values as [Value, ...Value[]];
}

function literalValues(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodEnum) return schema.options.map(String);
  if (schema instanceof z.ZodLiteral) return [...schema.values].map(String);
  if (schema instanceof z.ZodUnion)
    return schema.options.flatMap((option) => literalValues(option as z.ZodType));
  throw new Error("literals: expected string literals, a union of them, or z.enum");
}

/**
 * `check (<column> in (...))` for a `text` enum column (no `pgEnum`, so widening is a new
 * migration of the check only). Values are code constants, inlined as SQL string literals.
 */
export function checkIn(name: string, column: AnyPgColumn, values: readonly string[]) {
  const list = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return check(name, sql`${column} in (${sql.raw(list)})`);
}
