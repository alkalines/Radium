import { expect, test } from "vitest";

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
  expect(isLoggingEnvelopeWithinLimits(validEvent, 2_000)).toBe(true);
});

test("rejects sensitive-shaped metadata keys", () => {
  expect(
    isLoggingEnvelopeWithinLimits(
      { ...validEvent, metadata: { apiKey: "should-not-be-logged" } },
      2_000,
    ),
  ).toBe(false);
});

test("rejects a future client timestamp", () => {
  expect(isLoggingEnvelopeWithinLimits({ ...validEvent, timestamp: Date.now() + 6 * 60_000 })).toBe(
    false,
  );
});

test("does not serialize undefined optional fields", () => {
  expect(
    createLoggingEnvelope({ level: "debug", event: "app.started", timestamp: 1_000 }),
  ).toStrictEqual({
    version: 1,
    level: "debug",
    event: "app.started",
    source: "frontend",
    product: "radium",
    timestamp: 1_000,
  });
});

test("rejects metadata over the entry limit", () => {
  const metadata = Object.fromEntries(
    Array.from({ length: LOGGING_LIMITS.maxMetadataEntries + 1 }, (_, index) => [
      `field${index}`,
      "value",
    ]),
  );

  expect(isLoggingEnvelopeWithinLimits({ ...validEvent, metadata }, 2_000)).toBe(false);
});

test("rejects unsafe correlation values", () => {
  expect(
    isLoggingEnvelopeWithinLimits(
      { ...validEvent, correlation: { requestId: "request with spaces" } },
      2_000,
    ),
  ).toBe(false);
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

  expect(isLoggingEnvelopeWithinLimits(envelope as unknown as LoggingEnvelope, 2_000)).toBe(false);
});
