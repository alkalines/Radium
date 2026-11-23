import { createDrivers } from "#drivers";
import { createAuth, type Auth } from "./auth/auth";
import { loadConfig, type Config } from "./config";
import { hasSchemaVersion } from "./db/migrate";
import { SCHEMA_VERSION } from "./db/schema-version";
import type { DriverOptions, Drivers } from "./drivers/types";
import { SecretKeyring } from "./gateway/secrets";
import { jobHandlers } from "./jobs/handlers";
import type { JobHandlers } from "./jobs/outbox";
import { createWorkerTokenVerifier, type WorkerTokenVerifier } from "./worker/auth";

/**
 * Everything a request, job or task works with. Routes and services receive it through the Hono
 * and tRPC context, never from a module singleton, so long-lived presets (one runtime per
 * process) and serverless presets (one per request) run the same code.
 */
export interface Runtime {
  config: Config;
  drivers: Drivers;
  auth: Auth;
  workerTokens: WorkerTokenVerifier | null;
  /** Key-encryption keys of the Secret Store (`gateway/secrets.ts`). */
  secrets: SecretKeyring;
  /**
   * Outbound HTTP to upstream providers (Gateway inference, usage-limit polls). The global
   * `fetch` in production; tests replace it so they never touch the network.
   */
  fetch: typeof fetch;
  jobs: JobHandlers;
  /**
   * Keeps work running after the response (after-commit job dispatch). Failures are logged, never
   * thrown: the outbox sweep retries anything that did not finish.
   */
  defer(work: Promise<unknown>): void;
}

/** Builds a runtime from parsed configuration and open drivers. */
export function createRuntime(
  config: Config,
  drivers: Drivers,
  jobs: JobHandlers = jobHandlers,
): Runtime {
  return {
    config,
    drivers,
    auth: createAuth({
      db: drivers.db,
      kv: drivers.kv,
      siteUrl: config.SITE_URL,
      secret: config.BETTER_AUTH_SECRET,
      opaqueServerSetup: config.OPAQUE_SERVER_SETUP,
    }),
    workerTokens: createWorkerTokenVerifier(config.API_URL, config.WORKER_AUTH_JWKS),
    secrets: new SecretKeyring(config.SECRET_STORE_KEYS),
    fetch: globalThis.fetch.bind(globalThis),
    jobs,
    defer(work) {
      work.catch((error: unknown) => {
        console.error(
          "Deferred work failed:",
          error instanceof Error ? error.message : "unknown error",
        );
      });
    },
  };
}

/** What the drivers connect to, from the validated configuration. */
export function driverOptions(config: Config): DriverOptions {
  return {
    databaseUrl: config.DATABASE_URL,
    valkeyUrl: config.VALKEY_URL,
    objects: config.S3_BUCKET
      ? {
          kind: "s3",
          bucket: config.S3_BUCKET,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          region: config.S3_REGION,
          endpoint: config.S3_ENDPOINT,
          sessionToken: config.S3_SESSION_TOKEN,
        }
      : { kind: "disk", dir: config.FILES_DIR! },
  };
}

/**
 * Startup checks of a runtime: the database has every migration this build expects (the server
 * never migrates on its own; operators run `db:migrate`), and the OPAQUE server setup is valid.
 * Throws with an operator-facing message.
 */
export async function checkRuntime(runtime: Runtime) {
  if (!(await hasSchemaVersion(runtime.drivers.db, SCHEMA_VERSION))) {
    throw new Error(
      `The database is behind this build (needs ${SCHEMA_VERSION}); run db:migrate first`,
    );
  }
  await runtime.auth.api.validateOpaqueSetup();
}

let processRuntime: Promise<Runtime> | undefined;

/**
 * The runtime of a long-lived process (`bun`, `node_server`, `deno_server` presets): configured
 * from the environment, connected and checked once, on first use. A failed start is not cached
 * as success; every caller sees the same rejection.
 */
export function useProcessRuntime(): Promise<Runtime> {
  processRuntime ??= (async () => {
    const config = loadConfig(process.env);
    const drivers = createDrivers(driverOptions(config));
    const runtime = createRuntime(config, drivers);
    try {
      await checkRuntime(runtime);
    } catch (error) {
      await drivers.close();
      throw error;
    }
    return runtime;
  })();
  return processRuntime;
}

/** Closes the process runtime's connections on shutdown. */
export async function closeProcessRuntime() {
  const runtime = await processRuntime?.catch(() => undefined);
  processRuntime = undefined;
  await runtime?.drivers.close();
}
