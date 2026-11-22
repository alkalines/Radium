/**
 * Where tests find Postgres and Valkey: docker-compose.test.yml by default, overridable for CI.
 * The Postgres URL must allow creating databases; tests create one per file and drop it after.
 */
export const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? "postgres://radium:radium-test@127.0.0.1:55432/radium";
export const TEST_VALKEY_URL = process.env.TEST_VALKEY_URL ?? "redis://127.0.0.1:56379";

/** Database every test database is cloned from, migrated once per run. */
export const TEMPLATE_DATABASE = "radium_test_template";

/** `TEST_POSTGRES_URL` pointing at another database on the same server. */
export function databaseUrl(name: string) {
  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;
  return url.toString();
}
