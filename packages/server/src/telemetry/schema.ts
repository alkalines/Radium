import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  TelemetryAttempt,
  TelemetryBlobMeta,
  TelemetryChanges,
  TelemetryLineage,
  TelemetryUsage,
} from "contracts/telemetry/validators";
import {
  telemetryBlobKindSchema,
  telemetryDestinationKindSchema,
  telemetryRequestStatusSchema,
  telemetrySourceSchema,
} from "contracts/telemetry/validators";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import { user } from "../auth/schema";
import { bytes, checkIn, createdAt, id, instant, json, literals } from "../db/columns";
import { chats } from "../chatroom/schema";
import { apiKeys, workspaceCredentials } from "../gateway/schema";
import { chatCompletions } from "../usage/schema";
import { workspaces } from "../workspaces/schema";

const BLOB_KINDS = literals(telemetryBlobKindSchema);
const SOURCES = literals(telemetrySourceSchema);
const REQUEST_STATUSES = literals(telemetryRequestStatusSchema);
const DESTINATION_KINDS = literals(telemetryDestinationKindSchema);
/** Who first produced a message: the client (`input`) or the model (`output`). */
const NODE_ORIGINS = ["input", "output"] as const;

// Telemetry is content-addressed and referenced from several rows. Edges between its tables are
// `no action`: a delete of a still-referenced blob or node fails (garbage collection only deletes
// what nothing references, so the constraint is its safety net), and, unlike `restrict`, the
// check runs at the end of the statement, so deleting a workspace can remove all of them at once.

/**
 * Content-addressed telemetry content, unique per `(workspace, hash)`. `hash` covers the
 * workspace id and the RFC 8785 canonical JSON. New content is sealed to the workspace owner key
 * (`sealed_*`; the envelope is inline or, above the inline limit, in the object store at
 * `storage_key`). `content` is historical plaintext; none of them is set when content recording
 * was off.
 */
export const telemetryBlobs = pgTable(
  "telemetry_blobs",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    kind: text("kind", { enum: BLOB_KINDS }).notNull(),
    /** UTF-8 byte length of the canonical JSON, also when the content is not stored. */
    size: bigint("size", { mode: "number" }).notNull(),
    /** Plaintext content stored inline. */
    content: text("content"),
    /** Object-store key (`files/<storageId>`) of a sealed envelope or plaintext content. */
    storageKey: text("storage_key"),
    /** Non-content facts kept even when content recording is off. */
    meta: json<TelemetryBlobMeta>("meta"),
    /** Owner-key sealing: epoch, originating request and capsule are set together. */
    sealedEpoch: integer("sealed_epoch"),
    /** The capturing request's id; carried so deduplicated content outlives that request. */
    sealedRequestId: text("sealed_request_id"),
    sealedCapsule: bytes("sealed_capsule"),
    sealedEnvelope: bytes("sealed_envelope"),
    /** Set for migrated legacy payloads that were cut at the old 32,000-character limit. */
    truncated: boolean("truncated").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("telemetry_blobs_kind", table.kind, BLOB_KINDS),
    check("telemetry_blobs_size", sql`${table.size} >= 0`),
    check(
      "telemetry_blobs_sealed",
      sql`num_nonnulls(${table.sealedEpoch}, ${table.sealedRequestId}, ${table.sealedCapsule}) in (0, 3)`,
    ),
    check(
      "telemetry_blobs_sealed_envelope",
      sql`${table.sealedEnvelope} is null or (${table.sealedEpoch} is not null and ${table.storageKey} is null)`,
    ),
    // Plaintext content is one source: never beside an object, a sealed box or a legacy sidecar.
    check(
      "telemetry_blobs_content_source",
      sql`${table.content} is null or num_nonnulls(${table.storageKey}, ${table.sealedEpoch}, ${table.legacyContent}) = 0`,
    ),
    // Capture's upsert and the hash lookup of every ingest batch (telemetry ingestBlobs).
    uniqueIndex("telemetry_blobs_workspace_hash").on(table.workspace, table.hash),
  ],
);

