import { z } from "zod";
import { idOf } from "../wire";

/** Workspace capture settings. Capture is opt-in; content recording is opt-in per direction. */
export const telemetrySettingsSchema = z.object({
  enabled: z.boolean(),
  recordInputs: z.boolean(),
  recordOutputs: z.boolean(),
  /** Days to keep captured requests; absent keeps them until deleted. */
  retentionDays: z.optional(z.number()),
});
export type TelemetrySettings = z.infer<typeof telemetrySettingsSchema>;

export const telemetrySourceSchema = z.union([z.literal("chatroom"), z.literal("gateway")]);
export type TelemetrySource = z.infer<typeof telemetrySourceSchema>;

export const telemetryUsageSchema = z.object({
  inputTokens: z.optional(z.number()),
  outputTokens: z.optional(z.number()),
  totalTokens: z.optional(z.number()),
  reasoningTokens: z.optional(z.number()),
  cacheReadTokens: z.optional(z.number()),
  cacheWriteTokens: z.optional(z.number()),
  cacheWrite1hTokens: z.optional(z.number()),
});
export type TelemetryUsage = z.infer<typeof telemetryUsageSchema>;

/**
 * Content-addressed blob kinds. `message` covers both client-sent messages and model output so
 * an output echoed back verbatim by the client resolves to the same node.
 */
export const telemetryBlobKindSchema = z.union([
  z.literal("message"),
  z.literal("system"),
  z.literal("tool"),
  z.literal("toolset"),
  z.literal("params"),
  z.literal("headers"),
  z.literal("legacy"),
]);
export type TelemetryBlobKind = z.infer<typeof telemetryBlobKindSchema>;

/** Non-content facts kept even when content recording is off. */
export const telemetryBlobMetaSchema = z.object({
  role: z.optional(z.string()),
  /** Tool name for `tool` blobs; tool-call names for assistant messages. */
  names: z.optional(z.array(z.string())),
  toolCallId: z.optional(z.string()),
});
export type TelemetryBlobMeta = z.infer<typeof telemetryBlobMetaSchema>;

export const telemetryRequestStatusSchema = z.union([
  z.literal("ok"),
  z.literal("error"),
  z.literal("aborted"),
]);
export type TelemetryRequestStatus = z.infer<typeof telemetryRequestStatusSchema>;

/** One provider/credential attempt made by routing for a request, in dispatch order. */
export const telemetryAttemptSchema = z.object({
  provider: z.string(),
  credential: z.optional(idOf("workspace_credentials")),
  providerModel: z.optional(z.string()),
  startedAt: z.number(),
  durationMs: z.number(),
  outcome: z.union([z.literal("ok"), z.literal("error"), z.literal("aborted")]),
  status: z.optional(z.number()),
  errorKind: z.optional(z.string()),
  message: z.optional(z.string()),
});
export type TelemetryAttempt = z.infer<typeof telemetryAttemptSchema>;

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
export const telemetryLineageSchema = z.object({
  kind: z.union([
    z.literal("root"),
    z.literal("continue"),
    z.literal("retry"),
    z.literal("rewrite"),
    z.literal("branch"),
    z.literal("compacted"),
  ]),
  request: z.optional(idOf("telemetry_requests")),
  /** Depth (1-based message count) of the shared prefix. */
  depth: z.optional(z.number()),
});
export type TelemetryLineage = z.infer<typeof telemetryLineageSchema>;

const blobChange = z.object({
  from: z.optional(idOf("telemetry_blobs")),
  to: z.optional(idOf("telemetry_blobs")),
});

/** Differences from the previous request in the same session; absent fields are unchanged. */
export const telemetryChangesSchema = z.object({
  previous: idOf("telemetry_requests"),
  system: z.optional(blobChange),
  toolset: z.optional(blobChange),
  params: z.optional(blobChange),
  model: z.optional(z.object({ from: z.string(), to: z.string() })),
});
export type TelemetryChanges = z.infer<typeof telemetryChangesSchema>;

/** Export destination kinds. Both send OTLP/JSON trace payloads. */
export const telemetryDestinationKindSchema = z.union([z.literal("otlp"), z.literal("webhook")]);

// Legacy AI SDK trace validators. Kept only so the deprecated `telemetry_*` tables stay valid
// until `migrations:telemetryTracesToRequests` has moved their rows; remove with those tables.
export const legacyTelemetryStatusSchema = z.union([
  z.literal("running"),
  z.literal("ok"),
  z.literal("error"),
  z.literal("aborted"),
]);
export const legacyTelemetrySpanKindSchema = z.union([
  z.literal("step"),
  z.literal("model"),
  z.literal("tool"),
]);
