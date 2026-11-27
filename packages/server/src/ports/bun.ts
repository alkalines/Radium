import { RedisClient, SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import type { ServerEnv } from "../env";
import { createBus } from "./bus";
import { createKv } from "./kv";
import type { Ports } from "./types";

/** Bun adapter: Bun.SQL for Postgres and Bun's built-in Valkey client. */
export async function createBunPorts(env: ServerEnv): Promise<Ports> {
  const sql = new SQL(env.DATABASE_URL);
  const redis = new RedisClient(env.VALKEY_URL);
  // A connection in subscriber mode accepts no other commands, so the bus gets its own.
  const subscriber = await redis.duplicate();

  return {
    db: drizzle({ client: sql }),
    kv: createKv((command, args) => redis.send(command, args)),
    bus: createBus({
      publish: (channel, message) => redis.publish(channel, message),
      subscribe: (channel, deliver) => subscriber.subscribe(channel, deliver),
      unsubscribe: (channel) => subscriber.unsubscribe(channel),
    }),

    async close() {
      subscriber.close();
      redis.close();
      await sql.close();
    },
  };
}
