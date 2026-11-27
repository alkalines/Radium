import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

import { createBunPorts } from "../ports/bun";
import type { Ports } from "../ports/types";
import { testEnv } from "../test/services";
import type { AppRouter } from "../trpc/router";
import { createApp } from "./app";

let ports: Ports;
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  ports = await createBunPorts(testEnv);
  app = createApp(async () => ports);
  server = Bun.serve({ port: 0, fetch: app.fetch });
});

afterAll(async () => {
  await server.stop(true);
  await ports.close();
});

test("GET /api/health reports both dependencies", async () => {
  const response = await app.request("/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", postgres: true, valkey: true });
});

test("GET /api/health returns 503 when a dependency is down", async () => {
  const broken: Ports = {
    ...ports,
    kv: { ...ports.kv, command: () => Promise.reject(new Error("connection refused")) },
  };
  const response = await createApp(async () => broken).request("/api/health");

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "degraded", postgres: true, valkey: false });
});

test("typed queries run over the batched HTTP endpoint", async () => {
  const trpc = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `http://localhost:${server.port}/api/trpc` })],
  });
  const [first, second] = await Promise.all([
    trpc.system.health.query(),
    trpc.system.health.query(),
  ]);

  expect(first.status).toBe("ok");
  expect(second.status).toBe("ok");
});
