import {
  createLoggingEnvelope,
  isLoggingEnvelopeWithinLimits,
  LOGGING_PRODUCT,
  LOGGING_SOURCES,
  type LoggingEventInput,
  type LoggingLevel,
} from "./contract";

export type BackendLogInput = Omit<LoggingEventInput, "product" | "source">;
type BackendLogFields = Omit<BackendLogInput, "event" | "level">;

/**
 * Best-effort Convex logger. Invalid envelopes and sink failures are ignored so
 * operational logging cannot change the behavior of the observed operation.
 */
export function logOperationalEvent(input: BackendLogInput): void {
  try {
    const envelope = createLoggingEnvelope({
      ...input,
      product: LOGGING_PRODUCT,
      source: LOGGING_SOURCES.backend,
    });
    if (!isLoggingEnvelopeWithinLimits(envelope)) return;
    console.log(envelope);
  } catch {
    // Logging must never change the behavior of the operation being observed.
  }
}

function write(level: LoggingLevel, event: string, fields: BackendLogFields = {}): void {
  logOperationalEvent({ level, event, ...fields });
}

/** Level-specific façade over the shared bounded operational event envelope. */
export const logger = {
  debug: (event: string, fields?: BackendLogFields) => write("debug", event, fields),
  error: (event: string, fields?: BackendLogFields) => write("error", event, fields),
  info: (event: string, fields?: BackendLogFields) => write("info", event, fields),
  warn: (event: string, fields?: BackendLogFields) => write("warn", event, fields),
};
