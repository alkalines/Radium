import { APICallError, RetryError } from "ai";
import * as z from "zod";
import type { CooldownReason, ErrorRule, ErrorRuleAction } from "./settings";

/**
 * Normalized upstream failure observed by one attempt. `body` is kept only in memory for
 * error-rule matching; persisted state stores the bounded `message`.
 */
export type UpstreamFailure = {
  kind: "http" | "transport" | "empty_stream" | "aborted";
  status?: number;
  message: string;
  body?: string;
  headers?: Record<string, string>;
  /** Output already reached the caller or was buffered as content; never retry then. */
  outputStarted: boolean;
};

/** Routing consequence of a failure, mirroring CLIProxyAPI's result handling. */
export type FailureDecision = {
  /** Undefined means the provider is not cooled down. */
  reason?: CooldownReason;
  /** Explicit upstream deadline in milliseconds from now, when one was supplied. */
  retryAfterMs?: number;
  /** Quota-shaped 429 that should apply to the whole provider credential. */
  credentialScope: boolean;
  /** Error rule `*-and-cooldown`: apply a cooldown even for failures that normally skip one. */
  forceCooldown: boolean;
  /** `stop` returns the error to the caller without trying another provider. */
  action: "continue" | "stop";
  /** Whether a later retry round may help (403, 408, 429, 5xx, transport, empty stream). */
  retryRound: boolean;
  /** Quota/auth/model failures move a session binding even under `rebind-on: quota`. */
  rebindOnQuota: boolean;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** CLIProxyAPI cooldown constants (`conductor_refresh.go`). */
export const COOLDOWN = {
  quotaBackoffBaseMs: SECOND,
  quotaBackoffMaxMs: 30 * MINUTE,
  minQuotaCooldownMs: 10 * SECOND,
  transientMs: MINUTE,
  authMs: 30 * MINUTE,
  notFoundMs: 12 * HOUR,
  otherMs: MINUTE,
  /** Reset deadlines further away than the longest known plan window are billing noise. */
  maxResetMs: 7 * 24 * HOUR + HOUR,
} as const;

const MAX_BODY_CHARS = 8192;
const MAX_MESSAGE_CHARS = 300;
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);
const RETRY_ROUND_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504]);
const REQUEST_INVALID_STATUSES = new Set([400, 413, 422]);
const MODEL_UNSUPPORTED =
  /model[_ ]not[_ ]found|does not exist|unknown model|unsupported model|model .*not (?:available|supported)/i;
const CREDENTIAL_QUOTA =
  /usage_limit_reached|insufficient_quota|quota[_ ]exceeded|usage limit|credit balance/i;
/** Reset fields in plan-limit bodies, e.g. `{"error":{"type":"usage_limit_reached","resets_at":…}}`. */
const resetFieldsSchema = z.object({
  resets_at: z.number().optional(),
  resets_in_seconds: z.number().optional(),
});
const errorEnvelopeSchema = z.object({ error: z.unknown() });

/** Convert an AI SDK or transport error into the routing failure shape. */
export function upstreamFailureFromError(error: unknown, outputStarted: boolean): UpstreamFailure {
  const cause = RetryError.isInstance(error) ? error.lastError : error;

  if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
    return { kind: "aborted", message: "Request aborted.", outputStarted };
  }

  if (APICallError.isInstance(cause)) {
    return {
      kind: "http",
      status: cause.statusCode,
      message: boundedMessage(cause.message),
      body: cause.responseBody?.slice(0, MAX_BODY_CHARS),
      headers: lowercaseHeaders(cause.responseHeaders),
      outputStarted,
    };
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: "transport", message: boundedMessage(message), outputStarted };
}

/** Bound upstream text before it is persisted or returned; bodies can echo prompts. */
export function boundedMessage(message: string) {
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
}

