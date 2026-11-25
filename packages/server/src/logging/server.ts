import {
  createLoggingEnvelope,
  isLoggingEnvelopeWithinLimits,
  LOGGING_PRODUCT,
  LOGGING_SOURCES,
  type LoggingEnvelope,
  type LoggingEventInput,
  type LoggingLevel,
} from "contracts/logging/contract";

/**
 * Operational logging (`docs/logging.md`): the bounded v1 envelope written as one JSON line to
 * stdout. There is no table; the process's log stream is the sink. Invalid envelopes and sink
 * failures are dropped, so logging never changes the behavior of the operation it observes.
 */

export type ServerLogInput = Omit<LoggingEventInput, "product" | "source">;
type ServerLogFields = Omit<ServerLogInput, "event" | "level">;

/** Writes one envelope that already passed the limits, with any server-derived fields. */
export function writeLogLine(envelope: LoggingEnvelope, extra?: { actorId?: string }) {
  try {
    console.log(JSON.stringify({ ...envelope, ...extra, receivedAt: Date.now() }));
  } catch {
    // Logging must never change the behavior of the operation being observed.
  }
}

/** Logs one backend event; dropped when it exceeds the envelope limits. */
export function logOperationalEvent(input: ServerLogInput): void {
  try {
    const envelope = createLoggingEnvelope({
      ...input,
      product: LOGGING_PRODUCT,
      source: LOGGING_SOURCES.server,
    });
    if (!isLoggingEnvelopeWithinLimits(envelope)) return;
    writeLogLine(envelope);
  } catch {
    // Logging must never change the behavior of the operation being observed.
  }
}

function write(level: LoggingLevel, event: string, fields: ServerLogFields = {}): void {
  logOperationalEvent({ level, event, ...fields });
}

/** Level-specific façade over the shared bounded operational event envelope. */
export const logger = {
  debug: (event: string, fields?: ServerLogFields) => write("debug", event, fields),
  error: (event: string, fields?: ServerLogFields) => write("error", event, fields),
  info: (event: string, fields?: ServerLogFields) => write("info", event, fields),
  warn: (event: string, fields?: ServerLogFields) => write("warn", event, fields),
};
