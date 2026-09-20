import { v, type Infer } from "convex/values";

export const LOGGING_VERSION = 1 as const;
export const LOGGING_PRODUCT = "radium" as const;
export const LOGGING_SOURCES = {
  backend: "convex",
  frontend: "frontend",
} as const;

export const LOGGING_LIMITS = {
  maxCorrelationValueLength: 128,
  maxEnvelopeCharacters: 8_192,
  maxEventLength: 128,
  maxFutureTimestampSkewMs: 5 * 60 * 1_000,
  maxIdentityLength: 256,
  maxMessageLength: 512,
  maxMetadataBytes: 2_048,
  maxMetadataEntries: 16,
  maxMetadataKeyLength: 64,
  maxMetadataValueLength: 256,
  maxProductLength: 64,
  maxSourceLength: 64,
  maxEventsPerWindow: 60,
  rateLimitWindowMs: 60 * 1_000,
} as const;

export const loggingLevelSchema = v.union(
  v.literal("debug"),
  v.literal("info"),
  v.literal("warn"),
  v.literal("error"),
);

const loggingMetadataValueSchema = v.union(v.string(), v.number(), v.boolean(), v.null());

export const loggingCorrelationSchema = v.object({
  requestId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  traceId: v.optional(v.string()),
});

export const loggingEnvelopeSchema = v.object({
  version: v.literal(LOGGING_VERSION),
  level: loggingLevelSchema,
  event: v.string(),
  message: v.optional(v.string()),
  source: v.string(),
  product: v.string(),
  timestamp: v.number(),
  metadata: v.optional(v.record(v.string(), loggingMetadataValueSchema)),
  correlation: v.optional(loggingCorrelationSchema),
});

export type LoggingEnvelope = Infer<typeof loggingEnvelopeSchema>;
export type LoggingLevel = Infer<typeof loggingLevelSchema>;
export type LoggingMetadata = NonNullable<LoggingEnvelope["metadata"]>;
export type LoggingCorrelation = NonNullable<LoggingEnvelope["correlation"]>;
export type LoggingEventInput = Omit<
  LoggingEnvelope,
  "source" | "product" | "timestamp" | "version"
> & {
  product?: string;
  source?: string;
  timestamp?: number;
};

/** Add the version and event time to the shared envelope without adding optional undefined fields. */
export function createLoggingEnvelope(input: LoggingEventInput): LoggingEnvelope {
  const envelope: LoggingEnvelope = {
    version: LOGGING_VERSION,
    level: input.level,
    event: input.event,
    source: input.source ?? LOGGING_SOURCES.frontend,
    product: input.product ?? LOGGING_PRODUCT,
    timestamp: input.timestamp ?? Date.now(),
  };

  if (input.message !== undefined) envelope.message = input.message;
  if (input.metadata !== undefined) envelope.metadata = input.metadata;
  if (input.correlation !== undefined) envelope.correlation = input.correlation;

  return envelope;
}

const safeIdentifierPattern = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const safeCorrelationPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const sensitiveMetadataKeyPattern =
  /(?:access.?token|api.?key|authorization|cookie|credential|email|identity|password|passwd|phone|private|prompt|secret|session|subject|token|transcript|user)/i;
const correlationKeys = new Set(["requestId", "sessionId", "traceId"]);
const loggingLevels = new Set(["debug", "info", "warn", "error"]);

/**
 * Validate the limits that Convex validators cannot express, without inspecting
 * or attempting to redact free-form log messages.
 */
export function isLoggingEnvelopeWithinLimits(
  envelope: LoggingEnvelope,
  now = Date.now(),
): boolean {
  if (typeof envelope !== "object" || envelope === null) return false;
  if (envelope.version !== LOGGING_VERSION || !loggingLevels.has(envelope.level)) return false;
  if (!safeIdentifier(envelope.event, LOGGING_LIMITS.maxEventLength)) return false;
  if (!safeIdentifier(envelope.source, LOGGING_LIMITS.maxSourceLength)) return false;
  if (!safeIdentifier(envelope.product, LOGGING_LIMITS.maxProductLength)) return false;
  if (!Number.isFinite(envelope.timestamp) || envelope.timestamp < 0) return false;
  if (envelope.timestamp > now + LOGGING_LIMITS.maxFutureTimestampSkewMs) return false;

  if (
    envelope.message !== undefined &&
    (typeof envelope.message !== "string" ||
      envelope.message.length > LOGGING_LIMITS.maxMessageLength)
  ) {
    return false;
  }

  if (envelope.metadata !== undefined) {
    if (typeof envelope.metadata !== "object" || envelope.metadata === null) return false;
    const metadataEntries = Object.entries(envelope.metadata);
    if (metadataEntries.length > LOGGING_LIMITS.maxMetadataEntries) return false;

    for (const [key, value] of metadataEntries) {
      if (
        !safeIdentifier(key, LOGGING_LIMITS.maxMetadataKeyLength) ||
        sensitiveMetadataKeyPattern.test(key)
      ) {
        return false;
      }
      if (typeof value === "string" && value.length > LOGGING_LIMITS.maxMetadataValueLength) {
        return false;
      }
      if (typeof value === "number" && !Number.isFinite(value)) return false;
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        value !== null
      ) {
        return false;
      }
    }

    let serializedMetadata: string | undefined;
    try {
      serializedMetadata = JSON.stringify(envelope.metadata);
    } catch {
      return false;
    }
    if (
      serializedMetadata === undefined ||
      serializedMetadata.length > LOGGING_LIMITS.maxMetadataBytes
    ) {
      return false;
    }
  }

  if (envelope.correlation !== undefined) {
    if (typeof envelope.correlation !== "object" || envelope.correlation === null) return false;
    for (const [key, value] of Object.entries(envelope.correlation)) {
      if (!correlationKeys.has(key) || value === undefined) return false;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > LOGGING_LIMITS.maxCorrelationValueLength ||
        !safeCorrelationPattern.test(value)
      ) {
        return false;
      }
    }
  }

  let serializedEnvelope: string | undefined;
  try {
    serializedEnvelope = JSON.stringify(envelope);
  } catch {
    return false;
  }
  return (
    serializedEnvelope !== undefined &&
    serializedEnvelope.length <= LOGGING_LIMITS.maxEnvelopeCharacters
  );
}

function safeIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    safeIdentifierPattern.test(value)
  );
}
