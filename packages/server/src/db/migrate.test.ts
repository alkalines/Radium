import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "#drivers";
import { databaseUrl, TEST_POSTGRES_URL } from "../../test/services";
import type { Database } from "../drivers/types";
import { hasSchemaVersion, migrate, type Backfill } from "./migrate";

// The runner on an empty database with throwaway migration folders: ordering, --to, the
// narrowing gate, refusal of edited or unknown migrations, and two concurrent runs.

let name: string;
let database: { db: Database; close(): Promise<void> };
let folder: string;

async function writeMigration(migration: string, statements: string[]) {
  await mkdir(join(folder, migration), { recursive: true });
  await writeFile(
    join(folder, migration, "migration.sql"),
    statements.join("\n--> statement-breakpoint\n"),
  );
}

async function tables(db: Database) {
  const rows = await db
    .select({ name: sql<string>`table_name` })
    .from(sql`information_schema.tables`)
    .where(sql`table_schema = 'public'`);
  return rows.map((row) => row.name).toSorted();
}

beforeEach(async () => {
  name = `migrate_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(TEST_POSTGRES_URL);
  await admin.db.execute(sql.raw(`create database ${name}`));
  await admin.close();
  database = createDatabase(databaseUrl(name));
  folder = await mkdtemp(join(tmpdir(), "radium-migrations-"));
  await writeMigration("20260101000000_first", ["create table first (id text primary key)"]);
  await writeMigration("20260102000000_second", [
    "create table second (id text primary key, value text)",
  ]);
});

afterEach(async () => {
  await database.close();
  await rm(folder, { recursive: true, force: true });
  const admin = createDatabase(TEST_POSTGRES_URL);
  await admin.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
  await admin.close();
});

describe("migrate", () => {
  it("applies migrations in order, stops at --to, and is idempotent", async () => {
    const { db } = database;
    expect(await hasSchemaVersion(db, "20260101000000_first")).toBe(false);

    expect(await migrate(db, { migrationsFolder: folder, to: "20260101000000_first" })).toEqual({
      migrations: ["20260101000000_first"],
      backfills: [],
    });
    expect(await tables(db)).toEqual(["first"]);
    expect(await hasSchemaVersion(db, "20260101000000_first")).toBe(true);
    expect(await hasSchemaVersion(db, "20260102000000_second")).toBe(false);

    expect((await migrate(db, { migrationsFolder: folder })).migrations).toEqual([
      "20260102000000_second",
    ]);
    expect((await migrate(db, { migrationsFolder: folder })).migrations).toEqual([]);
    expect(await tables(db)).toEqual(["first", "second"]);
  });

  it("serializes concurrent runs so each migration applies once", async () => {
    const results = await Promise.all([
      migrate(database.db, { migrationsFolder: folder }),
      migrate(database.db, { migrationsFolder: folder }),
    ]);
    expect(results.flatMap((result) => result.migrations).toSorted()).toEqual([
      "20260101000000_first",
      "20260102000000_second",
    ]);
  });

  it("rolls back a failing migration entirely", async () => {
    await writeMigration("20260103000000_broken", [
      "create table third (id text)",
      "select no_such_function()",
    ]);
    await expect(migrate(database.db, { migrationsFolder: folder })).rejects.toThrow();
    expect(await tables(database.db)).toEqual(["first", "second"]);
    expect(await hasSchemaVersion(database.db, "20260103000000_broken")).toBe(false);
  });

  it("refuses an edited or unknown applied migration", async () => {
    await migrate(database.db, { migrationsFolder: folder });

    await writeMigration("20260102000000_second", ["create table second (id text primary key)"]);
    await expect(migrate(database.db, { migrationsFolder: folder })).rejects.toThrow(
      /changed after it was applied/,
    );

    await rm(join(folder, "20260102000000_second"), { recursive: true });
    await expect(migrate(database.db, { migrationsFolder: folder })).rejects.toThrow(
      /does not know/,
    );
  });

  it("runs a backfill after its migration and gates the narrowing migration on a clean verify", async () => {
    let issues = 1;
    const fill: Backfill = {
      name: "0001_fill_value",
      after: "20260102000000_second",
      narrowedBy: "20260103000000_narrow",
      run: async (db) => {
        await db.execute(sql`update second set value = 'filled' where value is null`);
      },
      verify: async () => ({ missing_value: issues }),
    };
    await writeMigration("20260103000000_narrow", [
      "alter table second alter column value set not null",
    ]);

    const first = migrate(database.db, { migrationsFolder: folder, backfills: [fill] });
    await expect(first).rejects.toThrow(/needs backfill "0001_fill_value"/);
    expect(await hasSchemaVersion(database.db, "20260102000000_second")).toBe(true);
    expect(await hasSchemaVersion(database.db, "20260103000000_narrow")).toBe(false);

    // The next run reruns the backfill; once it verifies clean, the narrowing applies.
    issues = 0;
    expect(await migrate(database.db, { migrationsFolder: folder, backfills: [fill] })).toEqual({
      migrations: ["20260103000000_narrow"],
      backfills: ["0001_fill_value"],
    });
    // A clean backfill never runs again.
    expect(await migrate(database.db, { migrationsFolder: folder, backfills: [fill] })).toEqual({
      migrations: [],
      backfills: [],
    });
  });
});
