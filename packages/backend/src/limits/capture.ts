import type { LimitAdapter } from "./adapter";
import { combineObservations, type LimitObservation } from "./meters";

/** Error bodies are read up to this length; limit errors are small. */
const MAX_ERROR_BODY_CHARS = 8192;

/** Passive limit capture for one routed attempt. */
export type LimitCapture = {
  /** Wraps the upstream fetch; responses are returned untouched. */
  fetch: typeof fetch;
  /** Meters observed since the last call, then cleared; `undefined` when none. */
  take(): LimitObservation | undefined;
};

/**
 * Wrap `upstream` so every response (success or failure) is parsed by the adapter: headers on
 * all responses, error bodies (read from a clone) on failures. Parsing never affects the request.
 */
export function createLimitCapture(
  adapter: LimitAdapter,
  upstream: typeof fetch = (input, init) => globalThis.fetch(input, init),
): LimitCapture {
  let observed: LimitObservation | undefined;

  const capture = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await upstream(input, init);
    try {
      const now = Date.now();
      observed = combineObservations(observed, adapter.parseHeaders?.(response.headers, now));
      if (!response.ok && adapter.parseError) {
        const body = (await response.clone().text()).slice(0, MAX_ERROR_BODY_CHARS);
        observed = combineObservations(observed, adapter.parseError(response.status, body, now));
      }
    } catch (error) {
      console.error("Failed to read usage-limit signals", { adapter: adapter.id, error });
    }
    return response;
  };

  return {
    fetch: capture,
    take() {
      const result = observed;
      observed = undefined;
      return result;
    },
  };
}
