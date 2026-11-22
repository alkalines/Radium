import { customType, text, timestamp } from "drizzle-orm/pg-core";
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
