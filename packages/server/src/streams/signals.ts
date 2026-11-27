import type { Runtime } from "../runtime";
import type { StreamPage } from "./server";
import { publishEvent, type LiveEvent } from "./events";
import { currentStream, type StreamScope } from "./rotating";

/**
 * Chat signal streams (`docs/Backend_Migration/Live_Data.md`, Worker Tasks And Code Mode Waits):
 * a request handler waiting on something another request decides (a Worker finishing a task, a
 * user answering a Code Mode prompt) long-polls `c/<chat>/signals/<gen>` instead of polling the
 * database. The deciding request appends `{ topic, ids: [id] }` after its write, and the waiter
 * re-reads the row or key. Signals carry no content; only backend handlers read them.
 */

const signalScope = (chat: string): StreamScope => `c/${chat}/signals`;

/** Rings the handlers waiting on chat `chat` (best effort, after the deciding write). */
export async function signalChat(runtime: Runtime, chat: string, event: LiveEvent) {
  await publishEvent(runtime, [signalScope(chat)], event);
}

/** How often a wait re-checks while the stream server is unavailable. */
const FALLBACK_POLL_MS = 1_000;

/**
 * Waits until `check` yields a value, re-checking whenever a signal names `id` under `topic`,
 * for at most `timeoutMs`. The stream position is taken before the re-check that follows it, so
 * a signal sent in between is never missed. A lost signal costs the remaining wait, never a wrong
 * answer: the value always comes from `check`. While the stream server is unavailable the wait
 * falls back to re-checking every {@link FALLBACK_POLL_MS}, so an answer is still found and the
 * deadline and `signal` still hold.
 *
 * @returns the value, or `null` once the time is up or `signal` aborts.
 */
export async function waitForSignal<T>(
  runtime: Runtime,
  input: { chat: string; topic: string; id: string; timeoutMs: number; signal?: AbortSignal },
  check: () => Promise<T | null>,
): Promise<T | null> {
  const { kv } = runtime.drivers;
  const deadline = Date.now() + input.timeoutMs;
  const first = await check();
  if (first !== null) return first;

  let position: { path: string; offset: string } | null = null;
  while (Date.now() < deadline && !input.signal?.aborted) {
    const remaining = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const waitSignal = input.signal ? AbortSignal.any([input.signal, remaining]) : remaining;
    try {
      if (!position) {
        // A new (or rotated) generation: position at its tail, then re-check what may have
        // happened before it.
        const path = await currentStream(kv, runtime.streams, signalScope(input.chat));
        position = { path, offset: (await runtime.streams.tail(path)) ?? "-1" };
      } else {
        const page: StreamPage | null = await runtime.streams.read(position.path, position.offset, {
          live: "long-poll",
          signal: waitSignal,
        });
        if (page === null || page.closed) {
          position = null;
          continue;
        }
        position.offset = page.nextOffset;
        const named = page.messages.some((message) => {
          const event = message as Partial<LiveEvent>;
          return event.topic === input.topic && event.ids?.includes(input.id) === true;
        });
        if (!named) continue;
      }
    } catch {
      if (waitSignal.aborted) break;
      console.error("streams: signal wait degraded to polling");
      position = null;
      // Runtime-neutral (no `Bun.sleep` outside the drivers); at most one second.
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, Math.min(FALLBACK_POLL_MS, Math.max(0, deadline - Date.now())));
      await pause.promise;
    }
    const value = await check();
    if (value !== null) return value;
  }
  return await check();
}
