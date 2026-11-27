import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { mountFileRoutes } from "./chatroom/files-http";
import { activeRunStream, handleChat } from "./chatroom/run";
import { clientAddress, prepareAuthRequest } from "./auth/ingress";
import { mountGatewayRoutes } from "./gateway/http";
import type { Runtime } from "./runtime";
import { appRouter } from "./trpc/router";
import { mountShapeRoutes } from "./shapes/http";
import { mountStreamRoutes } from "./streams/http";
import { mountWorkerAuthRoutes } from "./worker/http";

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
      peerAddress: peerAddress(c.req.raw),
    });
    if (prepared instanceof Response) {
      return prepared;
    }
    return await runtime.auth.handler(prepared);
  });

  mountGatewayRoutes(app);
  mountFileRoutes(app);
  mountWorkerAuthRoutes(app);
  mountStreamRoutes(app);
  mountShapeRoutes(app);
  app.post("/api/chat", (c) => handleChat(c.var.runtime, c.req.raw));
  app.get("/api/chat/:chat/stream", (c) =>
    activeRunStream(c.var.runtime, c.req.raw, c.req.param("chat")),
  );

  app.use(
    "/api/trpc/*",
    trpcServer({
      endpoint: "/api/trpc",
      router: appRouter,
      createContext: (_options, c) => {
        const runtime = c.get("runtime") as Runtime;
        return {
          runtime,
          headers: c.req.raw.headers,
          clientAddress: () =>
            clientAddress(c.req.raw, peerAddress(c.req.raw), runtime.config.AUTH_PROXY_SECRET),
        };
      },
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          console.error(`tRPC ${path ?? "?"} failed:`, internalErrorSummary(error.cause));
        }
      },
    }),
  );

  return app;
}

/** The connection's peer address: srvx (Nitro's server layer) exposes it on the request. */
function peerAddress(request: Request): string | null {
  return (request as Request & { ip?: string }).ip ?? null;
}

/**
 * What an internal error may log: the innermost cause's name and message. Drizzle's own query
 * error is skipped because its message lists the statement's parameters (user data, key
 * material); the driver error under it names the failed constraint or condition only.
 */
function internalErrorSummary(error: unknown): string {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  if (!(current instanceof Error) || current.name === "DrizzleQueryError") {
    return "unknown error";
  }
  return `${current.name}: ${current.message.slice(0, 200)}`;
}
