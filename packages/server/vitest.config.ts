import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Runs under Bun (`bun --bun vitest`), because the drivers are `Bun.SQL` and `Bun.RedisClient`,
// against the real Postgres and Valkey of docker-compose.test.yml. Each test file gets its own
// database cloned from a migrated template (test/global-setup.ts, test/runtime.ts).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Each worker uses its own Valkey database, and Valkey has 16.
    maxWorkers: 8,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
