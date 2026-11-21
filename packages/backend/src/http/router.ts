import type { HonoWithConvex } from "convex-helpers/server/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ActionCtx } from "../../convex/_generated/server";
import { subscriptionRouter } from "../subscriptions/router";
import { handleAISDKChat } from "./aisdk.chat";
import { handleChatCompletion } from "./chat_completion";
import { handleOpenAIModels } from "./models";
import { allowedSiteOrigin } from "./cors";
import { handleWorkerAuth } from "./worker";
import { maintenanceGate } from "../maintenance";

/** Application HTTP routes; the adapter supplies the Convex action context as c.env. */
export const app: HonoWithConvex<ActionCtx> = new Hono();

app.use(
  "/api/aisdk/chat",
  cors({
    origin: allowedSiteOrigin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "OPTIONS"],
  }),
);

// Subscription routes apply their own CORS and maintenance gate, so they are mounted before the
// application-wide gate below.
app.route("/api/subscription", subscriptionRouter);

// Maintenance mode refuses non-safe requests before every route registered after it.
app.use("*", maintenanceGate);

app.post("/api/worker/auth/challenge", (c) => handleWorkerAuth(c.env, c.req.raw, "challenge"));
app.post("/api/worker/auth/complete", (c) => handleWorkerAuth(c.env, c.req.raw, "complete"));

app.post("/api/openai/v1/chat/completions", (c) => handleChatCompletion(c.env, c.req.raw));
app.get("/api/openai/v1/models", (c) => handleOpenAIModels(c.env, c.req.raw));

app.post("/api/aisdk/chat", (c) => handleAISDKChat(c.env, c.req.raw));