/** First owner rule whose status matches and whose substring or regex matches the body. */
export function matchErrorRule(
  rules: ErrorRule[],
  failure: UpstreamFailure,
): ErrorRuleAction | undefined {
  if (failure.status === undefined) return undefined;
  const text = `${failure.body ?? ""}\n${failure.message}`;

  for (const rule of rules) {
    if (rule.status !== failure.status) continue;
    if (rule.match.some((pattern) => text.includes(pattern))) return rule.action;
    if (rule.matchRegex.some((pattern) => safeRegexTest(pattern, text))) return rule.action;
  }
  return undefined;
}

/**
 * Decide cooldown, failover, and session effects for one failed attempt. Owner error rules
 * run first; status classes follow CLIProxyAPI's `MarkResult` table.
 */
export function decideFailure(
  failure: UpstreamFailure,
  rules: ErrorRule[],
  now: number,
): FailureDecision {
  const none: FailureDecision = {
    credentialScope: false,
    forceCooldown: false,
    action: "continue",
    retryRound: false,
    rebindOnQuota: false,
  };

  if (failure.kind === "aborted") return { ...none, action: "stop" };

  const ruleAction = matchErrorRule(rules, failure);
  const classified = classifyStatus(failure, now);
  if (ruleAction) {
    const withCooldown = ruleAction.endsWith("-and-cooldown");
    return {
      ...classified,
      reason: withCooldown ? (classified.reason ?? "other") : undefined,
      forceCooldown: withCooldown,
      action: ruleAction.startsWith("stop") ? "stop" : "continue",
      retryRound: false,
    };
  }

  // A provider that already streamed or produced content cannot be retried transparently.
  if (failure.outputStarted) return { ...classified, action: "stop", retryRound: false };
  return classified;
}

function classifyStatus(failure: UpstreamFailure, now: number): FailureDecision {
  const retryAfterMs = upstreamRetryAfterMs(failure, now);
  const base: FailureDecision = {
    retryAfterMs,
    credentialScope: false,
    forceCooldown: false,
    action: "continue",
    retryRound: false,
    rebindOnQuota: false,
  };

  if (failure.kind === "transport") return { ...base, retryRound: true };
  if (failure.kind === "empty_stream") return { ...base, reason: "transient", retryRound: true };

  const status = failure.status ?? 0;
  const text = `${failure.body ?? ""}\n${failure.message}`;
  const retryRound = RETRY_ROUND_STATUSES.has(status) || (status >= 520 && status <= 526);

  if ((status === 400 || status === 404) && MODEL_UNSUPPORTED.test(text)) {
    return { ...base, reason: "model_unsupported", rebindOnQuota: true };
  }
  if (REQUEST_INVALID_STATUSES.has(status)) return { ...base, action: "stop" };
  if (status === 401) return { ...base, reason: "unauthorized", rebindOnQuota: true };
  if (status === 402 || status === 403) {
    return { ...base, reason: "payment_required", rebindOnQuota: true, retryRound };
  }
  if (status === 404) return { ...base, reason: "not_found", rebindOnQuota: true };
  if (status === 429) {
    return {
      ...base,
      reason: "quota",
      credentialScope: CREDENTIAL_QUOTA.test(text),
      rebindOnQuota: true,
      retryRound,
    };
  }
  if (TRANSIENT_STATUSES.has(status)) return { ...base, reason: "transient", retryRound };
  return { ...base, reason: "other" };
}

/** Cooldown record fields that drive selection and backoff escalation. */
export type CooldownWindow = { nextRetryAt: number; backoffLevel: number };

/**
 * Next cooldown window for a failure, or null when no cooldown applies. Deadlines only
 * extend; failures inside an open quota window reuse it so concurrent 429s escalate once.
 */
