import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import { WORKER_BASH_OUTPUT_BYTES, type WorkerBashRequest } from "backend/src/worker/bash-contract";
import { createBashExecutor } from "./service.js";

interface BashResponse {
  ok: boolean;
  code?: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
}

const executors: ReturnType<typeof createBashExecutor>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("runs native pipelines, redirection, external commands, canonical cwd, and inherited env", async () => {
  const directory = await temporaryDirectory();
  const directoryAlias = `${directory}-alias`;
  await symlink(directory, directoryAlias);
  temporaryDirectories.push(directoryAlias);
  const executor = newExecutor();
  const envKey = "RADIUM_WORKER_BASH_TEST_ENV";
  const previousEnv = process.env[envKey];
  process.env[envKey] = "inherited-worker-value";
  try {
    const result = await execute(executor, {
      directory: directoryAlias,
      sessionId: "native-pipeline",
      command:
        "printf 'left\\nright\\n' | tr '[:lower:]' '[:upper:]' > pipeline.txt; cat pipeline.txt; python3 -c 'import os;print(os.getcwd());print(os.environ[\"RADIUM_WORKER_BASH_TEST_ENV\"])'",
    });
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false, truncated: false });
    expect(result.output).toBe(`LEFT\nRIGHT\n${directory}\ninherited-worker-value\n`);
    expect(await readFile(join(directory, "pipeline.txt"), "utf8")).toBe("LEFT\nRIGHT\n");
  } finally {
    if (previousEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = previousEnv;
  }
});

test("preserves nonzero exit status and reports it in the shared failure envelope", async () => {
  const directory = await temporaryDirectory();
  const result = await execute(newExecutor(), {
    directory,
    sessionId: "native-nonzero",
    command: "printf 'captured\\n' >&2; exit 7",
  });

  expect(result).toMatchObject({
    ok: false,
    code: "COMMAND_FAILED",
    exitCode: 7,
    timedOut: false,
    output: "captured\n",
    truncated: false,
  });
});

test("waits for shell background children and strips ANSI and terminal control characters", async () => {
  const directory = await temporaryDirectory();
  const executor = newExecutor();
  const background = await execute(executor, {
    directory,
    sessionId: "foreground-only",
    command:
      'python3 -c \'import pathlib,time;time.sleep(0.15);pathlib.Path("background-finished").write_text("done")\' >/dev/null 2>&1 & echo ready',
  });
  expect(background.output).toBe("ready\n");
  expect(await readFile(join(directory, "background-finished"), "utf8")).toBe("done");

  const earlyExit = await execute(executor, {
    directory,
    sessionId: "background-early-exit",
    command:
      "python3 -c 'import os,pathlib,time;pathlib.Path(\"early-exit.pid\").write_text(str(os.getpid()));time.sleep(15)' >/dev/null 2>&1 & while test ! -f early-exit.pid; do sleep 0.01; done; exit 0",
  });
  expect(earlyExit.ok).toBe(true);
  expect(
    Process.fromPid(Number(await readFile(join(directory, "early-exit.pid"), "utf8"))),
  ).toBeNull();

  const cleaned = await execute(executor, {
    directory,
    sessionId: "terminal-cleanup",
    command:
      'python3 -c \'import sys;sys.stdout.write(chr(27)+"[31mred"+chr(27)+"[0m"+chr(1)+"\\r\\n")\'',
  });
  expect(cleaned).toMatchObject({ ok: true, exitCode: 0, truncated: false });
  expect(cleaned.output).toBe("red\n");
  expect(cleaned.output).not.toMatch(/[\u001b\u0001]/u);
});

test("times out a real external process and reports bounded timeout metadata", async () => {
  const directory = await temporaryDirectory();
  const executor = newExecutor();
  const pending = execute(executor, {
    directory,
    sessionId: "native-timeout",
    timeoutSeconds: 1,
    command:
      "python3 -c 'import os,pathlib,time;pathlib.Path(\"timeout.pid\").write_text(str(os.getpid()));time.sleep(15)'",
  });
  const started = await waitForFile(join(directory, "timeout.pid"));
  const result = await pending;
  const pid = Number(started);

  expect(result).toMatchObject({
    ok: false,
    code: "COMMAND_TIMEOUT",
    exitCode: null,
    timedOut: true,
  });
  expect(Process.fromPid(pid)).toBeNull();
});

test("bounds the complete serialized result after output capture", async () => {
  const directory = await temporaryDirectory();
  const result = await execute(newExecutor(), {
    directory,
    sessionId: "oversized-output",
    command: "python3 -c 'import sys;sys.stdout.write(\"\\n\"*100000)'",
  });

  expect(result.ok).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.output.startsWith("\n")).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
    WORKER_BASH_OUTPUT_BYTES,
  );
});

