import type { ConvexClient } from "convex/browser";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "backend/convex/_generated/api";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "backend/src/worker/presence";

/**
 * Create (if missing) and return the Worker's temp working directory: `radium` under the OS temp
 * folder (`/tmp` on Linux, `$TMPDIR` on macOS, `%TEMP%` on Windows). The backend uses it as the
 * working directory for chats without a Project folder on this Worker.
 */
export async function prepareTempDirectory(baseDirectory: string = tmpdir()): Promise<string> {
  const directory = join(baseDirectory, "radium");
  await mkdir(directory, { recursive: true });
  return directory;
}

/** Heartbeat lifecycle driven by the control connection's status. */
export interface PresenceReporter {
  /** Report immediately and start heartbeats when connected; stop them when disconnected. */
  setAvailable(available: boolean): void;

  /** Stop heartbeats; safe to call repeatedly. */
  close(): void;
}

/**
 * Report presence and the temp directory through `workers.reportPresence` while the control
 * connection is authorized, then every `WORKER_HEARTBEAT_INTERVAL_MS`. Failures are ignored:
 * presence is advisory display state and the next heartbeat retries. No paths or errors are
 * logged.
 */
export function startPresenceReporter(
  client: ConvexClient,
  tempDirectory: string,
): PresenceReporter {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const report = () => {
    void client.mutation(api.workers.reportPresence, { tempDirectory }).catch(() => undefined);
  };

  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };

  return {
    setAvailable(available) {
      if (closed) return;
      if (!available) {
        stop();
        return;
      }
      if (timer) return;
      report();
      timer = setInterval(report, WORKER_HEARTBEAT_INTERVAL_MS);
    },
    close() {
      closed = true;
      stop();
    },
  };
}
