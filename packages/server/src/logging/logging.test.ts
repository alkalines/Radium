import { createLoggingEnvelope, LOGGING_SOURCES } from "contracts/logging/contract";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { appRouter } from "../trpc/router";
import { logger } from "./server";

// Operational logging: the bounded stdout sink (ported from Convex `src/logging/server.test.ts`)
// and the browser ingest procedure (Convex `observability.events.ingest`), rate limited per user.

let test: TestRuntime;
let user: { id: string; headers: Headers };
let other: { id: string; headers: Headers };

beforeAll(async () => {
  test = await createTestRuntime();
  user = await classicUser(test.runtime, "logger@logging.test");
  other = await classicUser(test.runtime, "other@logging.test");
});

afterAll(async () => {
  await test?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const caller = (headers: Headers) => appRouter.createCaller({ runtime: test.runtime, headers });

/** Lines written to stdout while `run` executes, parsed. */
async function captured(run: () => unknown) {
  const lines: unknown[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(typeof line === "string" ? JSON.parse(line) : line);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

const frontendEvent = (fields: Partial<Parameters<typeof createLoggingEnvelope>[0]> = {}) =>
  createLoggingEnvelope({
    level: "info",
    event: "settings.saved",
    metadata: { section: "preferences" },
    source: LOGGING_SOURCES.frontend,
    ...fields,
  });

describe("server logger", () => {
  it("emits the shared envelope as one JSON line and isolates sink failures", async () => {
    const lines = await captured(() => {
      logger.warn("provider.unavailable", { timestamp: 1_000 });
      // Sensitive-shaped metadata is dropped, never logged.
      logger.info("invalid.event", { metadata: { apiKey: "not-for-logging" } });
    });
    expect(lines).toEqual([
      {
        version: 1,
        level: "warn",
        event: "provider.unavailable",
        product: "radium",
        source: "server",
        timestamp: 1_000,
        receivedAt: expect.any(Number),
      },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink unavailable");
    });
    expect(() => logger.error("operation.failed")).not.toThrow();
  });
});

describe("logging.ingest", () => {
  it("needs a session", async () => {
    await expect(caller(new Headers()).logging.ingest(frontendEvent())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("logs a frontend event with the session user as actor, never a client field", async () => {
    const event = frontendEvent();
    let accepted: boolean | undefined;
    const lines = await captured(async () => {
      accepted = await caller(user.headers).logging.ingest(event);
    });
    expect(accepted).toBe(true);
    expect(lines).toEqual([{ ...event, actorId: user.id, receivedAt: expect.any(Number) }]);
  });

  it("drops other sources, products and envelopes over the limits", async () => {
    for (const event of [
      frontendEvent({ source: "server" }),
      { ...frontendEvent(), product: "other" },
      frontendEvent({ metadata: { password: "hunter2" } }),
      frontendEvent({ timestamp: Date.now() + 60 * 60 * 1000 }),
      frontendEvent({ correlation: { requestId: "has spaces" } }),
    ]) {
      const lines = await captured(async () => {
        expect(await caller(user.headers).logging.ingest(event)).toBe(false);
      });
      // Only the server's own bounded warning, never the event.
      expect(lines).toEqual([expect.objectContaining({ event: "logging.invalid_event" })]);
    }
    await expect(
      caller(user.headers).logging.ingest(frontendEvent({ message: "x".repeat(513) })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts 60 events per user per minute", async () => {
    await captured(async () => {
      const results = await Promise.all(
        Array.from({ length: 65 }, () => caller(other.headers).logging.ingest(frontendEvent())),
      );
      expect(results.filter(Boolean)).toHaveLength(60);
    });
    // Another user's budget is separate.
    await captured(async () => {
      expect(await caller(user.headers).logging.ingest(frontendEvent())).toBe(true);
    });
  });
});
