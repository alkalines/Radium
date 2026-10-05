import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import betterAuth from "@convex-dev/better-auth/convex.config";
import migrations from "@convex-dev/migrations/convex.config.js";
import secretStore from "convex-secret-store/convex.config.js";
import logging from "./components/logging/convex.config.js";
import workerIdentity from "worker-component/convex.config.js";

const app = defineApp();
app.use(betterAuth);
app.use(rateLimiter);
app.use(migrations);
app.use(logging);
// This component persists enrollment hashes and Worker public keys only.
// WORKER_AUTH_PRIVATE_JWK / WORKER_AUTH_JWKS belong to the parent app:
// src/worker/auth.ts signs tokens; auth.config.ts configures their verification.
// Set those deployment variables; do not pass issuer keys into this component.
app.use(workerIdentity);
app.use(secretStore, {
  env: {
    SECRET_STORE_KEYS: process.env.SECRET_STORE_KEYS!,
  },
});

export default app;
