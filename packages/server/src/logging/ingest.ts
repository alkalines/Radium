import {
  isLoggingEnvelopeWithinLimits,
  LOGGING_LIMITS,
  LOGGING_PRODUCT,
  LOGGING_SOURCES,
  type LoggingEnvelope,
} from "contracts/logging/contract";
import { takeToken, type RateLimit } from "../auth/ratelimit";
import type { Kv } from "../drivers/types";
import { logger, writeLogLine } from "./server";

/** Per-user budget of browser events (Convex: 60 per fixed one-minute window). */
const INGEST_LIMIT: RateLimit = {
  name: "logging-ingest",
  capacity: LOGGING_LIMITS.maxEventsPerWindow,
  periodMs: LOGGING_LIMITS.rateLimitWindowMs,
};

/**
 * Accepts one operational event from a signed-in browser (Convex `observability.events.ingest`).
 * The actor is the session user, never a client field. Only the frontend source and the Radium
 * product are accepted, within the shared envelope limits; the event goes to the stdout sink.
 *
 * @returns `false` when the event was dropped (over the rate limit, or invalid), never throws for
 * those, so a browser's fire-and-forget logging cannot fail.
 */
export async function ingestFrontendEvent(
  kv: Kv,
  actorId: string,
  envelope: LoggingEnvelope,
): Promise<boolean> {
  try {
    if (!(await takeToken(kv, INGEST_LIMIT, actorId))) {
      return false;
    }
    if (
      envelope.source !== LOGGING_SOURCES.frontend ||
      envelope.product !== LOGGING_PRODUCT ||
      !isLoggingEnvelopeWithinLimits(envelope)
    ) {
      logger.warn("logging.invalid_event");
      return false;
    }
    writeLogLine(envelope, { actorId });
    return true;
  } catch {
    // A rate-limiter outage drops browser logs; it never fails the caller.
    logger.error("logging.ingestion_failed");
    return false;
  }
}