test("serializes a session and isolates simultaneous native sessions and directories", async () => {
  const directoryA = await temporaryDirectory();
  const directoryB = await temporaryDirectory();
  const executor = newExecutor();

  const [resultA, resultB] = await Promise.all([
    execute(executor, {
      directory: directoryA,
      sessionId: "concurrent-a",
      command: "printf A > shared.txt; sleep 0.1; cat shared.txt",
    }),
    execute(executor, {
      directory: directoryB,
      sessionId: "concurrent-b",
      command: "printf B > shared.txt; cat shared.txt",
    }),
  ]);
  expect(resultA.output).toBe("A");
  expect(resultB.output).toBe("B");
  expect(await readFile(join(directoryA, "shared.txt"), "utf8")).toBe("A");
  expect(await readFile(join(directoryB, "shared.txt"), "utf8")).toBe("B");
  await execute(executor, {
    directory: directoryA,
    sessionId: "state-a",
    command: "radium_session_marker=retained",
  });
  expect(
    (
      await execute(executor, {
        directory: directoryA,
        sessionId: "state-a",
        command: "printf '%s' \"$radium_session_marker\"",
      })
    ).output,
  ).toBe("retained");
  expect(
    (
      await execute(executor, {
        directory: directoryA,
        sessionId: "state-b",
        command: "printf '%s' \"$radium_session_marker\"",
      })
    ).output,
  ).toBe("");

  const first = execute(executor, {
    directory: directoryA,
    sessionId: "serialized-session",
    command: "printf first > serial.txt; sleep 0.1; cat serial.txt",
  });
  const second = execute(executor, {
    directory: directoryA,
    sessionId: "serialized-session",
    command: "printf second > serial.txt; cat serial.txt",
  });
  expect((await first).output).toBe("first");
  expect((await second).output).toBe("second");

  const changedDirectory = await execute(executor, {
    directory: directoryB,
    sessionId: "serialized-session",
    command: "pwd",
  });
  expect(changedDirectory).toMatchObject({ ok: false, code: "SESSION_DIRECTORY_CHANGED" });
});

test("evicts idle session-scoped native shells when the retained-session limit is reached", async () => {
  const directory = await temporaryDirectory();
  const executor = newExecutor();

  for (let index = 0; index < 64; index += 1) {
    const result = await execute(executor, {
      directory,
      sessionId: `bounded-${index}`,
      command: "true",
    });
    expect(result.ok).toBe(true);
  }
  expect(
    await execute(executor, {
      directory,
      sessionId: "bounded-overflow",
      command: "true",
    }),
  ).toMatchObject({ ok: true, exitCode: 0 });
});

test("close aborts an in-flight native command before waiting for it to settle", async () => {
  const directory = await temporaryDirectory();
  const executor = newExecutor();
  const pending = execute(executor, {
    directory,
    sessionId: "close-running",
    command:
      "python3 -c 'import os,pathlib,time;pathlib.Path(\"close.pid\").write_text(str(os.getpid()));time.sleep(20)'",
  });
  const pid = Number(await waitForFile(join(directory, "close.pid")));
  const closeStarted = Date.now();
  await executor.close();
  const result = await pending;

  expect(Date.now() - closeStarted).toBeLessThan(2_000);
  expect(result).toMatchObject({
    ok: false,
    code: "COMMAND_CANCELLED",
    exitCode: null,
    timedOut: false,
  });
  expect(Process.fromPid(pid)).toBeNull();
  expect(
    await execute(executor, {
      directory,
      sessionId: "close-running",
      command: "echo unreachable",
    }),
  ).toMatchObject({ ok: false, code: "SERVICE_CLOSED" });
});

async function temporaryDirectory(): Promise<string> {
  const base = join(tmpdir(), "opencode");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "radium-worker-bash-"));
  temporaryDirectories.push(directory);
  return directory;
}

function newExecutor(): ReturnType<typeof createBashExecutor> {
  const executor = createBashExecutor();
  executors.push(executor);
  return executor;
}

async function execute(
  executor: ReturnType<typeof createBashExecutor>,
  request: Omit<WorkerBashRequest, "timeoutSeconds"> & { timeoutSeconds?: number },
): Promise<BashResponse> {
  return JSON.parse(
    await executor.execute({ timeoutSeconds: 30, ...request } as WorkerBashRequest),
  ) as BashResponse;
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => undefined);
    if (content !== undefined) return content;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}