export function nextCooldown(
  previous: CooldownWindow | null,
  decision: FailureDecision,
  transientErrorCooldownSeconds: number,
  now: number,
): CooldownWindow | null {
  if (!decision.reason) return null;

  const active = previous && previous.nextRetryAt > now ? previous : null;
  const level = previous?.backoffLevel ?? 0;
  let durationMs: number | undefined;
  let nextLevel = level;

  switch (decision.reason) {
    case "quota":
      if (decision.retryAfterMs !== undefined) {
        durationMs = Math.max(decision.retryAfterMs, COOLDOWN.minQuotaCooldownMs);
      } else if (active) {
        return active;
      } else {
        durationMs = Math.min(COOLDOWN.quotaBackoffBaseMs * 2 ** level, COOLDOWN.quotaBackoffMaxMs);
        nextLevel = level + 1;
      }
      break;
    case "unauthorized":
    case "payment_required":
      durationMs = COOLDOWN.authMs;
      break;
    case "not_found":
    case "model_unsupported":
      durationMs = decision.retryAfterMs ?? COOLDOWN.notFoundMs;
      break;
    case "transient":
      if (decision.retryAfterMs !== undefined) {
        durationMs = decision.retryAfterMs;
      } else if (transientErrorCooldownSeconds < 0) {
        durationMs = decision.forceCooldown ? COOLDOWN.otherMs : undefined;
      } else if (transientErrorCooldownSeconds === 0) {
        durationMs = COOLDOWN.transientMs;
      } else {
        durationMs = transientErrorCooldownSeconds * SECOND;
      }
      break;
    case "other":
      durationMs = COOLDOWN.otherMs;
      break;
  }

  if (durationMs === undefined || durationMs <= 0) {
    if (!decision.forceCooldown) return null;
    durationMs = COOLDOWN.otherMs;
  }

  const nextRetryAt = Math.max(active?.nextRetryAt ?? 0, now + durationMs);
  return { nextRetryAt, backoffLevel: nextLevel };
}

/**
 * Upstream reset deadline from `retry-after-ms`, `retry-after`, rejected Anthropic unified
 * windows, or `resets_at`/`resets_in_seconds` bodies. Deadlines past the longest plan window
 * are discarded.
 */
export function upstreamRetryAfterMs(failure: UpstreamFailure, now: number): number | undefined {
  const candidates: number[] = [];
  const headers = failure.headers ?? {};

  const retryAfterMs = Number(headers["retry-after-ms"]);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) candidates.push(retryAfterMs);

  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      if (seconds > 0) candidates.push(seconds * SECOND);
    } else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date) && date > now) candidates.push(date - now);
    }
  }

  // Anthropic reports a reset per window; only rejected windows bound the cooldown.
  for (const [name, value] of Object.entries(headers)) {
    const match = /^anthropic-ratelimit-unified(?:-([\w]+))?-reset$/.exec(name);
    if (!match) continue;
    const statusHeader = match[1]
      ? `anthropic-ratelimit-unified-${match[1]}-status`
      : "anthropic-ratelimit-unified-status";
    if (headers[statusHeader] !== "rejected") continue;
    const resetSeconds = Number(value);
    if (Number.isFinite(resetSeconds) && resetSeconds * SECOND > now) {
      candidates.push(resetSeconds * SECOND - now);
    }
  }

  const bodyReset = bodyResetMs(failure.body, now);
  if (bodyReset !== undefined) candidates.push(bodyReset);

  const valid = candidates.filter((value) => value > 0 && value <= COOLDOWN.maxResetMs);
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

function bodyResetMs(body: string | undefined, now: number): number | undefined {
  if (!body || !body.includes("reset")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  const fields = resetFieldsSchema.safeParse(
    errorEnvelopeSchema.safeParse(parsed).data?.error ?? parsed,
  );
  if (!fields.success) return undefined;
  const { resets_at: resetsAt, resets_in_seconds: resetsIn } = fields.data;

  // An absolute future reset wins; a past one falls back to the relative value.
  if (resetsAt !== undefined && resetsAt * SECOND > now) return resetsAt * SECOND - now;
  if (resetsIn !== undefined && resetsIn > 0) return resetsIn * SECOND;
  return undefined;
}

function lowercaseHeaders(headers: Record<string, string> | undefined) {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function safeRegexTest(pattern: string, text: string) {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}
