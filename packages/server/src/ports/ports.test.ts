import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { testEnv, uniqueKey } from "../test/services";
import { createBunPorts } from "./bun";
import { defineScript } from "./kv";
import { createNodePorts } from "./node";
import type { Ports } from "./types";

const adapters = {
  bun: createBunPorts,
  node: createNodePorts,
};

// Swaps two keys' values atomically; exercises EVALSHA and its NOSCRIPT fallback.
const swap = defineScript(`
  local a = redis.call("GET", KEYS[1])
  local b = redis.call("GET", KEYS[2])
  redis.call("SET", KEYS[1], b)
  redis.call("SET", KEYS[2], a)
  return {b, a}
`);

/** Subscribes a one-shot listener; resolves once Valkey confirmed the subscription. */
async function nextMessage(ports: Ports, channel: string) {
  const { promise, resolve } = Promise.withResolvers<string>();
  const stop = await ports.bus.subscribe(channel, resolve);
  return { message: promise, stop };
}

for (const [name, create] of Object.entries(adapters)) {
  describe(`${name} ports`, () => {
    let ports: Ports;

    beforeAll(async () => {
      ports = await create(testEnv);
    });

    afterAll(async () => {
      await ports.close();
    });

    test("db runs queries against Postgres", async () => {
      const [row] = await ports.db.execute<{ answer: number }>(sql`select 41 + 1 as answer`);
      expect(Number(row?.answer)).toBe(42);
    });

    test("kv set honors onlyIfAbsent and ttl", async () => {
      const key = uniqueKey("set");

      expect(await ports.kv.set(key, "first", { onlyIfAbsent: true })).toBe(true);
      expect(await ports.kv.set(key, "second", { onlyIfAbsent: true })).toBe(false);
      expect(await ports.kv.get(key)).toBe("first");

      expect(await ports.kv.set(key, "short-lived", { ttlMs: 50 })).toBe(true);
      await Bun.sleep(120);
      expect(await ports.kv.get(key)).toBeNull();
    });

    test("kv increment, expire and delete", async () => {
      const key = uniqueKey("counter");

      expect(await ports.kv.increment(key)).toBe(1);
      expect(await ports.kv.increment(key)).toBe(2);
      expect(await ports.kv.expire(key, 60_000)).toBe(true);
      expect(await ports.kv.expire(uniqueKey("missing"), 60_000)).toBe(false);
      expect(await ports.kv.delete(key, uniqueKey("missing"))).toBe(1);
      expect(await ports.kv.get(key)).toBeNull();
    });

    test("kv eval reloads a script after the script cache is flushed", async () => {
      const a = uniqueKey("a");
      const b = uniqueKey("b");
      await ports.kv.set(a, "1");
      await ports.kv.set(b, "2");

      await ports.kv.command("SCRIPT", ["FLUSH"]);
      expect(await ports.kv.eval(swap, [a, b], [])).toEqual(["2", "1"]);
      expect(await ports.kv.eval(swap, [a, b], [])).toEqual(["1", "2"]);

      await ports.kv.delete(a, b);
    });

    test("bus delivers to every local listener and stops after unsubscribe", async () => {
      const channel = uniqueKey("bus");
      const first: string[] = [];
      const second: string[] = [];
      const stopFirst = await ports.bus.subscribe(channel, (message) => first.push(message));
      const stopSecond = await ports.bus.subscribe(channel, (message) => second.push(message));

      const echo = await nextMessage(ports, channel);
      await ports.bus.publish(channel, "one");
      await echo.message;
      await echo.stop();
      expect(first).toEqual(["one"]);
      expect(second).toEqual(["one"]);

      await stopFirst();
      const afterUnsubscribe = await nextMessage(ports, channel);
      await ports.bus.publish(channel, "two");
      await afterUnsubscribe.message;
      await afterUnsubscribe.stop();
      expect(first).toEqual(["one"]);
      expect(second).toEqual(["one", "two"]);

      await stopSecond();
    });
  });
}

test("bus messages cross between Bun and Node processes' adapters", async () => {
  const bun = await createBunPorts(testEnv);
  const node = await createNodePorts(testEnv);
  const channel = uniqueKey("cross");

  try {
    const received = await nextMessage(node, channel);
    await bun.bus.publish(channel, "hello");
    expect(await received.message).toBe("hello");
    await received.stop();
  } finally {
    await Promise.all([bun.close(), node.close()]);
  }
});

test("migrations apply and are recorded once", async () => {
  const client = new SQL(testEnv.DATABASE_URL);
  const db = drizzle({ client });
  const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

  try {
    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder });

    const [applied] = await db.execute<{ count: string }>(
      sql`select count(*) as count from drizzle.__drizzle_migrations`,
    );
    expect(Number(applied?.count)).toBe(readMigrationFiles({ migrationsFolder }).length);
  } finally {
    await client.close();
  }
});
