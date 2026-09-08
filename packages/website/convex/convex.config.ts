import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import betterAuth from "@convex-dev/better-auth/convex.config";
import secretStore from "convex-secret-store/convex.config.js";
import logging from "./components/logging/convex.config.js";

const app = defineApp();
app.use(betterAuth);
app.use(rateLimiter);
app.use(logging);
app.use(secretStore, {
  env: {
    SECRET_STORE_KEYS: process.env.SECRET_STORE_KEYS!,
  },
});

export default app;
