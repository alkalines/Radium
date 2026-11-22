import { eq, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { bigint, jsonb, pgSchema, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { Database } from "../drivers/types";

/**
 * Schema migration runner behind `db:migrate` (policy: `docs/Backend_Migration/Runtime.md`,
 * schema migrations). It applies the SQL migrations `drizzle-kit generate` writes to `drizzle/`,
 * each in its own transaction, interleaved with data backfills, under one advisory lock so two
 * runs never overlap. Applied migrations are recorded in Drizzle's own table
 * (`drizzle.__drizzle_migrations`, same columns), so Drizzle's tooling reads the same history.
 *
 * Drizzle's built-in `migrate()` is not used: it applies everything pending in one transaction
 * and has no place for backfills, the narrowing gate or `--to` (the Convex importer stops at the
 * baseline).
 */

/** Folder of the generated SQL migrations. */
export const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

/**
 * A data backfill between two schema migrations. `run` is idempotent, bounded and resumable;
 * `verify` checks exhaustively and returns issue counts by kind (all zero means clean).
 */
export type Backfill = {
  name: string;
  /** Migration that must be applied first (usually the widening one). */
  after: string;
  /** Narrowing migration that refuses to apply until this backfill verified clean. */
  narrowedBy?: string;
  run(db: Database): Promise<void>;
  verify(db: Database): Promise<Record<string, number>>;
};

export type MigrateResult = { migrations: string[]; backfills: string[] };

// Bookkeeping tables live in the `drizzle` schema, outside the app schema that drizzle-kit diffs.
const bookkeeping = pgSchema("drizzle");

/** Drizzle's migrations table, same definition as Drizzle's own migrator creates. */
const appliedMigrations = bookkeeping.table("__drizzle_migrations", {
  id: serial("id").primaryKey(),
  hash: text("hash").notNull(),
  createdAt: bigint("created_at", { mode: "number" }),
  name: text("name"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow(),
});

/** The last verify result of each backfill; a backfill is done once its issues are all zero. */
const backfillRuns = bookkeeping.table("backfills", {
  name: text("name").primaryKey(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  issues: jsonb("issues").$type<Record<string, number>>().notNull(),
});

async function ensureBookkeeping(db: Database) {
  await db.execute(sql`create schema if not exists drizzle`);
  await db.execute(sql`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint,
      name text,
      applied_at timestamp with time zone default now()
    )`);
  await db.execute(sql`
    create table if not exists drizzle.backfills (
      name text primary key,
      verified_at timestamptz not null,
      issues jsonb not null
    )`);
}

/** Runs `backfill` and records its verify result. */
async function runBackfill(db: Database, backfill: Backfill) {
  await backfill.run(db);
  const issues = await backfill.verify(db);
  const verifiedAt = new Date();
  await db
    .insert(backfillRuns)
    .values({ name: backfill.name, verifiedAt, issues })
    .onConflictDoUpdate({ target: backfillRuns.name, set: { verifiedAt, issues } });
  return issues;
}

function isClean(issues: Record<string, number> | undefined) {
  return issues !== undefined && Object.values(issues).every((count) => count === 0);
}

/**
 * Brings the database to the newest migration in `migrationsFolder`, or to `to`.
 *
 * Refuses to run when the database has a migration this build doesn't know or whose file changed
 * since it was applied: merged migrations are never edited, and an older build must not migrate a
 * newer database. A narrowing migration refuses to apply until every backfill naming it in
 * `narrowedBy` has recorded a clean verify. A backfill runs after its migration on every run until
 * its verify is clean (`run` is idempotent and resumable), then never again.
 */
export async function migrate(
  db: Database,
  options: { migrationsFolder?: string; backfills?: readonly Backfill[]; to?: string } = {},
): Promise<MigrateResult> {
  const local = readMigrationFiles({
    migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER,
  });
  const backfills = options.backfills ?? [];
  const result: MigrateResult = { migrations: [], backfills: [] };

  let lastIndex = local.length - 1;
  if (options.to !== undefined) {
    lastIndex = local.findIndex((migration) => migration.name === options.to);
    if (lastIndex === -1) {
      throw new Error(`Unknown migration "${options.to}"`);
    }
  }

  // The lock lives as long as this transaction; the work runs on other connections.
  await db.transaction(async (lock) => {
    await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended('radium:db:migrate', 0))`);
    await ensureBookkeeping(db);

    const applied = new Set<string>();
    for (const row of await db.select().from(appliedMigrations)) {
      const known = local.find((migration) => migration.name === row.name);
      if (!known) {
        throw new Error(`The database has migration "${row.name}", which this build does not know`);
      }
      if (known.hash !== row.hash) {
        throw new Error(`Migration "${row.name}" changed after it was applied`);
      }
      applied.add(row.name!);
    }

    const verified = new Map<string, Record<string, number>>();
    for (const row of await db.select().from(backfillRuns)) {
      verified.set(row.name, row.issues);
    }

    for (const migration of local.slice(0, lastIndex + 1)) {
      const name = migration.name!;
      if (!applied.has(name)) {
        for (const backfill of backfills) {
          if (backfill.narrowedBy === name && !isClean(verified.get(backfill.name))) {
            throw new Error(
              `Migration "${name}" needs backfill "${backfill.name}" to verify clean first`,
            );
          }
        }
        await db.transaction(async (tx) => {
          for (const statement of migration.sql) {
            if (statement.trim()) {
              await tx.execute(sql.raw(statement));
            }
          }
          await tx
            .insert(appliedMigrations)
            .values({ hash: migration.hash, createdAt: migration.folderMillis, name });
        });
        result.migrations.push(name);
      }

      for (const backfill of backfills) {
        if (backfill.after === name && !isClean(verified.get(backfill.name))) {
          verified.set(backfill.name, await runBackfill(db, backfill));
          result.backfills.push(backfill.name);
        }
      }
    }
  });

  return result;
}

/**
 * Whether the database has applied `version`, the newest migration this build was generated
 * with. A database ahead of the build passes (widen-before-narrow keeps older builds working);
 * one behind it fails.
 */
export async function hasSchemaVersion(db: Database, version: string): Promise<boolean> {
  // An empty database has no migrations table yet; querying it would fail.
  const [table] = await db
    .select({ exists: sql<boolean>`to_regclass('drizzle.__drizzle_migrations') is not null` })
    .from(sql`(values (1)) as probe(x)`);
  if (!table?.exists) {
    return false;
  }
  const rows = await db
    .select({ id: appliedMigrations.id })
    .from(appliedMigrations)
    .where(eq(appliedMigrations.name, version))
    .limit(1);
  return rows.length > 0;
}
