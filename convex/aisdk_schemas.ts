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

const FileUIPartPartSchema = v.object({
  type: v.literal("file"),
  mediaType: v.string(),
  filename: v.optional(v.string()),
  url: v.string(),
  providerMetadata: v.optional(v.any()),
});

const StepStartUIPartSchema = v.object({
  type: v.literal("file"),
});

const DataUIPartSchema = v.any(); // To complex to keep up to date

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
      FileUIPartPartSchema,
      StepStartUIPartSchema,
      DataUIPartSchema
    )
  ),
});

const FileUIPartSchema = v.object({
  type: v.literal("file"),
  mediaType: v.string(),
  filename: v.optional(v.string()),
  url: v.optional(v.string()),
  providerMetadata: v.optional(v.any()),
});

export const queuedMessageSchema = v.object({
  text: v.string(),
  files: v.array(FileUIPartSchema),
  model: v.string(), // Slug, not the ID
  // @todo: Better tool selector
  webSearch: v.boolean()
});