import { drizzle } from "drizzle-orm/postgres-js";
import { Redis } from "ioredis";
import postgres from "postgres";

import type { ServerEnv } from "../env";
import { createBus, type BusListener } from "./bus";
import { createKv } from "./kv";
import type { Ports } from "./types";

/** Node adapter: postgres-js for Postgres and ioredis for Valkey. */
export async function createNodePorts(env: ServerEnv): Promise<Ports> {
  const sql = postgres(env.DATABASE_URL);
  const redis = new Redis(env.VALKEY_URL, { enableAutoPipelining: true });
  // A connection in subscriber mode accepts no other commands, so the bus gets its own.
  const subscriber = redis.duplicate();

  // ioredis reports every channel through one event; route each to its bus channel.
  const deliveries = new Map<string, BusListener>();
  subscriber.on("message", (channel: string, message: string) => {
    deliveries.get(channel)?.(message);
  });

  return {
    db: drizzle({ client: sql }),
    kv: createKv((command, args) => redis.call(command, ...args)),
    bus: createBus({
      publish: (channel, message) => redis.publish(channel, message),
      subscribe: (channel, deliver) => {
        deliveries.set(channel, deliver);
        return subscriber.subscribe(channel);
      },
      unsubscribe: (channel) => {
        deliveries.delete(channel);
        return subscriber.unsubscribe(channel);
      },
    }),

    async close() {
      await Promise.all([subscriber.quit(), redis.quit(), sql.end()]);
    },
  };
}
