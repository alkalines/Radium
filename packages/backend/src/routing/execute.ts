import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ActionCtx } from "../../convex/_generated/server";
import { createRoutedProvider, type RoutedProvider } from "./connector";
import {
  boundedMessage,
  decideFailure,
  type FailureDecision,
  type UpstreamFailure,
} from "./failures";
import type { RoutingPreferences } from "./preferences";
import type { RoutingSession } from "./session";
import type { CooldownReason, RoutingSettings } from "./settings";

/** One routed request: who is asking, for which model, and with which preferences. */
export type RoutingRequest = {
  workspace: Id<"workspaces">;
  model: string;
  preferences: RoutingPreferences;
  session?: RoutingSession;
  signal?: AbortSignal | null;
};

/**
 * Result of one attempt. An attempt succeeds once the provider has produced its first payload;
 * failures before that point may fail over to another provider.
 */
export type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; failure: UpstreamFailure };

/** A committed attempt plus a hook for failures that arrive after output started. */
export type RoutedResult<T> = {
  value: T;
  provider: RoutedProvider;
  /** Record a mid-stream failure for cooldown and session state; never retried. */
  reportLateFailure: (failure: UpstreamFailure) => Promise<void>;
};

/** Routing gave up; `status` and `retryAfterMs` describe the last observed failure. */
export class RoutingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

type ReportOutcome =
  | { type: "success" }
  | {
      type: "failure";
      reason?: CooldownReason;
      retryAfterMs?: number;
      credentialScope: boolean;
      forceCooldown: boolean;
      rebindOnQuota: boolean;
      status?: number;
      message: string;
    };

/** CLIProxyAPI waits at least this long before re-trying a provider that just returned 429. */
const MIN_RATE_LIMIT_RETRY_WAIT_MS = 10_000;
const MAX_RETRY_JITTER_MS = 2_000;

/**
 * Run `attempt` against routed provider credentials until one succeeds, following CLIProxyAPI's
 * retry model: each round tries untried credentials (up to `maxRetryCredentials`); after a round
 * that ended on a retryable failure, or with every credential cooling, wait for the soonest
 * cooldown if it ends within `maxRetryIntervalSeconds`, for at most `requestRetry` extra rounds.
 * Error-rule `stop`, request-invalid errors, failures after output started, and aborts end routing
 * immediately. Every attempt outcome is reported for cooldown and session-affinity state.
 */
export async function routeWithFailover<T>(
  ctx: ActionCtx,
  request: RoutingRequest,
  attempt: (provider: RoutedProvider) => Promise<AttemptOutcome<T>>,
): Promise<RoutedResult<T>> {
  let settings: RoutingSettings | undefined;
  let lastFailure:
    | { failure: UpstreamFailure; decision: FailureDecision; provider: string }
    | undefined;
  let unavailable: { retryAfterMs?: number; message: string } | undefined;

  for (let round = 0; ; round++) {
    const tried: Array<{ provider: string; credential?: Id<"workspace_credentials"> }> = [];
    unavailable = undefined;

    while (
      !settings ||
      settings.maxRetryCredentials === 0 ||
      tried.length < settings.maxRetryCredentials
    ) {
      const pick = await ctx.runMutation(internal.routing.pick, {
        workspace: request.workspace,
        model: request.model,
        preferences: request.preferences,
        session: request.session,
        excluded: tried,
      });
      settings = pick.settings;
      if (!pick.ok) {
        unavailable = pick;
        break;
      }

      const target = pick.provider;
      const attempted = { provider: target.slug, credential: target.credential.id };
      tried.push(attempted);
      const dispatchedAt = Date.now();
      const report = (outcome: ReportOutcome) =>
        reportOutcome(ctx, request, attempted, outcome, dispatchedAt);

      let routed: RoutedProvider | undefined;
      let outcome: AttemptOutcome<T> | undefined;
      try {
        routed = createRoutedProvider(ctx, target);
      } catch (error) {
        // Connector construction failed (for example a missing API key): treat as unauthorized.
        const message = boundedMessage(error instanceof Error ? error.message : String(error));
        outcome = {
          ok: false,
          failure: { kind: "http", status: 401, message, outputStarted: false },
        };
      }
      outcome ??= await attempt(routed!);

      if (outcome.ok) {
        await report({ type: "success" });
        return {
          value: outcome.value,
          provider: routed!,
          reportLateFailure: async (failure) => {
            const decision = decideFailure(failure, target.routing.errorRules, Date.now());
            await report(failureReport(failure, decision));
          },
        };
      }

      const failure = outcome.failure;
      const decision = decideFailure(failure, target.routing.errorRules, Date.now());
      await report(failureReport(failure, decision));
      lastFailure = { failure, decision, provider: target.slug };

      if (failure.kind === "aborted" || request.signal?.aborted) {
        throw request.signal?.reason ?? new DOMException("Request aborted.", "AbortError");
      }
      if (decision.action === "stop") throw routingErrorFrom(lastFailure);
    }

    if (round >= settings.requestRetry) break;

    // Another round helps only after a retryable failure, or when providers are merely cooling.
    const retryable = lastFailure ? lastFailure.decision.retryRound : unavailable !== undefined;
    if (!retryable) break;

    let waitMs = unavailable?.retryAfterMs ?? 0;
    // With cooling enabled, a provider that just returned 429 is excluded by its cooldown already.
    if (lastFailure?.failure.status === 429 && settings.disableCooling) {
      waitMs = Math.max(waitMs, MIN_RATE_LIMIT_RETRY_WAIT_MS);
    }
    if (waitMs > 0) {
      const maxWaitMs = settings.maxRetryIntervalSeconds * 1000;
      if (waitMs > maxWaitMs) break;
      const jitter = Math.random() * Math.min(waitMs / 4, MAX_RETRY_JITTER_MS);
      await sleep(Math.min(waitMs + jitter, maxWaitMs), request.signal);
    }
  }

  if (lastFailure) throw routingErrorFrom(lastFailure);
  throw new RoutingError(
    unavailable?.message ?? "No provider is available.",
    429,
    unavailable?.retryAfterMs,
  );
}

function failureReport(failure: UpstreamFailure, decision: FailureDecision): ReportOutcome {
  return {
    type: "failure",
    reason: decision.reason,
    retryAfterMs: decision.retryAfterMs,
    credentialScope: decision.credentialScope,
    forceCooldown: decision.forceCooldown,
    rebindOnQuota: decision.rebindOnQuota,
    status: failure.status,
    message: boundedMessage(failure.message),
  };
}

async function reportOutcome(
  ctx: ActionCtx,
  request: RoutingRequest,
  target: { provider: string; credential?: Id<"workspace_credentials"> },
  outcome: ReportOutcome,
  dispatchedAt: number,
) {
  // Routing state is advisory; a failed write must not fail the request itself.
  try {
    await ctx.runMutation(internal.routing.reportResult, {
      workspace: request.workspace,
      provider: target.provider,
      credential: target.credential,
      model: request.model,
      dispatchedAt,
      session: request.session,
      outcome,
    });
  } catch (error) {
    console.error("Failed to record routing outcome", { provider: target.provider, error });
  }
}

function routingErrorFrom(last: {
  failure: UpstreamFailure;
  decision: FailureDecision;
  provider: string;
}) {
  const status = last.failure.status ?? (last.failure.kind === "empty_stream" ? 502 : 503);
  return new RoutingError(last.failure.message, status, last.decision.retryAfterMs, last.provider);
}

function sleep(ms: number, signal?: AbortSignal | null) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }

  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}
