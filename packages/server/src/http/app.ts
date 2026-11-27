import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";

import type { Ports } from "../ports/types";
import { checkHealth } from "../system/health";
import { createContext } from "../trpc/context";
import { logTRPCError } from "../trpc/init";
import { appRouter } from "../trpc/router";

export const TRPC_ENDPOINT = "/api/trpc";

/**
 * The HTTP surface behind Nitro's server entry. WebSocket upgrades never reach it: `/api/ws` is a
 * Nitro route (see `nitro.config.ts`).
 *
 * tRPC is mounted with its own Fetch adapter rather than `@hono/trpc-server`, whose options are
 * typed against `AnyRouter` and would drop the context type.
 */
export function createApp(ports: () => Promise<Ports>) {
  const app = new Hono();

  // Unauthenticated liveness/readiness probe for proxies and orchestrators.
  app.get("/api/health", async (c) => {
    const health = await checkHealth(await ports());
    return c.json(health, health.status === "ok" ? 200 : 503);
  });

  app.all(`${TRPC_ENDPOINT}/*`, async (c) => {
    const resolved = await ports();
    return fetchRequestHandler({
      endpoint: TRPC_ENDPOINT,
      req: c.req.raw,
      router: appRouter,
      createContext: () =>
        createContext(resolved, { headers: c.req.raw.headers, connectionParams: null }),
      onError: logTRPCError,
    });
  });

  return app;
}
