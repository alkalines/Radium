import { definePlugin } from "nitro";

import { readEnv } from "../env";
import { closePorts, getPorts } from "../ports";

/**
 * Validates configuration at boot, so a misconfigured server exits instead of failing its first
 * request, and closes the database and Valkey connections when Nitro shuts down.
 */
export default definePlugin((nitroApp) => {
  readEnv();

  // Connect eagerly so the first request does not pay for it; failures are retried per request.
  getPorts().catch((error: unknown) => {
    console.error("[server] could not connect to Postgres/Valkey", error);
  });

  nitroApp.hooks?.hook("close", closePorts);
});
