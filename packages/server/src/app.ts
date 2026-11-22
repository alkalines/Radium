import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { prepareAuthRequest } from "./auth/ingress";
import type { Runtime } from "./runtime";
import { appRouter } from "./trpc/router";

type Env = { Variables: { runtime: Runtime } };

/** The backend's Hono app. */
export type App = Hono<Env>;

/**
 * The backend's HTTP surface (`docs/Backend_Migration/Runtime.md`, HTTP surface). Browsers reach
 * it only through the web origin's `/api/*` forwarder; Workers and Gateway clients call it
 * directly.
 *
 * @param resolveRuntime the process runtime on long-lived presets, a per-request one on serverless.
 */
export function createApp(resolveRuntime: () => Promise<Runtime>): App {
  const app = new Hono<Env>();

  app.use(async (c, next) => {
    c.set("runtime", await resolveRuntime());
    await next();
  });

  // Liveness only: answers without touching Postgres or Valkey.
  app.get("/api/health", (c) => c.text("ok"));

  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const runtime = c.var.runtime;
    const prepared = await prepareAuthRequest(c.req.raw, {
      siteUrl: runtime.config.SITE_URL,
      proxySecret: runtime.config.AUTH_PROXY_SECRET,
      // srvx (Nitro's server layer) exposes the connection's peer address on the request.
      peerAddress: (c.req.raw as Request & { ip?: string }).ip ?? null,
    });
    if (prepared instanceof Response) {
      return prepared;
    }
    return await runtime.auth.handler(prepared);
  });

  app.use(
    "/api/trpc/*",
    trpcServer({
      endpoint: "/api/trpc",
      router: appRouter,
      createContext: (_options, c) => ({
        runtime: c.get("runtime") as Runtime,
        headers: c.req.raw.headers,
      }),
    }),
  );

  return app;
}
