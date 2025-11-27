import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { completionPricingSchema, completionUsageSchema } from "./key";

export default defineSchema({
  users: defineTable({
    credits: v.number(),
    // more later
  }),
  keys: defineTable({
    user: v.id("users"),
    creditLimit: v.optional(v.number()),
    usedCredits: v.number(),
    name: v.string(),
    hash: v.string(),
  }),
  ai_apps: defineTable({
    title: v.string(),
    url: v.string(),
    icon: v.optional(v.string()), // URL
  }),
  chat_completions: defineTable({
    user: v.object({
      id: v.id("users"),
      key: v.id("keys"),
    }),
    request: v.object({
      provider: v.string(),
      byok: v.boolean(),
      app: v.optional(v.id("ai_apps")),
      model: v.id("models"),
      streamed: v.boolean(),
      canceled: v.boolean(),
    }),
    response: v.object({
      genId: v.string(),
      providerGenId: v.string(),
      usage: completionUsageSchema,
      pricing: completionPricingSchema,
      moderation_latency: v.optional(v.number()),
      ttft: v.number(), // Time To First Token
      gen_time: v.number(),
      finish_reason: v.string(),
    }),
  }),
  models: defineTable({
    name: v.string(),
    author: v.id("authors"),
    slug: v.string(),
    model_weights: v.optional(v.string()), // Link
    // @todo Embedding Support and Image Generation (fal.ai syntax probably)
    type: v.union(
      v.literal("chat"),
      v.literal("embedding"),
      v.literal("image-generation")
    ),
    description: v.string(),
    warning: v.optional(v.string()),
    reasoning: v.boolean(),
    features: v.object({
      reasoning_minimal: v.optional(v.boolean()),
      reasoning_none: v.optional(v.boolean()),
      supported_parameters: v.array(
        v.union(
          v.literal("temperature"),
          v.literal("top_p"),
          v.literal("top_k"),
          v.literal("frequency_penalty"),
          v.literal("presence_penalty"),
          v.literal("repetition_penalty"),
          v.literal("min_p"),
          v.literal("top_a"),
          v.literal("seed"),
          v.literal("max_tokens"),
          v.literal("logit_bias"),
          v.literal("logprobs"),
          v.literal("top_logprobs"),
          v.literal("response_format"),
          v.literal("structured_outputs"),
          v.literal("stop"),
          v.literal("tools"),
          v.literal("tool_choice"),
          v.literal("parallel_tool_calls"),
          v.literal("verbosity")
        )
      ),
    }),
    // Model Context, Pricing and Others should be gotten from providers
    providers: v.array(
      v.object({
        id: v.string(),
        quantization: v.optional(
          v.union(
            v.literal("int4"), // Integer (4 bit)
            v.literal("int8"), // Integer (8 bit)
            v.literal("fp4"), // Floating point (4 bit)
            v.literal("fp6"), // Floating point (6 bit)
            v.literal("fp8"), // Floating point (8 bit)
            v.literal("fp16"), // Floating point (16 bit)
            v.literal("bf16"), // Brain floating point (16 bit)
            v.literal("fp32") // Floating point (32 bit)
          )
        ),
        context: v.number(), // 400k = 400,000
        max_output: v.number(),
        pricing: v.object({
          // Needs to be a string otherwise JS just fucks everything
          input: v.string(),
          output: v.string(),
          cache_read: v.optional(v.string()),
          cache_write: v.optional(v.string()),
          // @todo Support audio and video
        }),
        promotions: v.optional(
          v.object({
            // Needs to be a string otherwise JS just fucks everything
            input: v.optional(v.string()),
            output: v.optional(v.string()),
            cache_read: v.optional(v.string()),
            cache_write: v.optional(v.string()),
            // @todo Support audio and video
          })
        ),
      })
    ),
  }),
  // providers: doesn't need to have a table because they should be hardcoded otherwise inference implementation would suck.
  authors: defineTable({
    name: v.string(),
    slug: v.string(),
    icon: v.string() // URL
  })
});
