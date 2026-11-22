import type { LimitObservation } from "contracts/limits/meters";
import type { Runtime } from "../../runtime";

/** Credential material a poll needs; read from Secret Store inside the backend only. */
export type LimitPollTarget = {
  /** Provider environment variable names, in order; the first non-empty value is the API key. */
  env: string[];
  values: Record<string, string>;
  /** Adapter-declared extra key (OpenRouter management key), when the owner set one. */
  limitKey?: string;
};

/** Result of a successful poll. */
export type LimitPollResult = LimitObservation & {
  /** Stored meter IDs to keep although this poll did not report them (a failed sub-request). */
  retain?: string[];
  /** A sub-request failed without failing the poll (e.g. a rejected management key). */
  partialError?: { message: string; status?: number };
  /** Upstream says the credential itself has expired. */
  expired?: boolean;
};

/** A failed poll; `status` drives credential-expired events (401/403) and backoff. */
export class LimitPollError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LimitPollError";
  }
}

/**
 * What a poll may use besides the credential: the runtime (ChatGPT sessions live in its stores)
 * and the fetch for every upstream request, so tests never touch the network.
 */
export type LimitPollContext = { runtime: Runtime; fetch: typeof fetch };

/**
 * Provider-specific usage-limit signals. Parsers are pure; `poll` runs outside any database
 * transaction and may read the network. Providers without an adapter get only metered budgets.
 */
export type LimitAdapter = {
  id: string;
  /** Meters from any upstream response's headers. */
  parseHeaders?(headers: Headers, now: number): LimitObservation | undefined;
  /** Exhausted meters from a failed response's body. */
  parseError?(status: number, body: string, now: number): LimitObservation | undefined;
  poll?(context: LimitPollContext, target: LimitPollTarget, now: number): Promise<LimitPollResult>;
  /** Interval between scheduled polls. */
  pollIntervalMs: number;
  /**
   * An optional second key the owner may store for limit reads only. `meters` are the meter ids
   * it feeds; they are dropped when the key is removed.
   */
  limitKey?: { label: string; description: string; meters: string[] };
};

/** Parse a JSON body, or `undefined`. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
