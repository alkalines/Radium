import { sql } from "drizzle-orm";
import { createDatabase } from "#drivers";
import { migrate } from "../src/db/migrate";
import { databaseUrl, TEMPLATE_DATABASE, TEST_POSTGRES_URL } from "./services";

/**
 * Builds the template database once per run: dropped, recreated and migrated with the real
 * runner, so every test starts from exactly what `db:migrate` produces on an empty database.
 * The template's connections are closed before tests clone it (Postgres refuses to copy a
 * database that has open connections).
 */
export default async function setup() {
  const admin = createDatabase(TEST_POSTGRES_URL);
  try {
    await admin.db.execute(sql.raw(`drop database if exists ${TEMPLATE_DATABASE} with (force)`));
    await admin.db.execute(sql.raw(`create database ${TEMPLATE_DATABASE}`));
  } finally {
    await admin.close();
  }

  const template = createDatabase(databaseUrl(TEMPLATE_DATABASE));
  try {
    await migrate(template.db);
  } finally {
    await template.close();
  }
}
