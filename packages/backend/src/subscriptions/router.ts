import type { HonoWithConvex } from "convex-helpers/server/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ActionCtx } from "../../convex/_generated/server";
import { handleChatGPTSubscription } from "./chatgpt";
import { allowedSiteOrigin } from "../http/cors";
import { maintenanceResponse, writesClosed } from "../maintenance";

/** Mounted at /api/subscription; new subscription providers share this CORS policy. */
export const subscriptionRouter: HonoWithConvex<ActionCtx> = new Hono();

subscriptionRouter.use(
  "*",
  cors({
    origin: allowedSiteOrigin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

// Status and session reads (GET) bind or clear ChatGPT credentials and store session state, so
// while browser writes are closed this router refuses every method except CORS preflight.
subscriptionRouter.use("*", async (c, next) => {
  if (c.req.method !== "OPTIONS" && writesClosed("browser")) return maintenanceResponse();
  await next();
});

subscriptionRouter.on(["GET", "POST"], "/chatgpt-subscription/*", (c) =>
  handleChatGPTSubscription(c.env, c.req.raw),
);
