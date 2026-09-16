import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { completionPricingSchema, completionUsageSchema } from "./key";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import {
  telemetrySettingsSchema,
  telemetrySourceSchema,
  telemetrySpanKindSchema,
  telemetryStatusSchema,
  telemetryUsageSchema,
} from "../src/utils/telemetry/validators";
import {
  providerModelValidator,
  providerNpmValidator,
  providerSnapshotValidator,
} from "../src/utils/workspaces/provider";

export default defineSchema({
  /**
   * A workspace is the ownership and credential boundary for Gateway resources.
   * Ownership is currently personal-user only. Explicit members are represented
   * separately below; Better Auth organization ownership and organization-derived
   * membership remain future work.
   */
  workspaces: defineTable({
    ownerType: v.literal("user"),
    ownerId: v.string(), // Better Auth user ID
    name: v.string(),
    archivedAt: v.optional(v.number()),
    /** Transitional mapping retained until the legacy tables are retired. */
    legacyBalance: v.optional(v.id("balances")),
    legacyOrganizationId: v.optional(v.string()),
    legacyTeamId: v.optional(v.string()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_legacyBalance", ["legacyBalance"]),
  /**
   * Explicit workspace access is independent of Better Auth organizations.
   * Organization ownership and organization-derived membership remain planned.
   */
  workspace_members: defineTable({
    workspace: v.id("workspaces"),
    userId: v.string(), // Better Auth user ID
    role: v.literal("member"),
  })
    .index("by_workspace_and_userId", ["workspace", "userId"])
    .index("by_userId", ["userId"])
    .index("by_workspace", ["workspace"]),
  /** Workspace-owned provider enablement/configuration; provider catalogue rows remain global. */
  workspace_configurations: defineTable({
    workspace: v.id("workspaces"),
    provider: v.string(),
    enabled: v.boolean(),
    active: v.boolean(),
    /** Workspace-owned endpoint and model mapping; absent only before backfill. */
    snapshot: v.optional(providerSnapshotValidator),
    /** Explicit deletion/disable tombstone that blocks legacy resurrection. */
    deletedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspace"])
    .index("by_workspace_and_provider", ["workspace", "provider"]),
  /** Non-secret credential metadata. Values are encrypted in Secret Store. */
  workspace_credentials: defineTable({
    workspace: v.id("workspaces"),
    provider: v.string(),
    preview: v.record(v.string(), v.string()),
  }).index("by_workspace_and_provider", ["workspace", "provider"]),
  /** Gateway API keys are workspace-scoped and store only a hash and preview. */
  api_keys: defineTable({
    workspace: v.id("workspaces"),
    name: v.string(),
    hash: v.string(),
    /** Masked, non-secret display value (e.g. `rad-sk-…aB12`). */
    preview: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
    /** Transitional source mapping; the legacy `keys` row is not deleted here. */
    legacyKey: v.optional(v.id("keys")),
  })
    .index("by_hash", ["hash"])
    .index("by_workspace", ["workspace"])
    .index("by_legacyKey", ["legacyKey"]),
  /**
   * Workspace defaults replace the old per-user settings for new code. The old
   * chatroom_settings table stays readable during the migration window.
   */
  workspace_settings: defineTable({
    workspace: v.id("workspaces"),
    defaultModel: v.optional(v.string()),
    titleModel: v.optional(v.string()),
    enableChainOfThought: v.optional(v.boolean()),
    telemetry: v.optional(telemetrySettingsSchema),
    builtinToolSets: v.array(v.string()),
    mcpServers: v.array(v.id("mcp_servers")),
  }).index("by_workspace", ["workspace"]),
  /**
   * Legacy balance ownership remains in the widened schema. It is read only by
   * migration/rollback compatibility paths and is not used for credits.
   */
  balances: defineTable({
    credits: v.number(),
    userId: v.string(), // Better Auth ID
    organizationId: v.optional(v.string()),
    teamId: v.optional(v.string()),
  }).index("by_userId", ["userId"]),
  keys: defineTable({
    balance: v.id("balances"),
    creditLimit: v.optional(v.number()),
    usedCredits: v.number(),
    name: v.string(),
    hash: v.string(),
    revokedAt: v.optional(v.number()),
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
    /**
     * Optional privacy attribution for Chatroom-generated completions. Planned
     * encryption and optional explicitly disclosed-owner auditing are not
     * implemented here, and neither can bypass workspace authorization.
     */
    chatId: v.optional(v.id("aisdk_chats")),
    userId: v.optional(v.string()),
    bill: v.object({
      /** Deprecated ownership pointer retained for historical records. */
      balance: v.optional(v.id("balances")),
      key: v.optional(v.id("keys")),
      workspace: v.optional(v.id("workspaces")),
      apiKey: v.optional(v.id("api_keys")),
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
  })
    .index("by_balance", ["bill.balance"])
    .index("by_workspace", ["bill.workspace"]),
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
    npm: providerNpmValidator,
    env: v.array(v.string()),
    catalogue_provider: v.optional(v.string()),
    credential_type: v.optional(v.union(v.literal("api_key"), v.literal("oauth"))),
    oauth_flow: v.optional(v.string()),
    doc: v.optional(v.string()),
    api: v.optional(v.string()),
    enabled: v.boolean(),
    models: v.array(providerModelValidator),
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
    /** Workspace ownership is optional until the resource backfill completes. */
    workspace: v.optional(v.id("workspaces")),
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
  })
    .index("by_userId", ["userId"])
    .index("by_workspace", ["workspace"]),
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
    telemetry: v.optional(telemetrySettingsSchema),
    builtinToolSets: v.array(v.string()),
    mcpServers: v.array(v.id("mcp_servers")),
  }).index("by_userId", ["userId"]),
  aisdk_chats: defineTable({
    userId: v.string(), // Better Auth ID
    /** Deprecated routing pointer retained until ownership backfill completes. */
    balance: v.optional(v.id("balances")),
    workspace: v.optional(v.id("workspaces")),
    scope: v.optional(v.union(v.literal("personal"), v.literal("workspace"))),
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
    .index("by_userId_and_lastInteractionAt", ["userId", "lastInteractionAt"])
    .index("by_balance", ["balance"])
    .index("by_workspace", ["workspace"])
    .index("by_workspace_and_lastInteractionAt", ["workspace", "lastInteractionAt"])
    .index("by_balance_and_lastInteractionAt", ["balance", "lastInteractionAt"])
    .index("by_workspace_and_scope_and_lastInteractionAt", [
      "workspace",
      "scope",
      "lastInteractionAt",
    ])
    .index("by_workspace_and_userId_and_lastInteractionAt", [
      "workspace",
      "userId",
      "lastInteractionAt",
    ]),
  telemetry_traces: defineTable({
    /** Deprecated attribution pointer retained for historical traces. */
    balance: v.optional(v.id("balances")),
    key: v.optional(v.id("keys")),
    workspace: v.optional(v.id("workspaces")),
    apiKey: v.optional(v.id("api_keys")),
    chatCompletionId: v.optional(v.id("chat_completions")),
    userId: v.string(),
    chatId: v.optional(v.id("aisdk_chats")),
    source: telemetrySourceSchema,
    requestId: v.string(),
    callId: v.string(),
    operationId: v.string(),
    functionId: v.string(),
    provider: v.string(),
    model: v.string(),
    status: telemetryStatusSchema,
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    finishReason: v.optional(v.string()),
    usage: v.optional(telemetryUsageSchema),
    stepCount: v.optional(v.number()),
    toolCallCount: v.optional(v.number()),
    error: v.optional(v.string()),
    recordsInputs: v.boolean(),
    recordsOutputs: v.boolean(),
  })
    .index("by_balance_and_startedAt", ["balance", "startedAt"])
    .index("by_balance_and_requestId", ["balance", "requestId"])
    .index("by_workspace_and_startedAt", ["workspace", "startedAt"])
    .index("by_workspace_and_requestId", ["workspace", "requestId"])
    .index("by_chat_and_startedAt", ["chatId", "startedAt"]),
  telemetry_spans: defineTable({
    trace: v.id("telemetry_traces"),
    /** Deprecated attribution pointer retained for historical spans. */
    balance: v.optional(v.id("balances")),
    workspace: v.optional(v.id("workspaces")),
    kind: telemetrySpanKindSchema,
    name: v.string(),
    status: telemetryStatusSchema,
    startedAt: v.number(),
    endedAt: v.number(),
    durationMs: v.number(),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    stepNumber: v.optional(v.number()),
    toolName: v.optional(v.string()),
    toolCallId: v.optional(v.string()),
    finishReason: v.optional(v.string()),
    usage: v.optional(telemetryUsageSchema),
    error: v.optional(v.string()),
  })
    .index("by_trace_and_startedAt", ["trace", "startedAt"])
    .index("by_balance_and_startedAt", ["balance", "startedAt"])
    .index("by_workspace_and_startedAt", ["workspace", "startedAt"]),
  telemetry_payloads: defineTable({
    trace: v.id("telemetry_traces"),
    span: v.optional(v.id("telemetry_spans")),
    inputJson: v.optional(v.string()),
    outputJson: v.optional(v.string()),
  }).index("by_trace", ["trace"]),
});
