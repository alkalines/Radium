import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { relations } from "../db/schema";

/**
 * Drizzle database or transaction, independent of the Postgres driver. Code outside
 * `src/drivers/` uses only this type, never a driver-specific one, so every preset runs it.
 */
export type Database = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;

/**
 * Valkey connection: one raw command with string arguments, as both `Bun.RedisClient.send` and
 * node-redis `sendCommand` take it. Typed helpers live in `src/kv.ts`.
 */
export interface Kv {
  send(command: string, args: string[]): Promise<unknown>;
}

/** Connections to the backing services, created once per process (or request, on serverless). */
export interface Drivers {
  db: Database;
  kv: Kv;
  /** Closes pools and connections; called on shutdown. */
  close(): Promise<void>;
}

/** What a driver module (`#drivers`) needs to connect. */
export type DriverOptions = {
  databaseUrl: string;
  valkeyUrl: string;
};
