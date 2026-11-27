import type { ServerEnv } from "../env";

/**
 * Real Postgres and Valkey from `compose.dev.yml` (CI uses service containers with the same
 * defaults). Tests never mock persistence. The database is separate from development data; Valkey
 * is shared, so tests use {@link uniqueKey} for every key and channel.
 */
export const testEnv: ServerEnv = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? "postgres://radium:radium@localhost:5432/radium_test",
  VALKEY_URL: process.env.TEST_VALKEY_URL ?? "redis://localhost:6379",
};

export function uniqueKey(name: string): string {
  return `test:${crypto.randomUUID()}:${name}`;
}
