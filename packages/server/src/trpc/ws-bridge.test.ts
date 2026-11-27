import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import crossws from "crossws/adapters/bun";
import { z } from "zod";

import { createBunPorts } from "../ports/bun";
import type { Ports } from "../ports/types";
import { systemRouter } from "../system/router";
import { testEnv } from "../test/services";
import { createContext } from "./context";
import { publicProcedure, router } from "./init";
import { createTRPCWebSocketHooks } from "./ws-bridge";

// Probes the production router does not need: the context the socket built, and a subscription
// that only ends when the server aborts it.
const released: string[] = [];
const testRouter = router({
  system: systemRouter,
  whoami: publicProcedure.query(({ ctx }) => ({ token: ctx.connectionParams?.token ?? null })),
  forever: publicProcedure.input(z.object({ name: z.string() })).subscription(async function* ({
    input,
    signal,
  }) {
    try {
      yield "started";
      const aborted = Promise.withResolvers<void>();
      signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
    } finally {
      released.push(input.name);
    }
  }),
});

let ports: Ports;
let server: ReturnType<typeof Bun.serve>;
let socketUrl: string;

beforeAll(async () => {
  ports = await createBunPorts(testEnv);
  const { hooks } = createTRPCWebSocketHooks({
    router: testRouter,
    createContext: ({ request, connectionParams }) =>
      createContext(ports, { headers: request.headers, connectionParams }),
  });
  const ws = crossws({ hooks });

  server = Bun.serve({
    port: 0,
    websocket: ws.websocket,
    fetch: (request, bunServer) => ws.handleUpgrade(request, bunServer),
  });
  socketUrl = `ws://localhost:${server.port}/api/ws`;
});

afterAll(async () => {
  await server.stop(true);
  await ports.close();
});

function connect(connectionParams?: Record<string, string>) {
  const socket = createWSClient({ url: socketUrl, connectionParams, retryDelayMs: () => 50 });
  const client = createTRPCClient<typeof testRouter>({ links: [wsLink({ client: socket })] });
  return { socket, client };
}

function collectTicks(
  client: ReturnType<typeof connect>["client"],
  input: { count: number; lastEventId?: string },
) {
  const done = Promise.withResolvers<string[]>();
  const ids: string[] = [];
  client.system.ticks.subscribe(
    { ...input, intervalMs: 100 },
    {
      onData: ({ id }) => ids.push(id),
      onComplete: () => done.resolve(ids),
      onError: done.reject,
    },
  );
  return done.promise;
}

test("queries and subscriptions share one socket", async () => {
  const { socket, client } = connect();

  const [health, ticks] = await Promise.all([
    client.system.health.query(),
    collectTicks(client, { count: 3 }),
  ]);

  expect(health.status).toBe("ok");
  expect(ticks).toEqual(["0", "1", "2"]);
  await socket.close();
});

test("a subscription resumes after lastEventId", async () => {
  const { socket, client } = connect();

  expect(await collectTicks(client, { count: 4, lastEventId: "1" })).toEqual(["2", "3"]);
  await socket.close();
});

test("connectionParams reach the context", async () => {
  const { socket, client } = connect({ token: "worker-jwt" });

  expect(await client.whoami.query()).toEqual({ token: "worker-jwt" });
  await socket.close();
});

test("closing the socket aborts its server-side subscriptions", async () => {
  const { socket, client } = connect();
  const started = Promise.withResolvers<void>();
  client.forever.subscribe({ name: "closed-socket" }, { onData: () => started.resolve() });
  await started.promise;

  await socket.close();
  await Bun.sleep(50);
  expect(released).toContain("closed-socket");
});

/** Opens a raw socket with an explicit Origin (a Bun extension) and reports whether it was accepted. */
function openWithOrigin(origin: string) {
  const accepted = Promise.withResolvers<boolean>();
  const socket = new WebSocket(socketUrl, { headers: { origin } } as unknown as string[]);
  socket.onopen = () => {
    socket.close();
    accepted.resolve(true);
  };
  socket.onerror = () => accepted.resolve(false);
  return accepted.promise;
}

test("cross-origin browser upgrades are refused", async () => {
  expect(await openWithOrigin("https://attacker.example")).toBe(false);
});

test("same-origin browser upgrades are accepted", async () => {
  expect(await openWithOrigin(`http://localhost:${server.port}`)).toBe(true);
});
