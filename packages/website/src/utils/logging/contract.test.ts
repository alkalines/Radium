import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLoggingEnvelope,
  isLoggingEnvelopeWithinLimits,
  LOGGING_LIMITS,
  type LoggingEnvelope,
} from "./contract";

const validEvent: LoggingEnvelope = createLoggingEnvelope({
  level: "info",
  event: "app.loaded",
  source: "frontend",
  product: "radium",
  timestamp: 1_000,
  metadata: { runtime: "browser" },
});

test("accepts a bounded operational envelope", () => {
  assert.equal(isLoggingEnvelopeWithinLimits(validEvent, 2_000), true);
});

test("rejects sensitive-shaped metadata keys", () => {
  assert.equal(
    isLoggingEnvelopeWithinLimits(
      { ...validEvent, metadata: { apiKey: "should-not-be-logged" } },
      2_000,
    ),
    false,
  );
});

test("rejects a future client timestamp", () => {
  assert.equal(
    isLoggingEnvelopeWithinLimits({ ...validEvent, timestamp: Date.now() + 6 * 60_000 }),
    false,
  );
});

test("does not serialize undefined optional fields", () => {
  assert.deepEqual(
    createLoggingEnvelope({ level: "debug", event: "app.started", timestamp: 1_000 }),
    {
      version: 1,
      level: "debug",
      event: "app.started",
      source: "frontend",
      product: "radium",
      timestamp: 1_000,
    },
  );
});

test("rejects metadata over the entry limit", () => {
  const metadata = Object.fromEntries(
    Array.from({ length: LOGGING_LIMITS.maxMetadataEntries + 1 }, (_, index) => [
      `field${index}`,
      "value",
    ]),
  );

  assert.equal(isLoggingEnvelopeWithinLimits({ ...validEvent, metadata }, 2_000), false);
});

test("rejects unsafe correlation values", () => {
  assert.equal(
    isLoggingEnvelopeWithinLimits(
      { ...validEvent, correlation: { requestId: "request with spaces" } },
      2_000,
    ),
    false,
  );
});

test("rejects an unserializable runtime value without throwing", () => {
  const envelope = { ...validEvent };
  Object.defineProperty(envelope, "toJSON", {
    value: () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    },
  });

  assert.equal(isLoggingEnvelopeWithinLimits(envelope as unknown as LoggingEnvelope, 2_000), false);
});
