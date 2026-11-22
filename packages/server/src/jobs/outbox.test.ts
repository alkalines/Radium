import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { claimLease } from "./lease";
import { dispatchJobs, enqueueJob, sweepJobs } from "./outbox";
import { jobs } from "./schema";

const runs: string[] = [];
let failuresLeft = 0;
let test: TestRuntime;

beforeAll(async () => {
  test = await createTestRuntime({
    jobs: {
      async record(payload) {
        runs.push((payload as { name: string }).name);
      },
      async flaky() {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error("upstream unavailable");
        }
        runs.push("flaky");
      },
    },
  });
});

afterAll(async () => {
  await test?.close();
});

beforeEach(async () => {
  runs.length = 0;
  await test.runtime.drivers.db.delete(jobs);
});

describe("outbox", () => {
  it("runs each job once when sweeps and dispatches race, then deletes it", async () => {
    const { db } = test.runtime.drivers;
    const ids = await db.transaction(async (tx) =>
      Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          enqueueJob(tx, { kind: "record", payload: { name: `job-${index}` } }),
        ),
      ),
    );

    await Promise.all([
      sweepJobs(test.runtime),
      sweepJobs(test.runtime),
      dispatchJobs(test.runtime, ids),
    ]);

    expect(runs.toSorted()).toEqual(
      Array.from({ length: 30 }, (_, index) => `job-${index}`).toSorted(),
    );
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("does not run a job whose transaction rolled back", async () => {
    const { db } = test.runtime.drivers;
    await db
      .transaction(async (tx) => {
        await enqueueJob(tx, { kind: "record", payload: { name: "rolled-back" } });
        throw new Error("abort");
      })
      .catch(() => undefined);
    await sweepJobs(test.runtime);
    expect(runs).toEqual([]);
  });

  it("keeps one queued job per dedupe key", async () => {
    const { db } = test.runtime.drivers;
    const first = await enqueueJob(db, {
      kind: "record",
      payload: { name: "first" },
      dedupeKey: "budget:w1",
    });
    const second = await enqueueJob(db, {
      kind: "record",
      payload: { name: "second" },
      dedupeKey: "budget:w1",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await sweepJobs(test.runtime);
    expect(runs).toEqual(["first"]);
    // Once the job finished, the key is free again.
    expect(
      await enqueueJob(db, { kind: "record", payload: { name: "third" }, dedupeKey: "budget:w1" }),
    ).not.toBeNull();
  });

  it("waits for runAt", async () => {
    const { db } = test.runtime.drivers;
    await enqueueJob(db, {
      kind: "record",
      payload: { name: "later" },
      runAt: new Date(Date.now() + 60_000),
    });
    await sweepJobs(test.runtime);
    expect(runs).toEqual([]);
  });

  it("retries a failing job with backoff and parks it after the last attempt", async () => {
    const { db } = test.runtime.drivers;
    failuresLeft = 1;
    const id = await enqueueJob(db, { kind: "flaky", payload: {} });
    await dispatchJobs(test.runtime, [id]);

    const [retrying] = await db.select().from(jobs).where(eq(jobs.id, id!));
    expect(retrying).toMatchObject({
      attempts: 1,
      lastError: "upstream unavailable",
      failedAt: null,
      lockedUntil: null,
    });
    expect(retrying!.runAt.getTime()).toBeGreaterThan(Date.now());

    // Make it due again: the second attempt succeeds and removes it.
    await db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(eq(jobs.id, id!));
    await sweepJobs(test.runtime);
    expect(runs).toEqual(["flaky"]);
    expect(await db.select().from(jobs)).toEqual([]);

    const unknown = await enqueueJob(db, { kind: "no-such-kind", payload: {} });
    await db.update(jobs).set({ attempts: 7 }).where(eq(jobs.id, unknown!));
    await sweepJobs(test.runtime);
    const [parked] = await db.select().from(jobs).where(eq(jobs.id, unknown!));
    expect(parked).toMatchObject({
      attempts: 8,
      lastError: 'No handler for job kind "no-such-kind"',
    });
    expect(parked!.failedAt).not.toBeNull();
    // Parked jobs are never claimed again.
    await db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(eq(jobs.id, unknown!));
    expect(await sweepJobs(test.runtime)).toBe(0);
  });
});

describe("scheduled task lease", () => {
  it("lets exactly one of several replicas run per interval", async () => {
    const { kv } = test.runtime.drivers;
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimLease(kv, "test:task", 1_000)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