/** Ordered tool membership of a `toolset` blob, written once per new toolset. */
export const telemetryToolsetTools = pgTable(
  "telemetry_toolset_tools",
  {
    id: id(),
    // Garbage collection reads the members before deleting the toolset blob, then checks each tool.
    toolset: text("toolset")
      .notNull()
      .references(() => telemetryBlobs.id, { onDelete: "cascade" }),
    tool: text("tool")
      .notNull()
      .references(() => telemetryBlobs.id, { onDelete: "no action" }),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("telemetry_toolset_tools_position", sql`${table.position} >= 0`),
    // A toolset's tools in order (telemetry store, toolset load); also the cascade from the blob.
    uniqueIndex("telemetry_toolset_tools_toolset_position").on(table.toolset, table.position),
    // Is a tool blob still in a toolset (telemetry GC); also the `no action` check on tool delete.
    index("telemetry_toolset_tools_tool").on(table.tool),
  ],
);

/**
 * Immutable conversation tree. A node is one message at one position; `hash` chains the parent
 * hash and message blob hash, so shared prefixes are stored once and rollbacks add siblings
 * instead of replacing history.
 */
export const telemetryNodes = pgTable(
  "telemetry_nodes",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    parent: text("parent").references((): AnyPgColumn => telemetryNodes.id, {
      onDelete: "no action",
    }),
    blob: text("blob")
      .notNull()
      .references(() => telemetryBlobs.id, { onDelete: "no action" }),
    /** 1-based message count from the root. */
    depth: integer("depth").notNull(),
    origin: text("origin", { enum: NODE_ORIGINS }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("telemetry_nodes_origin", table.origin, NODE_ORIGINS),
    // A root has depth 1, every other node is one deeper than its parent (set by ingest).
    check("telemetry_nodes_depth", sql`(${table.parent} is null) = (${table.depth} = 1)`),
    // Capture's lookup of the deepest stored prefix and its idempotent insert.
    uniqueIndex("telemetry_nodes_workspace_hash").on(table.workspace, table.hash),
    // Does a node have children (ingest `forked`, telemetry GC); also the `no action` check on
    // the parent's delete.
    index("telemetry_nodes_parent")
      .on(table.parent)
      .where(sql`${table.parent} is not null`),
    // Is a message blob still used by a node (telemetry GC).
    index("telemetry_nodes_blob").on(table.blob),
  ],
);

/**
 * A conversation or agent run grouped by the routing session key. A Chatroom session
 * (`source = 'chatroom'`) belongs to a chat; when the chat is deleted `chat` becomes null and the
 * session stays hidden from owner views, so it must never be read as a Gateway session.
 */
export const telemetrySessions = pgTable(
  "telemetry_sessions",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Parent session key for subagents (`x-parent-session-id`). A key, not a reference. */
    parentKey: text("parent_key"),
    chat: text("chat").references(() => chats.id, { onDelete: "set null" }),
    /** `chatroom` iff the session was created for a chat; see {@link telemetryRequests.source}. */
    source: text("source", { enum: SOURCES }).notNull(),
    startedAt: instant("started_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("telemetry_sessions_source", table.source, SOURCES),
    check(
      "telemetry_sessions_gateway_no_chat",
      sql`${table.source} <> 'gateway' or ${table.chat} is null`,
    ),
    // Capture's find-or-create by routing session key, and a session's parent lookup
    // (telemetry.getSession). Keys are per workspace, never merged across workspaces.
    uniqueIndex("telemetry_sessions_workspace_key").on(table.workspace, table.key),
    // Owner listing newest first and retention of past-cutoff sessions
    // (telemetry.listSessions, telemetryRetention.pruneExpired).
    index("telemetry_sessions_workspace_started").on(table.workspace, table.startedAt),
    // A session's subagent sessions (telemetry.getSession).
    index("telemetry_sessions_workspace_parent_key")
      .on(table.workspace, table.parentKey)
      .where(sql`${table.parentKey} is not null`),
    // The `set null` when a chat is deleted.
    index("telemetry_sessions_chat")
      .on(table.chat)
      .where(sql`${table.chat} is not null`),
  ],
);

/**
 * One captured Gateway request: pointers into blobs and nodes plus routing, timing and usage.
 * Owner reads hide a request whose chat is private to someone else, and a `chatroom` request
 * whose chat is gone (`chat` set null when the chat is deleted); only `gateway` requests are
 * visible without a chat.
 */
