import { defineApp } from "convex/server";
import { v } from "convex/values";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import betterAuth from "@convex-dev/better-auth/convex.config";
import migrations from "@convex-dev/migrations/convex.config.js";
import secretStore from "convex-secret-store/convex.config.js";
import logging from "./components/logging/convex.config.js";
import workerIdentity from "worker-component/convex.config.js";

const app = defineApp({
  env: {
    SITE_URL: v.string(),
    SECRET_STORE_KEYS: v.string(),
    AISDK_MaxRetries: v.optional(v.string()),
    LWC_SECRET: v.optional(v.string()),
    OTEL_EXPORTER_OTLP_ENDPOINT: v.optional(v.string()),
    OTEL_EXPORTER_OTLP_HEADERS: v.optional(v.string()),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: v.optional(v.string()),
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: v.optional(v.string()),
    OTEL_SERVICE_NAME: v.optional(v.string()),
    WORKER_AUTH_JWKS: v.optional(v.string()),
    WORKER_AUTH_PRIVATE_JWK: v.optional(v.string()),
  },
});
app.use(betterAuth);
app.use(rateLimiter);
app.use(migrations);
app.use(logging);
// This component persists enrollment hashes and Worker public keys only.
// Issuer keys stay in the parent app: src/worker/auth.ts signs tokens and
// auth.config.ts configures their verification. Do not pass them to this component.
app.use(workerIdentity);
app.use(secretStore, {
  env: {
    SECRET_STORE_KEYS: app.env.SECRET_STORE_KEYS,
  },
});

export default app;
