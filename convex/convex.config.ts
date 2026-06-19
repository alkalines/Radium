import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";
import secretStore from "convex-secret-store/convex.config.js";

const app = defineApp();
app.use(betterAuth);
app.use(secretStore, {
  env: {
    SECRET_STORE_KEYS: process.env.SECRET_STORE_KEYS!,
  },
});

export default app;