export const telemetryRequests = pgTable(
  "telemetry_requests",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Gateway request id; idempotency key for capture. */
    requestId: text("request_id").notNull(),
    /** `chatroom` iff the request came with a chat; a `gateway` request never has one. */
    source: text("source", { enum: SOURCES }).notNull(),
    // API keys are revoked, never deleted.
    apiKey: text("api_key").references(() => apiKeys.id, { onDelete: "no action" }),
    userId: text("user_id").references(() => user.id, { onDelete: "restrict" }),
    /** Null on a Gateway request, and once the chat is deleted (the request then stays hidden). */
    chat: text("chat").references(() => chats.id, { onDelete: "set null" }),
    // A session is deleted only once none of its requests remain.
    session: text("session").references(() => telemetrySessions.id, { onDelete: "no action" }),
    /** Model slug requested by the client. */
    model: text("model").notNull(),
    /** Final provider and credential (the committed attempt, or the last failed one). */
    provider: text("provider"),
    credential: text("credential").references(() => workspaceCredentials.id, {
      onDelete: "set null",
    }),
    stream: boolean("stream").notNull(),
    status: text("status", { enum: REQUEST_STATUSES }).notNull(),
    startedAt: instant("started_at").notNull(),
    endedAt: instant("ended_at").notNull(),
    /** ms. */
    durationMs: doublePrecision("duration_ms").notNull(),
    ttftMs: doublePrecision("ttft_ms"),
    generationMs: doublePrecision("generation_ms"),
    finishReason: text("finish_reason"),
    usage: json<TelemetryUsage>("usage"),
    requestedServiceTier: text("requested_service_tier"),
    servedServiceTier: text("served_service_tier"),
    estimatedCost: doublePrecision("estimated_cost"),
    reportedCost: doublePrecision("reported_cost"),
    upstreamInferenceCost: doublePrecision("upstream_inference_cost"),
    /** Upstream response id, for matching provider logs. */
    providerGenerationId: text("provider_generation_id"),
    // Completions are never deleted.
    chatCompletion: text("chat_completion").references(() => chatCompletions.id, {
      onDelete: "no action",
    }),
    /** Historical plaintext error; `status` is set only with a message. */
    errorMessage: text("error_message"),
    errorStatus: integer("error_status"),
    /** The error and attempt messages sealed to the owner key; all four are set together. */
    sealedErrorEpoch: integer("sealed_error_epoch"),
    sealedErrorRequestId: text("sealed_error_request_id"),
    sealedErrorCapsule: bytes("sealed_error_capsule"),
    sealedErrorEnvelope: bytes("sealed_error_envelope"),
    /** Absent means not canceled. */
    canceled: boolean("canceled").notNull().default(false),
    attempts: json<TelemetryAttempt[]>("attempts").notNull(),
    /** Last client message node; null when the request had no non-system messages. */
    input: text("input").references(() => telemetryNodes.id, { onDelete: "no action" }),
    /** Model output node, a child of `input`. */
    output: text("output").references(() => telemetryNodes.id, { onDelete: "no action" }),
    /** Leading system/developer messages, stored apart from the conversation chain. */
    system: text("system").references(() => telemetryBlobs.id, { onDelete: "no action" }),
    toolset: text("toolset").references(() => telemetryBlobs.id, { onDelete: "no action" }),
    /** Raw request body without `messages` and `tools`: model, sampling, flags, metadata. */
    params: text("params").references(() => telemetryBlobs.id, { onDelete: "no action" }),
    /** Allowlisted client headers; never credentials. */
    headers: text("headers").references(() => telemetryBlobs.id, { onDelete: "no action" }),
    recordsInputs: boolean("records_inputs").notNull(),
    recordsOutputs: boolean("records_outputs").notNull(),
    lineage: json<TelemetryLineage>("lineage").notNull(),
    changes: json<TelemetryChanges>("changes"),
    /** Rows migrated from the old AI SDK traces: the trace id and opaque `legacy` blobs. */
    legacyTraceId: text("legacy_trace_id"),
    legacyInput: text("legacy_input").references(() => telemetryBlobs.id, {
      onDelete: "no action",
    }),
    legacyOutput: text("legacy_output").references(() => telemetryBlobs.id, {
      onDelete: "no action",
    }),
    legacySpans: text("legacy_spans").references(() => telemetryBlobs.id, {
      onDelete: "no action",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("telemetry_requests_source", table.source, SOURCES),
    checkIn("telemetry_requests_status", table.status, REQUEST_STATUSES),
    check(
      "telemetry_requests_gateway_no_chat",
      sql`${table.source} <> 'gateway' or ${table.chat} is null`,
    ),
    check(
      "telemetry_requests_error",
      sql`${table.errorStatus} is null or ${table.errorMessage} is not null`,
    ),
    check(
      "telemetry_requests_sealed_error",
      sql`num_nonnulls(${table.sealedErrorEpoch}, ${table.sealedErrorRequestId}, ${table.sealedErrorCapsule}, ${table.sealedErrorEnvelope}) in (0, 4)`,
    ),
    check(
      "telemetry_requests_legacy",
      sql`${table.legacyTraceId} is not null or num_nonnulls(${table.legacyInput}, ${table.legacyOutput}, ${table.legacySpans}) = 0`,
    ),
    // Capture idempotency: one row per Gateway request (telemetry finishRequest).
    uniqueIndex("telemetry_requests_workspace_request").on(table.workspace, table.requestId),
    // Owner request list, summary window and retention cutoff, newest first
    // (telemetry.listRequests, telemetry.getSummary, telemetryRetention.pruneExpired).
    index("telemetry_requests_workspace_started").on(table.workspace, table.startedAt),
    // A session's timeline, previous request and deletion pages (telemetry.listRequests,
    // telemetry.getSession, ingest lineage); also the `no action` check on session delete.
    index("telemetry_requests_session_started")
      .on(table.session, table.startedAt)
      .where(sql`${table.session} is not null`),
    // The `set null` when a chat is deleted.
    index("telemetry_requests_chat")
      .on(table.chat)
      .where(sql`${table.chat} is not null`),
    // The `set null` when a credential is removed.
    index("telemetry_requests_credential")
      .on(table.credential)
      .where(sql`${table.credential} is not null`),
    // Requests that sent or produced a node, newest first (ingest lineage: retry, continue,
    // rewrite; telemetry GC "still referenced?").
    index("telemetry_requests_input")
      .on(table.input, table.createdAt)
      .where(sql`${table.input} is not null`),
    index("telemetry_requests_output")
      .on(table.output, table.createdAt)
      .where(sql`${table.output} is not null`),
    // Telemetry GC: is a blob still used by a request. Each also backs the `no action` check
    // of the blob's delete, which would otherwise scan every request.
    index("telemetry_requests_system")
      .on(table.system)
      .where(sql`${table.system} is not null`),
    index("telemetry_requests_toolset")
      .on(table.toolset)
      .where(sql`${table.toolset} is not null`),
    index("telemetry_requests_params")
      .on(table.params)
      .where(sql`${table.params} is not null`),
    index("telemetry_requests_headers")
      .on(table.headers)
      .where(sql`${table.headers} is not null`),
    index("telemetry_requests_legacy_input")
      .on(table.legacyInput)
      .where(sql`${table.legacyInput} is not null`),
    index("telemetry_requests_legacy_output")
      .on(table.legacyOutput)
      .where(sql`${table.legacyOutput} is not null`),
    index("telemetry_requests_legacy_spans")
      .on(table.legacySpans)
      .where(sql`${table.legacySpans} is not null`),
  ],
);

/**
 * Workspace export destinations; header secrets live in the Secret Store under `secret_name`,
 * in the destination's namespace.
 */
export const telemetryDestinations = pgTable(
  "telemetry_destinations",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: DESTINATION_KINDS }).notNull(),
    name: text("name").notNull(),
    endpoint: text("endpoint").notNull(),
    secretName: text("secret_name"),
    enabled: boolean("enabled").notNull(),
    /** Strip messages, system instructions, tool definitions and output from exports. */
    privacyMode: boolean("privacy_mode").notNull(),
    /** 0..1; decided per session key so whole sessions are kept or dropped together. */
    samplingRate: doublePrecision("sampling_rate").notNull(),
    /**
     * API keys of the workspace to export, or all when empty; `exclude_api_keys` wins. Read whole
     * for one destination per exported request and validated when written; keys are revoked, never
     * deleted, so the lists need no cleanup.
     */
    includeApiKeys: text("include_api_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    excludeApiKeys: text("exclude_api_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    lastDeliveryAt: instant("last_delivery_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("telemetry_destinations_kind", table.kind, DESTINATION_KINDS),
    check("telemetry_destinations_sampling_rate", sql`${table.samplingRate} between 0 and 1`),
    // A workspace's destinations (telemetryExport list, create, delivery plan).
    index("telemetry_destinations_workspace").on(table.workspace),
  ],
);
