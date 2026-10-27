import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { publicKey as workerPublicKey } from "worker-component";
import { completionPricingSchema, completionUsageSchema } from "../src/usage/completion";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import { workerChatCallFields, workerTaskFields } from "../src/worker/task-contract";
import { chatWorkerSelectionValidator, chatWorkerToolValidator } from "../src/worker/chat-config";
import { projectFolderValidator } from "../src/projects/validators";
import {
  legacyTelemetrySpanKindSchema,
  legacyTelemetryStatusSchema,
  telemetryAttemptSchema,
  telemetryBlobKindSchema,
  telemetryBlobMetaSchema,
  telemetryChangesSchema,
  telemetryDestinationKindSchema,
  telemetryLineageSchema,
  telemetryRequestStatusSchema,
  telemetrySettingsSchema,
  telemetrySourceSchema,
  telemetryUsageSchema,
} from "../src/telemetry/validators";
import {
  providerModelValidator,
  providerNpmValidator,
  providerSnapshotValidator,
} from "../src/workspaces/provider";
import {
  cooldownReasonValidator,
  providerRoutingValidator,
  routingSettingsValidator,
} from "../src/routing/settings";
import {
  alertStateValidator,
  credentialBudgetValidator,
  limitSettingsValidator,
  meterValidator,
} from "../src/limits/meters";
import { limitEventKindValidator } from "../src/limits/events";

