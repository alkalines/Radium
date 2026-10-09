import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createBashExecutor } from "./service.js";

const native = vi.hoisted(() => ({
  shells: [] as Array<{
    runCalls: number;
    abortCalls: number;
    runGate?: Promise<void>;
    abortGate?: Promise<void>;
    onRun?: () => void;
    onAbort?: () => void;
  }>,
}));

vi.mock("@oh-my-pi/pi-natives", () => {
  class Shell {
    private readonly state = {
      runCalls: 0,
      abortCalls: 0,
    } as (typeof native.shells)[number];

    constructor() {
      native.shells.push(this.state);
    }

    async run() {
      this.state.runCalls += 1;
      this.state.onRun?.();
      await this.state.runGate;
      return { exitCode: 0, timedOut: false, cancelled: false };
    }

    async liveBackgroundJobCount() {
      return 0;
    }

    async abort() {
      this.state.abortCalls += 1;
      this.state.onAbort?.();
      await this.state.abortGate;
    }
  }

  return { Shell };
});

const executors: ReturnType<typeof createBashExecutor>[] = [];

beforeEach(() => {
  native.shells.length = 0;
});

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

test("evicts the least-recently-used idle shell and recreates an evicted session", async () => {
  const executor = newExecutor();

  for (let index = 0; index < 64; index += 1) {
    expect((await execute(executor, `capacity-${index}`)).ok).toBe(true);
  }
  const originalShells = [...native.shells];

  // Touch the oldest session so the next-oldest one becomes the eviction target.
  expect((await execute(executor, "capacity-0")).ok).toBe(true);
  expect((await execute(executor, "capacity-overflow")).ok).toBe(true);

  expect(native.shells).toHaveLength(65);
  expect(originalShells[0]?.abortCalls).toBe(0);
  expect(originalShells[1]?.abortCalls).toBe(1);

  // An evicted ID receives a fresh shell rather than reusing the aborted instance.
  expect((await execute(executor, "capacity-1")).ok).toBe(true);
  expect(originalShells[1]?.runCalls).toBe(1);
  expect(native.shells).toHaveLength(66);
  expect(native.shells[65]?.runCalls).toBe(1);
});

test("returns SESSION_LIMIT only when all retained sessions are busy", async () => {
  const executor = newExecutor();
  for (let index = 0; index < 64; index += 1) {
    expect((await execute(executor, `busy-${index}`)).ok).toBe(true);
  }

  let releaseRuns!: () => void;
  const runGate = new Promise<void>((resolve) => {
    releaseRuns = resolve;
  });
  let signalAllRunning!: () => void;
  const allRunning = new Promise<void>((resolve) => {
    signalAllRunning = resolve;
  });
  let running = 0;
  for (const shell of native.shells) {
    shell.runGate = runGate;
    shell.onRun = () => {
      running += 1;
      if (running === 64) signalAllRunning();
    };
  }

  const active = Array.from({ length: 64 }, (_, index) => execute(executor, `busy-${index}`));
  try {
    await allRunning;
    expect(await execute(executor, "busy-overflow")).toMatchObject({
      ok: false,
      code: "SESSION_LIMIT",
    });
  } finally {
    releaseRuns();
  }

  expect((await Promise.all(active)).every((result) => result.ok)).toBe(true);
});

test("does not reuse or replace an evicted shell until its abort settles", async () => {
  const executor = newExecutor();
  for (let index = 0; index < 64; index += 1) {
    expect((await execute(executor, `eviction-${index}`)).ok).toBe(true);
  }

  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  let signalAbortStarted!: () => void;
  const abortStarted = new Promise<void>((resolve) => {
    signalAbortStarted = resolve;
  });
  const evictedShell = native.shells[0]!;
  evictedShell.abortGate = abortGate;
  evictedShell.onAbort = signalAbortStarted;

  let overflow: Promise<BashResponse> | undefined;
  let reuse: Promise<BashResponse> | undefined;
  try {
    overflow = execute(executor, "eviction-overflow");
    await abortStarted;
    reuse = execute(executor, "eviction-0");

    // Let the request pass path validation while eviction is still blocked.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(evictedShell.runCalls).toBe(1);
    expect(native.shells).toHaveLength(64);

    releaseAbort();
    expect((await Promise.all([overflow, reuse])).every((result) => result.ok)).toBe(true);
    expect(evictedShell.runCalls).toBe(1);
    expect(native.shells).toHaveLength(66);
  } finally {
    releaseAbort();
    await Promise.allSettled([overflow, reuse].filter((promise) => promise !== undefined));
  }
});

interface BashResponse {
  ok: boolean;
  code?: string;
}

function newExecutor(): ReturnType<typeof createBashExecutor> {
  const executor = createBashExecutor();
  executors.push(executor);
  return executor;
}

async function execute(
  executor: ReturnType<typeof createBashExecutor>,
  sessionId: string,
): Promise<BashResponse> {
  const output = await executor.execute({
    directory: "/tmp",
    sessionId,
    command: "true",
    timeoutSeconds: 30,
  });
  return JSON.parse(output) as BashResponse;
}
