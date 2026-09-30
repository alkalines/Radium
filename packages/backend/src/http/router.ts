import type { HonoWithConvex } from "convex-helpers/server/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ActionCtx } from "../../convex/_generated/server";
import { subscriptionRouter } from "../subscriptions/router";
import { handleAISDKChat } from "./aisdk.chat";
import { handleChatCompletion } from "./chat_completion";
import { handleOpenAIModels } from "./models";
import { allowedSiteOrigin } from "./cors";

/** Application HTTP routes; the adapter supplies the Convex action context as c.env. */
export const app: HonoWithConvex<ActionCtx> = new Hono();

app.post("/api/openai/v1/chat/completions", (c) => handleChatCompletion(c.env, c.req.raw));
app.get("/api/openai/v1/models", (c) => handleOpenAIModels(c.env, c.req.raw));

app.use(
  "/api/aisdk/chat",
  cors({
    origin: allowedSiteOrigin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "OPTIONS"],
  }),
);
app.post("/api/aisdk/chat", (c) => handleAISDKChat(c.env, c.req.raw));

app.route("/api/subscription", subscriptionRouter);
