import { RedisClient, SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { relations } from "../db/schema";
import type { Database, DriverOptions, Drivers } from "./types";

/**
 * Drivers of the `bun` preset: `Bun.SQL` under Drizzle and `Bun.RedisClient`. Selected at build
 * time through the `#drivers` alias, so other presets never bundle or reference `bun`.
 */

/** Postgres alone, for tools that need no Valkey (`bin/migrate.ts`). */
export function createDatabase(databaseUrl: string): { db: Database; close(): Promise<void> } {
  const client = new SQL(databaseUrl);
  return { db: drizzle({ client, relations }), close: () => client.close() };
}

export function createDrivers(options: DriverOptions): Drivers {
  const database = createDatabase(options.databaseUrl);
  const kv = new RedisClient(options.valkeyUrl);
  return {
    db: database.db,
    kv,
    async close() {
      kv.close();
      await database.close();
    },
  };
}
