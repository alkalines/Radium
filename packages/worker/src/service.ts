import { Hono } from "hono";

export const app = new Hono();

// Public liveness only. Authentication material and identity details are never returned here.
app.get("/health", (context) => context.json({ health: "ok" }));
