import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { completionPricingSchema, completionUsageSchema } from "./key";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";

export default defineSchema({
  balances: defineTable({
    credits: v.number(),
    userId: v.string(), // Better Auth ID
    organizationId: v.optional(v.string()),
    teamId: v.optional(v.string()),
  }),
  keys: defineTable({
    balance: v.id("balances"),
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
    bill: v.object({
      balance: v.id("balances"),
      key: v.optional(v.id("keys")),
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
    launch_date: v.number(), // UNIX in ms
    author: v.id("authors"),
    slug: v.string(),
    model_weights: v.optional(v.string()), // Link
    // @todo Embedding Support and Image Generation (fal.ai syntax probably)
    type: v.union(v.literal("chat"), v.literal("embedding"), v.literal("image-generation")),
    description: v.string(),
    warning: v.optional(v.string()),
    reasoning: v.boolean(),
    features: v.object({
      reasoning_minimal: v.optional(v.boolean()),
      reasoning_none: v.optional(v.boolean()),
      reasoning_budget: v.optional(v.boolean()),
      reasoning_efforts: v.optional(v.array(v.string())),
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
            v.literal("fp32"), // Floating point (32 bit)
          ),
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
            v.literal("verbosity"),
          ),
        ),
        promotions: v.optional(
          v.object({
            // Needs to be a string otherwise JS just fucks everything
            input: v.optional(v.string()),
            output: v.optional(v.string()),
            cache_read: v.optional(v.string()),
            cache_write: v.optional(v.string()),
            // @todo Support audio and video
          }),
        ),
        moderated: v.boolean(),
      }),
    ),
    architecture: v.object({
      input_modalities: v.array(
        v.union(
          v.literal("text"),
          v.literal("image"),
          v.literal("file"),
          v.literal("audio"),
          v.literal("video"),
          v.string(),
        ),
      ),
      output_modalities: v.array(
        v.union(v.literal("text"), v.literal("image"), v.literal("embeddings"), v.string()),
      ),
      tokenizer: v.union(
        v.string(),
        v.literal("GPT"),
        v.literal("Claude"),
        v.literal("Gemini"),
        v.literal("Grok"),
        v.literal("Cohere"),
        v.literal("Nova"),
        v.literal("Qwen"),
        v.literal("Qwen3"),
        v.literal("Yi"),
        v.literal("DeepSeek"),
        v.literal("Mistral"),
        v.literal("Llama2"),
        v.literal("Llama3"),
        v.literal("Llama4"),
        v.literal("PaLM"),
        v.literal("RWKV"),
      ),
    }),
    default_parameters: v.optional(
      v.object({
        temperature: v.optional(v.number()),
        top_p: v.optional(v.number()),
        frequency_penalty: v.optional(v.number()),
      }),
    ),
  }),
  // providers: doesn't need to have a table because they should be hardcoded otherwise inference implementation would suck.
  authors: defineTable({
    name: v.string(),
    slug: v.string(),
  }),
  // Chatroom
  aisdk_chats: defineTable({
    userId: v.string(), // Better Auth ID
    balance: v.id("balances"),
    messages: v.array(messageSchema),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())), // Used only on home page
    chat_completions: v.array(v.id("chat_completions")),
    title: v.optional(v.string()),
    emoji: v.optional(v.string()),
    activeStream: v.optional(v.boolean()),
    lastInteractionAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_lastInteractionAt", ["userId", "lastInteractionAt"]),
});
