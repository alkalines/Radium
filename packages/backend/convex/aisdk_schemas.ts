import { v } from "convex/values";

const TextUIPartSchema = v.object({
  type: v.literal("text"),
  text: v.string(),
  state: v.union(v.literal("streaming"), v.literal("done")),
  providerMetadata: v.optional(v.any()),
});

const ReasoningUIPartSchema = v.object({
  type: v.literal("reasoning"),
  text: v.string(),
  state: v.union(v.literal("streaming"), v.literal("done")),
  providerMetadata: v.optional(v.any()),
  duration: v.optional(v.number()), // Duration in seconds
});

const SourceUrlUIPartSchema = v.object({
  type: v.literal("source-url"),
  sourceId: v.string(),
  url: v.string(),
  title: v.optional(v.string()),
  providerMetadata: v.optional(v.any()),
});

const SourceDocumentUIPartSchema = v.object({
  type: v.literal("source-document"),
  sourceId: v.string(),
  mediaType: v.string(),
  title: v.string(),
  filename: v.optional(v.string()),
  providerMetadata: v.optional(v.any()),
});

const MessageFileUIPartSchema = v.object({
  type: v.literal("file"),
  mediaType: v.string(),
  filename: v.optional(v.string()),
  url: v.string(),
  providerMetadata: v.optional(v.any()),
});

const StepStartUIPartSchema = v.object({
  type: v.literal("step-start"),
});

// AI SDK data parts are extensible, so keep their persisted payloads forward-compatible.
const DataUIPartSchema = v.any();

/** Persisted AI SDK UI message shape; keep its accepted parts compatible with stored chats. */
export const messageSchema = v.object({
  id: v.optional(v.string()),
  role: v.union(v.literal("system"), v.literal("user"), v.literal("assistant")),
  metadata: v.optional(v.any()),
  parts: v.array(
    v.union(
      TextUIPartSchema,
      ReasoningUIPartSchema,
      SourceUrlUIPartSchema,
      SourceDocumentUIPartSchema,
      MessageFileUIPartSchema,
      StepStartUIPartSchema,
      DataUIPartSchema,
    ),
  ),
});

const QueuedFileUIPartSchema = v.object({
  type: v.literal("file"),
  mediaType: v.string(),
  filename: v.optional(v.string()),
  url: v.optional(v.string()),
  providerMetadata: v.optional(v.any()),
});

/** User message held for the next assistant generation before it is appended to chat history. */
export const queuedMessageSchema = v.object({
  text: v.string(),
  files: v.array(QueuedFileUIPartSchema),
  model: v.string(), // Slug, not the ID
  provider: v.optional(v.string()),
  serviceTier: v.optional(v.string()),
  inferenceMode: v.optional(v.string()),
  reasoningEffort: v.optional(v.string()),
  reasoningBudget: v.optional(v.number()),
  // @todo: Better tool selector
  webSearch: v.boolean(),
});
