import { fileURLToPath } from "node:url";
import { defineConfig } from "nitro";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Nitro builds the Hono app in `server.ts` for one deployment preset. Only the `bun` preset is
 * supported until the portable drivers and serverless spikes land
 * (`docs/Backend_Migration/Runtime.md`).
 */
export default defineConfig({
  preset: "bun",
  serverDir: false,
  serverEntry: "./server.ts",
  // Driver selection happens here, at build time; the `bun` preset gets the Bun drivers.
  alias: { "#drivers": path("./src/drivers/bun.ts") },
  // Provided by the runtime, never bundled.
  rolldownConfig: { external: ["bun"] },
  // Starts and checks the runtime before traffic; closes it on shutdown.
  plugins: [path("./src/plugins/runtime.ts")],
  experimental: { tasks: true },
  tasks: {
    "jobs:sweep": { handler: path("./src/jobs/tasks/sweep.ts") },
    "limits:poll": { handler: path("./src/jobs/tasks/limits-poll.ts") },
    retention: { handler: path("./src/jobs/tasks/retention.ts") },
  },
  scheduledTasks: {
    "* * * * *": ["jobs:sweep"],
    "*/5 * * * *": ["limits:poll", "retention"],
  },
});
