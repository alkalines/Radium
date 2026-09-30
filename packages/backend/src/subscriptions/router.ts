import type { HonoWithConvex } from "convex-helpers/server/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ActionCtx } from "../../convex/_generated/server";
import { handleChatGPTSubscription } from "./chatgpt";

/** Mounted at /api/subscription; new subscription providers share this CORS policy. */
export const subscriptionRouter: HonoWithConvex<ActionCtx> = new Hono();

subscriptionRouter.use(
  "*",
  cors({
    origin: (origin) => {
      const siteUrl = process.env.SITE_URL;
      return siteUrl && origin === new URL(siteUrl).origin ? origin : "";
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

subscriptionRouter.on(["GET", "POST"], "/chatgpt-subscription/*", (c) =>
  handleChatGPTSubscription(c.env, c.req.raw),
);
