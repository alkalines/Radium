import type { ActionCtx } from "../../convex/_generated/server";
import type { LimitObservation } from "./meters";

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
 * Provider-specific usage-limit signals. Parsers are pure; `poll` runs in an action and may read
 * the network. Providers without an adapter get only metered budgets.
 */
export type LimitAdapter = {
  id: string;
  /** Meters from any upstream response's headers. */
  parseHeaders?(headers: Headers, now: number): LimitObservation | undefined;
  /** Exhausted meters from a failed response's body. */
  parseError?(status: number, body: string, now: number): LimitObservation | undefined;
  poll?(ctx: ActionCtx, target: LimitPollTarget, now: number): Promise<LimitPollResult>;
  /** Interval between scheduled polls. */
  pollIntervalMs: number;
  /** An optional second key the owner may store for limit reads only. */
  limitKey?: { label: string; description: string };
};

/** Parse a JSON body, or `undefined`. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
