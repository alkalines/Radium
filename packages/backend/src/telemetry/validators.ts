import { v, type Infer } from "convex/values";

/** Workspace capture settings. Capture is opt-in; content recording is opt-in per direction. */
export const telemetrySettingsSchema = v.object({
  enabled: v.boolean(),
  recordInputs: v.boolean(),
  recordOutputs: v.boolean(),
  /** Days to keep captured requests; absent keeps them until deleted. */
  retentionDays: v.optional(v.number()),
});
export type TelemetrySettings = Infer<typeof telemetrySettingsSchema>;

export const telemetrySourceSchema = v.union(v.literal("chatroom"), v.literal("gateway"));
export type TelemetrySource = Infer<typeof telemetrySourceSchema>;

export const telemetryUsageSchema = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
  cacheReadTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
});
export type TelemetryUsage = Infer<typeof telemetryUsageSchema>;

/**
 * Content-addressed blob kinds. `message` covers both client-sent messages and model output so
 * an output echoed back verbatim by the client resolves to the same node.
 */
export const telemetryBlobKindSchema = v.union(
  v.literal("message"),
  v.literal("system"),
  v.literal("tool"),
  v.literal("toolset"),
  v.literal("params"),
  v.literal("headers"),
  v.literal("legacy"),
);
export type TelemetryBlobKind = Infer<typeof telemetryBlobKindSchema>;

/** Non-content facts kept even when content recording is off. */
export const telemetryBlobMetaSchema = v.object({
  role: v.optional(v.string()),
  /** Tool name for `tool` blobs; tool-call names for assistant messages. */
  names: v.optional(v.array(v.string())),
  toolCallId: v.optional(v.string()),
});
export type TelemetryBlobMeta = Infer<typeof telemetryBlobMetaSchema>;

export const telemetryRequestStatusSchema = v.union(
  v.literal("ok"),
  v.literal("error"),
  v.literal("aborted"),
);
export type TelemetryRequestStatus = Infer<typeof telemetryRequestStatusSchema>;

/** One provider/credential attempt made by routing for a request, in dispatch order. */
export const telemetryAttemptSchema = v.object({
  provider: v.string(),
  credential: v.optional(v.id("workspace_credentials")),
  providerModel: v.optional(v.string()),
  startedAt: v.number(),
  durationMs: v.number(),
  outcome: v.union(v.literal("ok"), v.literal("error"), v.literal("aborted")),
  status: v.optional(v.number()),
  errorKind: v.optional(v.string()),
  message: v.optional(v.string()),
});
export type TelemetryAttempt = Infer<typeof telemetryAttemptSchema>;

/**
 * How a request's conversation relates to earlier requests in its session.
 * - root: first request of a conversation with no stored prefix and no earlier session request.
 * - continue: extends the output (or input, when no output exists) of `request`.
 * - retry: resends exactly the input of `request` (regenerate).
 * - rewrite: extends the input of `request` but replaces its stored output.
 * - branch: diverges at `depth` from a message that already had a continuation (rollback/edit);
 *   both branches are kept.
 * - compacted: shares no prefix with stored history while the session already has requests.
 */
export const telemetryLineageSchema = v.object({
  kind: v.union(
    v.literal("root"),
    v.literal("continue"),
    v.literal("retry"),
    v.literal("rewrite"),
    v.literal("branch"),
    v.literal("compacted"),
  ),
  request: v.optional(v.id("telemetry_requests")),
  /** Depth (1-based message count) of the shared prefix. */
  depth: v.optional(v.number()),
});
export type TelemetryLineage = Infer<typeof telemetryLineageSchema>;

const blobChange = v.object({
  from: v.optional(v.id("telemetry_blobs")),
  to: v.optional(v.id("telemetry_blobs")),
});

/** Differences from the previous request in the same session; absent fields are unchanged. */
export const telemetryChangesSchema = v.object({
  previous: v.id("telemetry_requests"),
  system: v.optional(blobChange),
  toolset: v.optional(blobChange),
  params: v.optional(blobChange),
  model: v.optional(v.object({ from: v.string(), to: v.string() })),
});
export type TelemetryChanges = Infer<typeof telemetryChangesSchema>;

/** Export destination kinds. Both send OTLP/JSON trace payloads. */
export const telemetryDestinationKindSchema = v.union(v.literal("otlp"), v.literal("webhook"));

// Legacy AI SDK trace validators. Kept only so the deprecated `telemetry_*` tables stay valid
// until `migrations:telemetryTracesToRequests` has moved their rows; remove with those tables.
export const legacyTelemetryStatusSchema = v.union(
  v.literal("running"),
  v.literal("ok"),
  v.literal("error"),
  v.literal("aborted"),
);
export const legacyTelemetrySpanKindSchema = v.union(
  v.literal("step"),
  v.literal("model"),
  v.literal("tool"),
);
