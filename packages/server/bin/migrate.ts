import { parseArgs } from "node:util";
import { createDatabase } from "#drivers";
import { backfills } from "../src/db/backfills";
import { migrate } from "../src/db/migrate";

/**
 * `bun run db:migrate [--to <migration>]`: applies pending migrations and backfills. Use a direct
 * `DATABASE_URL`, never a pooler: the run holds an advisory lock in a long transaction. Only
 * `DATABASE_URL` is read; migrating never needs the server's secrets.
 */
const { values } = parseArgs({ options: { to: { type: "string" } } });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabase(databaseUrl);
try {
  const result = await migrate(database.db, { backfills, to: values.to });
  console.log(`Applied ${result.migrations.length} migration(s)`, result.migrations);
  console.log(`Ran ${result.backfills.length} backfill(s)`, result.backfills);
} finally {
  await database.close();
}
