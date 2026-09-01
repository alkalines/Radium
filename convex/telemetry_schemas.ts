import { v } from "convex/values";

export const telemetryStatusSchema = v.union(
  v.literal("running"),
  v.literal("ok"),
  v.literal("error"),
  v.literal("aborted"),
);

export const telemetrySpanKindSchema = v.union(
  v.literal("step"),
  v.literal("model"),
  v.literal("tool"),
);

export const telemetrySourceSchema = v.union(v.literal("chatroom"), v.literal("gateway"));

export const telemetryUsageSchema = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
  cacheReadTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
});

export const telemetrySettingsSchema = v.object({
  enabled: v.boolean(),
  recordInputs: v.boolean(),
  recordOutputs: v.boolean(),
});
