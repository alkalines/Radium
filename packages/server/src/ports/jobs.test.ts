import { expect, test } from "bun:test";

import { startJobRunner } from "./jobs";

test("drains back-to-back while work remains, then idles until woken", async () => {
  let remaining = 3;
  let drains = 0;
  const runner = startJobRunner({
    drain: async () => {
      drains++;
      if (remaining > 0) remaining--;
      return remaining > 0;
    },
    idleMs: 60_000,
    onError: (error) => {
      throw error;
    },
  });

  await Bun.sleep(20);
  expect(remaining).toBe(0);
  expect(drains).toBe(3);

  runner.wake();
  await Bun.sleep(20);
  expect(drains).toBe(4);

  await runner.stop();
});

test("a wake during a drain triggers another drain instead of being lost", async () => {
  let drains = 0;
  let runner: ReturnType<typeof startJobRunner> | undefined;
  runner = startJobRunner({
    drain: async () => {
      drains++;
      // New work committed while this drain was already past its claim query.
      await Bun.sleep(1);
      if (drains === 1) runner?.wake();
      return false;
    },
    idleMs: 60_000,
    onError: (error) => {
      throw error;
    },
  });

  await Bun.sleep(20);
  expect(drains).toBe(2);
  await runner.stop();
});

test("reports failed drains and retries after the idle delay", async () => {
  const errors: unknown[] = [];
  let drains = 0;
  const runner = startJobRunner({
    drain: async () => {
      drains++;
      if (drains === 1) throw new Error("database unavailable");
      return false;
    },
    idleMs: 20,
    onError: (error) => errors.push(error),
  });

  await Bun.sleep(5);
  expect(errors).toHaveLength(1);
  expect(drains).toBe(1);

  await Bun.sleep(100);
  expect(drains).toBeGreaterThanOrEqual(2);
  expect(errors).toHaveLength(1);
  await runner.stop();
});

test("stop aborts the drain signal and waits for the drain to return", async () => {
  let finished = false;
  const runner = startJobRunner({
    drain: async (signal) => {
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      await Bun.sleep(10);
      finished = true;
      return true;
    },
    idleMs: 60_000,
    onError: (error) => {
      throw error;
    },
  });

  await Bun.sleep(5);
  await runner.stop();
  expect(finished).toBe(true);
});
