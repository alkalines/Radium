import { v } from "convex/values";

export const telemetryToolSchema = v.object({
  name: v.string(),
  status: v.union(v.literal("ok"), v.literal("error")),
  startedAt: v.number(),
  endedAt: v.number(),
  durationMs: v.number(),
  toolCallId: v.optional(v.string()),
  error: v.optional(v.string()),
  inputJson: v.optional(v.string()),
  outputJson: v.optional(v.string()),
});

export const completionTelemetrySchema = v.object({
  chatId: v.optional(v.id("aisdk_chats")),
  stepNumber: v.number(),
  startedAt: v.number(),
  endedAt: v.number(),
  durationMs: v.number(),
  inputJson: v.optional(v.string()),
  outputJson: v.optional(v.string()),
  tools: v.array(telemetryToolSchema),
});

export const telemetrySettingsSchema = v.object({
  enabled: v.boolean(),
  recordInputs: v.boolean(),
  recordOutputs: v.boolean(),
});
