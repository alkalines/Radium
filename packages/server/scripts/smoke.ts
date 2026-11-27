/**
 * Transport smoke test with the vanilla tRPC client, as the Worker and CLIs use it: one query over
 * HTTP (`httpBatchLink`) and one subscription over the WebSocket (`wsLink`).
 *
 *   bun run smoke                         # server directly (http://localhost:3001)
 *   bun run smoke http://localhost:3000   # through apps/web's /api forwarding, or Caddy (:8080)
 *
 * Exits non-zero when the server is unhealthy or the subscription does not deliver 0, 1, 2.
 */
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";

import type { AppRouter } from "../src/trpc/router";

const base = new URL(process.argv[2] ?? "http://localhost:3001");
const socketUrl = new URL("/api/ws", base);
socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";

const socket = createWSClient({ url: socketUrl.href });
const client = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: wsLink({ client: socket }),
      false: httpBatchLink({ url: new URL("/api/trpc", base).href }),
    }),
  ],
});

const deadline = setTimeout(() => {
  console.error("smoke: timed out after 10 s");
  process.exit(1);
}, 10_000);

const health = await client.system.health.query();
console.log("system.health (HTTP):", health);

const ticksDone = Promise.withResolvers<number[]>();
const seen: number[] = [];
client.system.ticks.subscribe(
  { count: 3, intervalMs: 200 },
  {
    onData: ({ data }) => seen.push(data.index),
    onComplete: () => ticksDone.resolve(seen),
    onError: ticksDone.reject,
  },
);
const ticks = await ticksDone.promise;
console.log("system.ticks (WebSocket):", ticks.join(", "));

clearTimeout(deadline);
await socket.close();

if (health.status !== "ok" || ticks.join() !== "0,1,2") process.exit(1);
