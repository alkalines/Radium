import assert from "node:assert/strict";
import { test } from "bun:test";

import { logger } from "./server";

test("console logger emits the shared envelope and isolates sink failures", () => {
  const original = console.log;
  const events: unknown[] = [];
  try {
    console.log = (event: unknown) => {
      events.push(event);
    };
    logger.warn("provider.unavailable", { timestamp: 1_000 });
    assert.deepEqual(events, [
      {
        version: 1,
        level: "warn",
        event: "provider.unavailable",
        product: "radium",
        source: "convex",
        timestamp: 1_000,
      },
    ]);
    logger.info("invalid.event", { metadata: { apiKey: "not-for-logging" } });
    assert.equal(events.length, 1);
    console.log = () => {
      throw new Error("sink unavailable");
    };
    assert.doesNotThrow(() => logger.error("operation.failed"));
  } finally {
    console.log = original;
  }
});
