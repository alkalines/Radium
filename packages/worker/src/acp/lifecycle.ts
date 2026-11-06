import { ConvexError } from "convex/values";

/** Read a structured permanent rejection without interpreting ordinary transport failures. */
export function acpErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data;
  if (typeof data === "object" && data !== null && "code" in data && typeof data.code === "string")
    return data.code;
  return undefined;
}

/** Abort-aware delay shared by lifecycle and process restart policies. */
export function acpDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("ACP host stopped"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const finish = () => {
    signal?.removeEventListener("abort", cancel);
    resolve();
  };
  const timer = setTimeout(finish, milliseconds);
  const cancel = () => {
    clearTimeout(timer);
    reject(new Error("ACP host stopped"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  return promise;
}

/** Serialize durable effects by chat, retaining each operation across transient outages. */
export class AcpLifecycle {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();
  private available = false;

  /** Pause retries when machine control authority is unavailable. */
  setAvailable(value: boolean): void {
    this.available = value;
  }

  /** Enqueue once, retry delivery only; permanent ACP rejection fails this operation. */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        let backoff = 500;
        for (;;) {
          if (this.abort.signal.aborted) throw new Error("ACP host stopped");
          if (!this.available) {
            await acpDelay(100, this.abort.signal);
            continue;
          }
          try {
            const cancelled = Promise.withResolvers<never>();
            const cancel = () => cancelled.reject(new Error("ACP host stopped"));
            this.abort.signal.addEventListener("abort", cancel, { once: true });
            try {
              // A socket may never acknowledge an in-flight mutation during shutdown.
              return await Promise.race([operation(), cancelled.promise]);
            } finally {
              this.abort.signal.removeEventListener("abort", cancel);
            }
          } catch (error) {
            if (acpErrorCode(error)?.startsWith("ACP_")) throw error;
            await acpDelay(backoff * (0.75 + Math.random() * 0.5), this.abort.signal);
            backoff = Math.min(10_000, backoff * 2);
          }
        }
      });
    this.tails.set(key, result);
    void result
      .finally(() => {
        if (this.tails.get(key) === result) this.tails.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  /** Give receipts a bounded final flush, then abort retries before closing the transport. */
  async close(timeout = 2_000): Promise<void> {
    const deadline = Promise.withResolvers<void>();
    const timer = setTimeout(deadline.resolve, timeout);
    await Promise.race([Promise.allSettled(this.tails.values()), deadline.promise]);
    clearTimeout(timer);
    this.abort.abort();
  }
}
