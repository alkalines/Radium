import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  WORKER_BASH_OUTPUT_BYTES,
  WORKER_BASH_TIMEOUT_SECONDS,
  type WorkerBashRequest,
  validWorkerBashRequest,
} from "backend/src/worker/bash-contract";
import type { Shell as NativeShell } from "@oh-my-pi/pi-natives";

const MAX_SESSIONS = 64;
const SHELL_OUTPUT_CAPTURE_BYTES = WORKER_BASH_OUTPUT_BYTES;
const ENCODER = new TextEncoder();

interface BashSession {
  directory: string;
  exitStatusVariable: string;
  shell: NativeShell;
}

interface BashResult {
  ok: boolean;
  code?: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
}

/** Creates a Worker-local, foreground-only native Shell executor. */
export function createBashExecutor(): {
  execute(request: WorkerBashRequest): Promise<string>;
  close(): Promise<void>;
} {
  return new WorkerBashExecutor();
}

class WorkerBashExecutor {
  private readonly sessions = new Map<string, BashSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private shellConstructor?: typeof import("@oh-my-pi/pi-natives").Shell;
  private shellConstructorPromise?: Promise<typeof import("@oh-my-pi/pi-natives").Shell>;
  private closed = false;
  private closePromise?: Promise<void>;

  /** Execute one foreground command and return a size-bounded JSON result. */
  execute(request: WorkerBashRequest): Promise<string> {
    if (this.closed) return Promise.resolve(failure("SERVICE_CLOSED"));
    if (!isValidRequest(request)) return Promise.resolve(failure("INVALID_REQUEST"));

    const previous = this.queues.get(request.sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(request.sessionId, tail);

    return previous
      .then(async () => {
        if (this.closed) return failure("SERVICE_CLOSED");
        try {
          return await this.executeSerial(request);
        } catch {
          return failure("SHELL_EXECUTION_FAILED");
        }
      })
      .finally(() => {
        release();
        if (this.queues.get(request.sessionId) === tail) {
          this.queues.delete(request.sessionId);
        }
      });
  }

  /** Abort running commands before waiting for queued work and releasing shells. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeSessions();
    return this.closePromise;
  }

  private async executeSerial(request: WorkerBashRequest): Promise<string> {
    let directory: string;
    try {
      if (!isAbsolute(request.directory)) return failure("DIRECTORY_INVALID");
      directory = await realpath(request.directory);
      if (!(await stat(directory)).isDirectory()) return failure("DIRECTORY_INVALID");
    } catch {
      return failure("DIRECTORY_INVALID");
    }

    if (this.closed) return failure("SERVICE_CLOSED");
    let session = this.sessions.get(request.sessionId);
    if (session && session.directory !== directory) {
      return failure("SESSION_DIRECTORY_CHANGED");
    }

    if (!session) {
      if (this.sessions.size >= MAX_SESSIONS) return failure("SESSION_LIMIT");
      let Shell: typeof import("@oh-my-pi/pi-natives").Shell;
      try {
        Shell = await this.loadShellConstructor();
      } catch {
        return failure("NATIVE_SHELL_UNAVAILABLE");
      }
      if (this.closed) return failure("SERVICE_CLOSED");

      // Other session queues can create shells while the native package imports.
      if (this.sessions.size >= MAX_SESSIONS) return failure("SESSION_LIMIT");
      session = {
        directory,
        exitStatusVariable: `__radium_worker_${randomUUID().replaceAll("-", "")}_exit`,
        shell: new Shell(),
      };
      this.sessions.set(request.sessionId, session);
    }

    let runResult: Awaited<ReturnType<NativeShell["run"]>>;
    const output = new BoundedOutput();
    try {
      runResult = await session.shell.run(
        {
          // Waiting for shell-level background jobs keeps this adapter foreground-only.
          command: withForegroundWait(request.command, session.exitStatusVariable),
          cwd: directory,
          env: inheritedEnvironment(),
          timeoutMs: Math.min(request.timeoutSeconds, WORKER_BASH_TIMEOUT_SECONDS) * 1000,
        },
        (error, chunk) => {
          if (chunk) output.append(chunk);
          if (error) output.append(`${error.message}\n`);
        },
      );
    } catch {
      await session.shell.abort().catch(() => undefined);
      this.sessions.delete(request.sessionId);
      return resultJson({
        ok: false,
        code: "SHELL_EXECUTION_FAILED",
        exitCode: null,
        timedOut: false,
        output: output.text(),
        truncated: output.truncated,
      });
    }

    const timedOut = runResult.timedOut;
    const cancelled = runResult.cancelled;
    const exitCode = typeof runResult.exitCode === "number" ? runResult.exitCode : null;
    let backgroundChildren = false;
    try {
      backgroundChildren = (await session.shell.liveBackgroundJobCount()) > 0;
    } catch {
      backgroundChildren = true;
    }
    if (timedOut || cancelled || backgroundChildren) {
      // A timed-out or aborted native session is not reused for a later command.
      // exit/errexit can bypass the appended wait; dispose any remaining children.
      await session.shell.abort().catch(() => undefined);
      this.sessions.delete(request.sessionId);
    }

    const code = timedOut
      ? "COMMAND_TIMEOUT"
      : cancelled
        ? "COMMAND_CANCELLED"
        : exitCode === null
          ? "EXIT_CODE_UNAVAILABLE"
          : exitCode !== 0
            ? "COMMAND_FAILED"
            : undefined;
    return resultJson({
      ok: code === undefined,
      ...(code === undefined ? {} : { code }),
      exitCode,
      timedOut,
      output: output.text(),
      truncated: output.truncated,
    });
  }

  private loadShellConstructor(): Promise<typeof import("@oh-my-pi/pi-natives").Shell> {
    if (this.shellConstructor) return Promise.resolve(this.shellConstructor);
    if (!this.shellConstructorPromise) {
      this.shellConstructorPromise = import("@oh-my-pi/pi-natives")
        .then(({ Shell }) => {
          this.shellConstructor = Shell;
          return Shell;
        })
        .catch((error: unknown) => {
          this.shellConstructorPromise = undefined;
          throw error;
        });
    }
    return this.shellConstructorPromise;
  }

  private async closeSessions(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => session.shell.abort().catch(() => undefined)));
    await Promise.all([...this.queues.values()]);
    // Shell has no explicit dispose method in pi-natives 18.8.3. Aborting settles
    // its active work; clearing the final host references releases native state.
    this.sessions.clear();
    this.shellConstructor = undefined;
    this.shellConstructorPromise = undefined;
  }
}

class BoundedOutput {
  private readonly chunks: string[] = [];
  private bytes = 0;
  truncated = false;

  append(chunk: string): void {
    if (!chunk || this.truncated) return;
    const remaining = SHELL_OUTPUT_CAPTURE_BYTES - this.bytes;
    const prefix = utf8Prefix(chunk, remaining);
    if (prefix.text) this.chunks.push(prefix.text);
    this.bytes += prefix.bytes;
    if (!prefix.complete) this.truncated = true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

function isValidRequest(request: WorkerBashRequest): boolean {
  try {
    return !!request && typeof request === "object" && validWorkerBashRequest(request);
  } catch {
    return false;
  }
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function withForegroundWait(command: string, exitStatus: string): string {
  return `${command}\n${exitStatus}=$?\nwait\n(exit "$${exitStatus}")`;
}

function utf8Prefix(
  text: string,
  maxBytes: number,
): { text: string; bytes: number; complete: boolean } {
  let offset = 0;
  let bytes = 0;
  while (offset < text.length) {
    const codePoint = text.codePointAt(offset)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const encodedBytes =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + encodedBytes > maxBytes) {
      return { text: text.slice(0, offset), bytes, complete: false };
    }
    offset += width;
    bytes += encodedBytes;
  }
  return { text, bytes, complete: true };
}

function resultJson(result: BashResult): string {
  const clean = {
    ...result,
    output: cleanTerminalOutput(result.output),
  };
  let json = JSON.stringify(clean);
  if (ENCODER.encode(json).byteLength <= WORKER_BASH_OUTPUT_BYTES) return json;

  // Bound the complete serialized receipt, including JSON escaping overhead.
  const characters = Array.from(clean.output);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = JSON.stringify({
      ...clean,
      output: characters.slice(0, middle).join(""),
      truncated: true,
    });
    if (ENCODER.encode(candidate).byteLength <= WORKER_BASH_OUTPUT_BYTES) low = middle;
    else high = middle - 1;
  }
  json = JSON.stringify({
    ...clean,
    output: characters.slice(0, low).join(""),
    truncated: true,
  });
  return json;
}

function cleanTerminalOutput(output: string): string {
  return stripVTControlCharacters(output)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function failure(code: string): string {
  return resultJson({
    ok: false,
    code,
    exitCode: null,
    timedOut: false,
    output: "",
    truncated: false,
  });
}
