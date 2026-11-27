import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ready as opaqueReady, server as opaqueServer } from "@serenity-kit/opaque";
import { sql } from "drizzle-orm";
import { createDatabase, createDrivers } from "#drivers";
import { createApp, type App } from "../src/app";
import { loadConfig } from "../src/config";
import type { JobHandlers } from "../src/jobs/outbox";
import { checkRuntime, createRuntime, driverOptions, type Runtime } from "../src/runtime";
import {
  databaseUrl,
  TEMPLATE_DATABASE,
  TEST_POSTGRES_URL,
  TEST_STREAMS_TOKEN,
  TEST_STREAMS_URL,
  TEST_VALKEY_URL,
} from "./services";

/** Web origin the test runtimes trust; auth requests must send it as `Origin`. */
export const TEST_SITE_URL = "http://localhost:3000";

/** Secret Store KEK (version 1) of every test runtime; standard base64 of 32 bytes. */
export const TEST_SECRET_STORE_KEY = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";

export type TestRuntime = {
  runtime: Runtime;
  app: App;
  /** Closes the current connections and builds a new runtime on the same database and Valkey. */
  restart(): Promise<void>;
  /** Closes connections and drops the database. */
  close(): Promise<void>;
};

/**
 * A runtime on a fresh database cloned from the migrated template, and a Valkey database of its
 * own (one per Vitest worker, flushed here; files of one worker run one after another). Passes
 * the same start checks as production.
 */
export async function createTestRuntime(
  options: { jobs?: JobHandlers; env?: Record<string, string> } = {},
): Promise<TestRuntime> {
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(TEST_POSTGRES_URL);
  try {
    await admin.db.execute(sql.raw(`create database ${name} template ${TEMPLATE_DATABASE}`));
  } finally {
    await admin.close();
  }

  await opaqueReady;
  // Each runtime gets its own object directory (local-disk adapter), removed on close.
  const filesDir = await mkdtemp(join(tmpdir(), "radium-files-"));
  const config = loadConfig({
    SITE_URL: TEST_SITE_URL,
    API_URL: "http://localhost:3100",
    DATABASE_URL: databaseUrl(name),
    // Valkey has 16 databases; Vitest pool ids start at 1. A second concurrent run shifts by
    // `TEST_VALKEY_DB_OFFSET` (8) so the two never flush each other's database.
    VALKEY_URL: `${TEST_VALKEY_URL}/${(Number(process.env.VITEST_POOL_ID ?? "1") + Number(process.env.TEST_VALKEY_DB_OFFSET ?? "0")) % 16}`,
    STREAMS_URL: TEST_STREAMS_URL,
    STREAMS_TOKEN: TEST_STREAMS_TOKEN,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    OPAQUE_SERVER_SETUP: opaqueServer.createSetup(),
    SECRET_STORE_KEYS: `1:${TEST_SECRET_STORE_KEY}`,
    TELEMETRY_HASH_SECRET: "ZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5_gIGCg4Q",
    ...(options.env?.S3_BUCKET ? {} : { FILES_DIR: filesDir }),
    ...options.env,
  });

  const start = async () => {
    const drivers = createDrivers(driverOptions(config));
    const runtime = createRuntime(config, drivers, options.jobs);
    await checkRuntime(runtime);
    return runtime;
  };

  let runtime = await start();
  await runtime.drivers.kv.send("FLUSHDB", []);

  const test: TestRuntime = {
    runtime,
    app: createApp(async () => test.runtime),
    async restart() {
      await runtime.drivers.close();
      runtime = await start();
      test.runtime = runtime;
    },
    async close() {
      await runtime.drivers.close();
      await rm(filesDir, { recursive: true, force: true });
      const cleanup = createDatabase(TEST_POSTGRES_URL);
      try {
        await cleanup.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
      } finally {
        await cleanup.close();
      }
    },
  };
  return test;
}
