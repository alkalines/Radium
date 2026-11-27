import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Bus } from "./bus";
import type { Kv } from "./kv";

/**
 * The query-result shape shared by both drivers: `db.execute<Row>(sql)` resolves to an array of
 * rows (Bun.SQL returns plain arrays, postgres-js array-based `RowList`s). Untyped multi-statement
 * SQL resolves to one array per statement.
 */
interface RowArrayQueryResultHKT extends PgQueryResultHKT {
  type: [this["row"]] extends ["unknown"]
    ? Record<string, unknown>[] | Record<string, unknown>[][]
    : this["row"][];
}

/**
 * The Drizzle instance. Domain code uses it directly; there is no repository layer on top. The
 * driver behind it (Bun.SQL, postgres-js) is an adapter detail.
 */
export type Database = PgAsyncDatabase<RowArrayQueryResultHKT>;

/** Runtime services every domain depends on, created once per process by a runtime adapter. */
export interface Ports {
  db: Database;
  kv: Kv;
  bus: Bus;
  /** Closes every connection. The ports are unusable afterwards. */
  close(): Promise<void>;
}
