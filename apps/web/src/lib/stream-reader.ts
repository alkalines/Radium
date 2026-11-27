import { DurableStreamError, FetchError, stream, type Offset } from "@durable-streams/client";

/** Why {@link readStream} returned. */
export type StreamEnd =
  /** The writer closed the stream; everything it holds was delivered. */
  | "closed"
  /** The stream is missing, gone or no longer readable (the proxy answers refusals as `404`). */
  | "gone"
  /** The caller's signal aborted the read. */
  | "aborted";

/** Statuses after which reading the same path again cannot succeed. */
const GONE_STATUSES = new Set([401, 403, 404, 410]);
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
/** How long an ended session may take to hand its last batches to the subscriber. */
const DRAIN_MS = 2_000;

/**
 * Reads the JSON stream at `url` (a same-origin `/api/streams/<path>` proxy URL) live over SSE,
 * from `offset` until the writer closes it, handing every batch of messages to `onMessages`
 * in order (`docs/Backend_Migration/Live_Data.md`, Stream Proxy). `onMessages` must not throw.
 *
 * `@durable-streams/client` reconnects recycled SSE connections and retries failed requests, but
 * a network error in the middle of a response ends its session; this resumes from the offset after
 * the last delivered batch, with exponential backoff while attempts deliver nothing. Every batch
 * is delivered exactly once: a session's `closed` settles before its subscriber has seen the last
 * batches, so an ended session first drains (or is cut off, and those batches are read again).
 */
export async function readStream<T>({
  url,
  offset,
  signal,
  onMessages,
}: {
  url: string;
  /** `-1` for the start, `now` for the current end, or an offset this reader returned before. */
  offset: Offset;
  signal: AbortSignal;
  onMessages: (messages: readonly T[]) => void | Promise<void>;
}): Promise<StreamEnd> {
  // The client resolves stream URLs with `new URL(url)`, which needs an absolute one. `location`
  // is the page's, or a Worker's (the live event reader runs in one).
  const absolute = new URL(url, location.origin);
  let next = offset;
  let failures = 0;
  while (!signal.aborted) {
    let failure: unknown;
    let closed = false;
    try {
      const response = await stream<T>({
        url: absolute,
        offset: next,
        live: "sse",
        json: true,
        signal,
        warnOnHttp: false,
      });
      let over = false;
      let delivering: Promise<void> | undefined;
      let onProgress = () => {};
      response.subscribeJson<T>((batch) => {
        if (over) return;
        delivering = (async () => {
          if (batch.items.length > 0) await onMessages(batch.items);
          next = batch.offset;
          failures = 0;
          if (batch.streamClosed) closed = true;
          onProgress();
        })();
        return delivering;
      });
      try {
        await response.closed;
        // A clean end: wait for the subscriber to reach the session's last offset.
        const drained = AbortSignal.any([signal, AbortSignal.timeout(DRAIN_MS)]);
        while (!closed && next !== response.offset && !drained.aborted) {
          const progress = Promise.withResolvers<void>();
          onProgress = progress.resolve;
          drained.addEventListener("abort", () => progress.resolve(), { once: true });
          await progress.promise;
        }
        // The writer's close can arrive as a control event without data.
        if (response.streamClosed && next === response.offset) closed = true;
      } catch (error) {
        failure = error;
      }
      over = true;
      response.cancel();
      await delivering;
    } catch (error) {
      failure = error;
    }
    if (closed) return "closed";
    if (signal.aborted) break;
    const status =
      failure instanceof FetchError || failure instanceof DurableStreamError
        ? failure.status
        : undefined;
    if (status !== undefined && GONE_STATUSES.has(status)) return "gone";
    // Ended without the writer's close: a dropped connection. Resume from the last batch.
    await sleep(retryDelay(failures++), signal);
  }
  return "aborted";
}

/** Exponential backoff with jitter: about 0.5 s, 1 s, 2 s, … up to 30 s. */
export function retryDelay(failures: number) {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** Waits `ms`, or less when `signal` aborts first. */
export function sleep(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  return promise;
}
