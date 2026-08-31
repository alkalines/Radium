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
    /** Masked, non-secret display value (e.g. `rad-sk-…aB12`). */
    preview: v.optional(v.string()),
  })
    .index("by_hash", ["hash"])
    .index("by_balance", ["balance"]),
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
  }).index("by_balance", ["bill.balance"]),
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
  }).index("by_slug", ["slug"]),
  providers: defineTable({
    slug: v.string(),
    name: v.string(),
    npm: v.union(
      v.literal("@openrouter/ai-sdk-provider"),
      v.literal("@ai-sdk/openai"),
      v.literal("@ai-sdk/openai-compatible"),
      v.literal("@ai-sdk/anthropic"),
      v.literal("@opencoredev/loginwithchatgpt-ai"),
    ),
    env: v.array(v.string()),
    catalogue_provider: v.optional(v.string()),
    credential_type: v.optional(v.union(v.literal("api_key"), v.literal("oauth"))),
    oauth_flow: v.optional(v.string()),
    doc: v.optional(v.string()),
    api: v.optional(v.string()),
    enabled: v.boolean(),
    models: v.array(
      v.object({
        model: v.string(),
        upstream_model_id: v.optional(v.string()),
        quantization: v.optional(
          v.union(
            v.literal("int4"),
            v.literal("int8"),
            v.literal("fp4"),
            v.literal("fp6"),
            v.literal("fp8"),
            v.literal("fp16"),
            v.literal("bf16"),
            v.literal("fp32"),
          ),
        ),
        context: v.number(),
        max_output: v.number(),
        pricing: v.object({
          input: v.string(),
          output: v.string(),
          cache_read: v.optional(v.string()),
          cache_write: v.optional(v.string()),
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
            input: v.optional(v.string()),
            output: v.optional(v.string()),
            cache_read: v.optional(v.string()),
            cache_write: v.optional(v.string()),
          }),
        ),
        moderated: v.boolean(),
      }),
    ),
  }).index("by_slug", ["slug"]),
  subscription_state: defineTable({
    provider: v.string(),
    namespace: v.union(v.literal("session"), v.literal("rate_limit")),
    key: v.string(),
    value: v.any(),
    expiresAt: v.optional(v.number()),
  }).index("by_provider_namespace_key", ["provider", "namespace", "key"]),
  authors: defineTable({
    name: v.string(),
    slug: v.string(),
  }),
  // Chatroom
  /**
   * A user-attached MCP (Model Context Protocol) server. Secrets (e.g. the
   * bearer token) are stored in the Secret Store component; this table only
   * keeps non-secret connection metadata and masked previews.
   */
  mcp_servers: defineTable({
    userId: v.string(), // Better Auth ID
    name: v.string(),
    url: v.string(),
    transport: v.literal("http"), // @todo support v.literal("sse")
    auth: v.union(
      v.object({ type: v.literal("none") }),
      v.object({ type: v.literal("bearer") }),
      // @todo v.object({ type: v.literal("oauth"), ... }) — OAuth 2.0
      // @todo v.object({ type: v.literal("oauth2.1"), ... }) — OAuth 2.1 + PKCE
    ),
    /** Masked, non-secret previews of the stored secrets for display. */
    preview: v.optional(v.record(v.string(), v.string())),
  }).index("by_userId", ["userId"]),
  /**
   * The user's chatroom settings (per BetterAuth user). Holds the default tool
   * selection copied into new chats (editable from Chatroom → Tools) and the
   * default model new chats pre-select (editable from Chatroom → Preferences).
   */
  chatroom_settings: defineTable({
    userId: v.string(), // Better Auth ID
    defaultModel: v.optional(v.string()),
    titleModel: v.optional(v.string()),
    enableChainOfThought: v.optional(v.boolean()),
    builtinToolSets: v.array(v.string()),
    mcpServers: v.array(v.id("mcp_servers")),
  }).index("by_userId", ["userId"]),
  aisdk_chats: defineTable({
    userId: v.string(), // Better Auth ID
    balance: v.id("balances"),
    messages: v.array(messageSchema),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())), // Used only on home page
    chat_completions: v.array(v.id("chat_completions")),
    title: v.optional(v.string()),
    emoji: v.optional(v.string()),
    pinnedAt: v.optional(v.number()),
    activeStream: v.optional(v.boolean()),
    lastInteractionAt: v.optional(v.number()),
    /**
     * Per-chat tool override. When absent, the chat resolves tools from the
     * user's {@link chatroom_settings}.
     */
    tools: v.optional(
      v.object({
        builtinToolSets: v.array(v.string()),
        mcpServers: v.array(v.id("mcp_servers")),
      }),
    ),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_lastInteractionAt", ["userId", "lastInteractionAt"]),
});
