export interface JobRunnerOptions {
  /**
   * Claims and runs one batch. Resolves `true` when more work may be waiting, so the runner drains
   * again immediately; `false` makes it idle until `idleMs` passes or `wake()` is called. Must stop
   * early when `signal` aborts.
   */
  drain(signal: AbortSignal): Promise<boolean>;
  /** Poll interval while idle; also the delay before retrying after a failed drain. */
  idleMs: number;
  /** Reports a failed drain. The runner keeps going. */
  onError(error: unknown): void;
}

export interface JobRunner {
  /** Requests a drain as soon as the current one finishes. Wakes are coalesced, never lost. */
  wake(): void;
  /** Stops polling and resolves after the in-flight drain has returned. */
  stop(): Promise<void>;
}

/**
 * In-process poller for the jobs outbox on Bun and Node. Several processes may each run one: the
 * drain must claim rows exclusively (`FOR UPDATE SKIP LOCKED`), the runner only decides when to
 * call it. Edge presets replace this with a scheduled drain (T13).
 */
export function startJobRunner({ drain, idleMs, onError }: JobRunnerOptions): JobRunner {
  const controller = new AbortController();
  let wakeRequested = false;
  let endIdle: (() => void) | null = null;

  function idle() {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(finish, idleMs);
    function finish() {
      clearTimeout(timer);
      endIdle = null;
      resolve();
    }
    endIdle = finish;
    return promise;
  }

  const loop = (async () => {
    while (!controller.signal.aborted) {
      wakeRequested = false;
      let more = false;
      try {
        more = await drain(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) onError(error);
      }

      if (controller.signal.aborted) break;
      // A wake that arrived during the drain may be for work this drain did not see.
      if (more || wakeRequested) continue;
      await idle();
    }
  })();

  return {
    wake() {
      wakeRequested = true;
      endIdle?.();
    },

    async stop() {
      controller.abort();
      endIdle?.();
      await loop;
    },
  };
}