export default defineSchema({
  /** Ephemeral Worker handoff status, with optional correlation to durable chat history. */
  worker_tasks: defineTable(workerTaskFields)
    .index("by_worker_request", ["workspace", "workerId", "requestId"])
    .index("by_worker_status", ["workspace", "workerId", "status", "operation"])
    .index("by_status_terminalAt", ["status", "terminalAt"]),
  /** Durable chat tool-call idempotency and output receipts; internal-only access. */
  worker_chat_calls: defineTable(workerChatCallFields)
    .index("by_chat_call_stage", ["chatId", "toolCallId", "stage"])
    .index("by_task", ["taskId"]),
  /** App authorization scope for a component-owned enrollment receipt; no setup secret. */
  worker_enrollments: defineTable({
    workspace: v.id("workspaces"),
    componentEnrollmentId: v.string(),
  }).index("by_workspace", ["workspace"]),
  /**
   * Last heartbeat and reported temp directory per Worker identity, written only by the Worker's
   * machine-authorized `workers.reportPresence`. Advisory: online state never authorizes dispatch.
   */
  worker_presence: defineTable({
    workspace: v.id("workspaces"),
    workerId: v.string(),
    lastSeenAt: v.number(),
    /** Absolute Worker-local temp directory used for chats without a Project folder. */
    tempDirectory: v.optional(v.string()),
  }).index("by_workspace_and_workerId", ["workspace", "workerId"]),
  /** Immutable one-use proof contexts, removed transactionally on admission. */
  worker_auth_challenges: defineTable({
    kind: v.union(v.literal("enroll"), v.literal("recover"), v.literal("token")),
    workspace: v.id("workspaces"),
    enrollmentId: v.optional(v.id("worker_enrollments")),
    requestId: v.optional(v.string()),
    workerId: v.optional(v.string()),
    keyId: v.optional(v.string()),
    identityEpoch: v.optional(v.number()),
    publicKey: workerPublicKey,
    expiresAt: v.number(),
  }).index("by_expiry", ["expiresAt"]),
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
    icon: v.optional(v.string()),
    /** Tile color name from `src/workspaces/colors.ts`; unknown names resolve to the default. */
    color: v.optional(v.string()),
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
    /** Owner routing overrides (priority, weight, cooling, error rules); absent means defaults. */
    routing: v.optional(providerRoutingValidator),
  })
    .index("by_workspace", ["workspace"])
    .index("by_workspace_and_provider", ["workspace", "provider"]),
  /**
   * Non-secret metadata for one credential (API key set or OAuth account) of a workspace provider.
   * A provider may hold several; each value set is encrypted in Secret Store under the
   * workspace provider namespace.
   */
  workspace_credentials: defineTable({
    workspace: v.id("workspaces"),
    provider: v.string(),
    preview: v.record(v.string(), v.string()),
    /** Owner-chosen name; absent means a name derived from the preview. */
    label: v.optional(v.string()),
    /** Disabled credentials are kept but never routed; absent means enabled. */
    enabled: v.optional(v.boolean()),
    /**
     * Secret Store name inside the provider namespace. Absent for credentials created before
     * pools (and by the legacy migration), whose secret is named after the provider slug.
     */
    secretName: v.optional(v.string()),
    /**
     * Upstream account identity reported by an OAuth flow (for example a ChatGPT account ID), used
     * to recognise reconnects of the same account; not a secret.
     */
    account: v.optional(v.string()),
    /**
     * Tier inside the provider: higher is tried first, lower serves only when every higher
     * credential is blocked. Absent means 0.
     */
    priority: v.optional(v.number()),
    /** Share inside the provider for `weighted-round-robin`; 0 excludes it. Absent means 1. */
    weight: v.optional(v.number()),
    /** Owner budget metered from Radium's own completions; absent means none. */
    budget: v.optional(credentialBudgetValidator),
    /**
     * Masked preview of the adapter-declared limit key (OpenRouter management key), stored in
     * Secret Store next to the credential; absent when none is set.
     */
    limitKeyPreview: v.optional(v.string()),
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
    /** Worker tools preselected when a Worker is picked for a new chat; absent means none. */
    workerTools: v.optional(v.array(chatWorkerToolValidator)),
    /** Gateway routing strategy, session affinity, retry, and cooldown; absent means defaults. */
    routing: v.optional(routingSettingsValidator),
    /** Usage-limit alert thresholds; absent means defaults. */
    limits: v.optional(limitSettingsValidator),
  }).index("by_workspace", ["workspace"]),
  /**
   * Folder-like grouping of chats inside a workspace. Deleting a Project detaches its chats;
   * chat privacy is still decided per chat. `folders` (one per Worker) and `defaultWorkerId`
   * (one of `folders`) are owner-set and pick the Worker working directory for its chats.
   */
  projects: defineTable({
    workspace: v.id("workspaces"),
    userId: v.string(), // Better Auth ID of the creator
    name: v.string(),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    folders: v.optional(v.array(projectFolderValidator)),
    defaultWorkerId: v.optional(v.string()),
  }).index("by_workspace", ["workspace"]),
  /** Per-user (not per-workspace) interface preferences keyed by Better Auth user ID. */
  user_preferences: defineTable({
    userId: v.string(),
    pinnedModels: v.array(v.string()),
    hiddenModels: v.array(v.string()),
  }).index("by_userId", ["userId"]),
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
      /** Provider credential that served the completion; absent for legacy credentials and older rows. */
      credential: v.optional(v.id("workspace_credentials")),
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
    .index("by_workspace", ["bill.workspace"])
    .index("by_credential", ["request.credential"]),
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
  /**
   * Credential-wide (model `""`) or credential+model exclusion after upstream failures. Rows
   * without `credential` belong to a provider's legacy, not yet migrated credential (or predate
   * credential pools). Expired rows keep `backoffLevel` until a success clears them or the prune
   * cron removes them.
   */
  routing_cooldowns: defineTable({
    workspace: v.id("workspaces"),
    provider: v.string(),
    credential: v.optional(v.id("workspace_credentials")),
    model: v.string(),
    reason: cooldownReasonValidator,
    nextRetryAt: v.number(),
    backoffLevel: v.number(),
    status: v.optional(v.number()),
    /** Bounded upstream error message; never prompt or response content. */
    message: v.optional(v.string()),
    /** Successes dispatched before this time cannot clear the cooldown. */
    recordedAt: v.number(),
  })
    .index("by_workspace_provider_credential_model", [
      "workspace",
      "provider",
      "credential",
      "model",
    ])
    .index("by_nextRetryAt", ["nextRetryAt"]),
  /**
   * Usage-limit snapshot of one pooled credential: meters from response headers, error bodies,
   * polls, and its metered budget; poll scheduling; and the alert state behind `limit_events`.
   * Removed with the credential.
   */
  credential_limits: defineTable({
    workspace: v.id("workspaces"),
    provider: v.string(),
    credential: v.id("workspace_credentials"),
    meters: v.array(meterValidator),
    /** Upstream plan, e.g. ChatGPT `plan_type`. */
    plan: v.optional(v.string()),
    /** Last write of the snapshot; drives write throttling. */
    updatedAt: v.number(),
    /** Last meters from real traffic (headers or error bodies); fresh data defers polls. */
    passiveAt: v.optional(v.number()),
    /** Last successful poll. */
    polledAt: v.optional(v.number()),
    /** Last poll attempt (scheduled or owner refresh). */
    pollAttemptAt: v.optional(v.number()),
    /** Next scheduled poll; absent when the provider has no pollable adapter. */
    nextPollAt: v.optional(v.number()),
    pollError: v.optional(
      v.object({ message: v.string(), status: v.optional(v.number()), at: v.number() }),
    ),
    /** Consecutive failed polls; drives backoff and one `poll_failed` per streak. */
    pollFailures: v.optional(v.number()),
    /** Highest alert fired per meter since it last re-armed. */
    alerts: v.array(alertStateValidator),
    /** Set when `credential_expired` fired; cleared (with `credential_restored`) by a success. */
    expiredAt: v.optional(v.number()),
    /** Budget period end; the poll cron recomputes the budget meter once it passes. */
    budgetResetsAt: v.optional(v.number()),
    /** A budget recompute is scheduled; coalesces completions. */
    budgetPendingAt: v.optional(v.number()),
  })
    .index("by_credential", ["credential"])
    .index("by_workspace", ["workspace"])
    .index("by_nextPollAt", ["nextPollAt"])
    .index("by_budgetResetsAt", ["budgetResetsAt"]),
  /**
   * Usage-limit and credential-health events, each with its complete payload (meter before and
   * after, the credential's snapshot, provider and credential identity) for later delivery
   * channels. Kept 30 days; credential names are captured so events outlive their credential.
   */
  limit_events: defineTable({
    workspace: v.id("workspaces"),
    kind: limitEventKindValidator,
    provider: v.string(),
    providerName: v.string(),
    credential: v.optional(v.id("workspace_credentials")),
    credentialName: v.string(),
    meter: v.optional(meterValidator),
    previous: v.optional(meterValidator),
    threshold: v.optional(v.number()),
    /** Upstream HTTP status for credential and poll events. */
    status: v.optional(v.number()),
    message: v.string(),
    snapshot: v.object({ meters: v.array(meterValidator), plan: v.optional(v.string()) }),
    settings: limitSettingsValidator,
    occurredAt: v.number(),
  })
    .index("by_workspace_and_occurredAt", ["workspace", "occurredAt"])
    .index("by_occurredAt", ["occurredAt"]),
  /**
   * Session-affinity binding from a session key (`<session>::<model>`) to a provider credential.
   * `credential` is absent for a legacy credential or a binding made before credential pools; such
   * bindings keep the provider and let the strategy choose the credential.
   */
  routing_sessions: defineTable({
    workspace: v.id("workspaces"),
    key: v.string(),
    provider: v.string(),
    credential: v.optional(v.id("workspace_credentials")),
    expiresAt: v.number(),
  })
    .index("by_workspace_key", ["workspace", "key"])
    .index("by_expiresAt", ["expiresAt"]),
  /**
   * Round-robin and smooth weighted round-robin cursor per workspace and model, plus per-provider
   * credential rotation state.
   */
  routing_cursors: defineTable({
    workspace: v.id("workspaces"),
    model: v.string(),
    lastProvider: v.optional(v.string()),
    weighted: v.array(v.object({ provider: v.string(), current: v.number(), weight: v.number() })),
    /**
     * Credential rotation per provider. Credentials are keyed by ID, with `""` for the provider's
     * legacy credential: `last` is the last round-robin pick, `credits` the smooth weighted
     * round-robin state.
     */
    credentialCursors: v.optional(
      v.array(
        v.object({
          provider: v.string(),
          last: v.optional(v.string()),
          credits: v.array(v.object({ key: v.string(), current: v.number(), weight: v.number() })),
        }),
      ),
    ),
  }).index("by_workspace_model", ["workspace", "model"]),
  authors: defineTable({
    name: v.string(),
    slug: v.string(),
  }),
  // Chatroom
  /**
   * Workspace MCP (Model Context Protocol) server metadata, retaining user attribution
   * for legacy records until backfill completes. Secrets (e.g. the
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
   * Legacy per-user Chatroom defaults retained for migration and fallback reads.
   * New configuration writes belong to workspace_settings.
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
     * Per-chat tool override. When absent, the chat inherits workspace defaults,
     * including the legacy settings fallback during migration.
     */
    tools: v.optional(
      v.object({
        builtinToolSets: v.array(v.string()),
        mcpServers: v.array(v.id("mcp_servers")),
      }),
    ),
    /**
     * Owner-selected Worker tools, optional Worker, and server-derived directory (Project folder,
     * else the Worker's temp directory); dispatch rechecks authority.
     */
    worker: v.optional(chatWorkerSelectionValidator),
    /** Optional Project grouping in the same workspace; never grants visibility. */
    project: v.optional(v.id("projects")),
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
    ])
    .index("by_workspace_and_userId_and_project_and_lastInteractionAt", [
      "workspace",
      "userId",
      "project",
      "lastInteractionAt",
    ])
    .index("by_workspace_and_scope_and_project_and_lastInteractionAt", [
      "workspace",
      "scope",
      "project",
      "lastInteractionAt",
    ])
    .index("by_project_and_lastInteractionAt", ["project", "lastInteractionAt"]),
  /**
   * Content-addressed telemetry content, unique per `(workspace, hash)`. `hash` covers the
   * workspace ID and the RFC 8785 canonical JSON. Content lives inline (`content`) or, above the
   * inline limit, in file storage (`storage`); neither is set when content recording was off.
   */
  telemetry_blobs: defineTable({
    workspace: v.id("workspaces"),
    hash: v.string(),
    kind: telemetryBlobKindSchema,
    /** UTF-8 byte length of the canonical JSON. */
    size: v.number(),
    content: v.optional(v.string()),
    storage: v.optional(v.id("_storage")),
    meta: v.optional(telemetryBlobMetaSchema),
    /** Set for migrated legacy payloads that were cut at the old 32,000-character limit. */
    truncated: v.optional(v.boolean()),
  }).index("by_workspace_and_hash", ["workspace", "hash"]),
  /** Ordered tool membership of a `toolset` blob, written once per new toolset. */
  telemetry_toolset_tools: defineTable({
    workspace: v.id("workspaces"),
    toolset: v.id("telemetry_blobs"),
    tool: v.id("telemetry_blobs"),
    position: v.number(),
  })
    .index("by_toolset_and_position", ["toolset", "position"])
    .index("by_tool", ["tool"]),
  /**
   * Immutable conversation tree. A node is one message at one position; `hash` chains the
   * parent hash and message blob hash, so shared prefixes are stored once and rollbacks add
   * siblings instead of replacing history.
   */
  telemetry_nodes: defineTable({
    workspace: v.id("workspaces"),
    hash: v.string(),
    parent: v.optional(v.id("telemetry_nodes")),
    blob: v.id("telemetry_blobs"),
    /** 1-based message count from the root. */
    depth: v.number(),
    /** Who first produced this message: the client (`input`) or the model (`output`). */
    origin: v.union(v.literal("input"), v.literal("output")),
  })
    .index("by_workspace_and_hash", ["workspace", "hash"])
    .index("by_parent", ["parent"])
    .index("by_blob", ["blob"]),
  /** A conversation or agent run grouped by the routing session key. */
  telemetry_sessions: defineTable({
    workspace: v.id("workspaces"),
    key: v.string(),
    /** Parent session key for subagents (`x-parent-session-id`). */
    parentKey: v.optional(v.string()),
    chatId: v.optional(v.id("aisdk_chats")),
    startedAt: v.number(),
  })
    .index("by_workspace_and_key", ["workspace", "key"])
    .index("by_workspace_and_startedAt", ["workspace", "startedAt"])
    .index("by_workspace_and_parentKey", ["workspace", "parentKey"]),
  /** One captured Gateway request: pointers into blobs/nodes plus routing, timing, and usage. */
  telemetry_requests: defineTable({
    workspace: v.id("workspaces"),
    /** Gateway request ID; idempotency key for capture. */
    requestId: v.string(),
    source: telemetrySourceSchema,
    apiKey: v.optional(v.id("api_keys")),
    userId: v.optional(v.string()),
    chatId: v.optional(v.id("aisdk_chats")),
    session: v.optional(v.id("telemetry_sessions")),
    /** Model slug requested by the client. */
    model: v.string(),
    /** Final provider and credential (the committed attempt, or the last failed one). */
    provider: v.optional(v.string()),
    credential: v.optional(v.id("workspace_credentials")),
    stream: v.boolean(),
    status: telemetryRequestStatusSchema,
    startedAt: v.number(),
    endedAt: v.number(),
    durationMs: v.number(),
    ttftMs: v.optional(v.number()),
    generationMs: v.optional(v.number()),
    finishReason: v.optional(v.string()),
    usage: v.optional(telemetryUsageSchema),
    /** Upstream response ID, for matching provider logs. */
    providerGenerationId: v.optional(v.string()),
    chatCompletion: v.optional(v.id("chat_completions")),
    error: v.optional(v.object({ message: v.string(), status: v.optional(v.number()) })),
    canceled: v.optional(v.boolean()),
    attempts: v.array(telemetryAttemptSchema),
    /** Last client message node; absent when the request had no non-system messages. */
    input: v.optional(v.id("telemetry_nodes")),
    /** Model output node, a child of `input`. */
    output: v.optional(v.id("telemetry_nodes")),
    /** Leading system/developer messages, stored apart from the conversation chain. */
    system: v.optional(v.id("telemetry_blobs")),
    toolset: v.optional(v.id("telemetry_blobs")),
    /** Raw request body without `messages` and `tools`: model, sampling, flags, metadata. */
    params: v.optional(v.id("telemetry_blobs")),
    /** Allowlisted client headers; never credentials. */
    headers: v.optional(v.id("telemetry_blobs")),
    recordsInputs: v.boolean(),
    recordsOutputs: v.boolean(),
    lineage: telemetryLineageSchema,
    changes: v.optional(telemetryChangesSchema),
    /** Rows migrated from the old AI SDK traces; payloads are opaque `legacy` blobs. */
    legacy: v.optional(
      v.object({
        traceId: v.string(),
        input: v.optional(v.id("telemetry_blobs")),
        output: v.optional(v.id("telemetry_blobs")),
        spans: v.optional(v.id("telemetry_blobs")),
      }),
    ),
  })
    .index("by_workspace_and_startedAt", ["workspace", "startedAt"])
    .index("by_workspace_and_requestId", ["workspace", "requestId"])
    .index("by_session_and_startedAt", ["session", "startedAt"])
    .index("by_chat_and_startedAt", ["chatId", "startedAt"])
    .index("by_input", ["input"])
    .index("by_output", ["output"])
    .index("by_system", ["system"])
    .index("by_toolset", ["toolset"])
    .index("by_params", ["params"])
    .index("by_headers", ["headers"])
    .index("by_legacy_input", ["legacy.input"])
    .index("by_legacy_output", ["legacy.output"])
    .index("by_legacy_spans", ["legacy.spans"]),
  /** Pending reference checks for blobs/nodes whose last known referrer was deleted. */
  telemetry_gc: defineTable({
    workspace: v.id("workspaces"),
    blob: v.optional(v.id("telemetry_blobs")),
    node: v.optional(v.id("telemetry_nodes")),
  }),
  /** Workspace export destinations; header secrets live in Secret Store under `secretName`. */
  telemetry_destinations: defineTable({
    workspace: v.id("workspaces"),
    kind: telemetryDestinationKindSchema,
    name: v.string(),
    endpoint: v.string(),
    secretName: v.optional(v.string()),
    enabled: v.boolean(),
    /** Strip messages, system instructions, tool definitions, and output from exports. */
    privacyMode: v.boolean(),
    /** 0..1; decided per session key so whole sessions are kept or dropped together. */
    samplingRate: v.number(),
    includeApiKeys: v.array(v.id("api_keys")),
    excludeApiKeys: v.array(v.id("api_keys")),
    lastDeliveryAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  }).index("by_workspace", ["workspace"]),
  /** Deprecated: AI SDK traces. Read only by `migrations:telemetryTracesToRequests`. */
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
    status: legacyTelemetryStatusSchema,
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
  /** Deprecated: AI SDK spans. Read only by `migrations:telemetryTracesToRequests`. */
  telemetry_spans: defineTable({
    trace: v.id("telemetry_traces"),
    /** Deprecated attribution pointer retained for historical spans. */
    balance: v.optional(v.id("balances")),
    workspace: v.optional(v.id("workspaces")),
    kind: legacyTelemetrySpanKindSchema,
    name: v.string(),
    status: legacyTelemetryStatusSchema,
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
  /** Deprecated: AI SDK payloads. Read only by `migrations:telemetryTracesToRequests`. */
  telemetry_payloads: defineTable({
    trace: v.id("telemetry_traces"),
    span: v.optional(v.id("telemetry_spans")),
    inputJson: v.optional(v.string()),
    outputJson: v.optional(v.string()),
  }).index("by_trace", ["trace"]),
});
