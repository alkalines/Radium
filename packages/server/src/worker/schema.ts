import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import {
  acpAgentReportValidator,
  acpAgentStatusValidator,
  type AcpAgentCapabilities,
  type AcpAgentReport,
  type AcpAuthMethod,
} from "contracts/acp/contract";
import { acpGatewayAccessValidator, keyTelemetryValidator } from "contracts/acp/gateway";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { WorkerBashRequest } from "contracts/worker/bash-contract";
import type { WorkerEditRequest, WorkerEditResult } from "contracts/worker/edit-contract";
import { workerChatStage, workerChatTool, workerTaskStatus } from "contracts/worker/task-contract";
import { user } from "../auth/schema";
import { chats } from "../chatroom/schema";
import { bytes, checkIn, createdAt, id, instant, json, literals } from "../db/columns";
import { apiKeys } from "../gateway/schema";
import { workspaces } from "../workspaces/schema";

/**
 * A Worker machine identity (Convex `workerIdentity.workers`). `active` means not revoked, not
 * online. `identity_epoch` is the revocation version carried in access tokens: revoking bumps it,
 * so every token issued before stops working at its next request.
 */
export const workers = pgTable(
  "workers",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    capabilities: text("capabilities").array().notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull(),
    identityEpoch: integer("identity_epoch").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("workers_status", sql`${table.status} in ('active', 'revoked')`),
    // A workspace's Workers.
    index("workers_workspace").on(table.workspace),
    // Target of composite foreign keys `(worker, workspace)`: a row that names both cannot name
    // another workspace's Worker.
    unique("workers_id_workspace").on(table.id, table.workspace),
  ],
);

/** A Worker's proof key (Convex `workerIdentity.keys`): canonical public JWK and thumbprint. */
export const workerKeys = pgTable(
  "worker_keys",
  {
    id: id(),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    algorithm: text("algorithm").notNull(),
    material: text("material").notNull(),
    thumbprint: text("thumbprint").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // One identity per key; enrollment looks keys up by thumbprint.
    uniqueIndex("worker_keys_thumbprint").on(table.thumbprint),
    // Cascade from `workers`.
    index("worker_keys_worker").on(table.worker),
  ],
);

const ENROLLMENT_STATES = ["pending", "completed", "revoked"] as const;

/**
 * A Worker setup code's server half: the workspace it admits to, the digest of its one-time token
 * (the raw token never reaches storage) and, once used, the identity it produced. The row id is the
 * `enrollmentId` of setup codes, Worker local state and `e2ee_worker_pairings.enrollment`.
 * Completion is one conditional `update … set state = 'completed', completion_… where id = $1 and
 * token_hash = $2 and state = 'pending' and expires_at > now() returning`; a retry with the same
 * `completion_request_id` and key returns the recorded identity. A completed receipt stays so the
 * Worker can recover its identity with proof of the original key.
 */
export const workerEnrollments = pgTable(
  "worker_enrollments",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** Name and capabilities the enrolled Worker starts with. */
    name: text("name").notNull(),
    capabilities: text("capabilities").array().notNull(),
    expiresAt: instant("expires_at").notNull(),
    state: text("state", { enum: ENROLLMENT_STATES }).notNull(),
    /** Set exactly when `state` is `completed`. */
    completionWorker: text("completion_worker").references(() => workers.id, {
      onDelete: "cascade",
    }),
    completionKey: text("completion_key").references(() => workerKeys.id, { onDelete: "cascade" }),
    completionRequestId: text("completion_request_id"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("worker_enrollments_state", table.state, ENROLLMENT_STATES),
    check(
      "worker_enrollments_completion",
      sql`num_nonnulls(${table.completionWorker}, ${table.completionKey}, ${table.completionRequestId}) = case when ${table.state} = 'completed' then 3 else 0 end`,
    ),
    // A setup token names one enrollment; completion looks it up by digest.
    uniqueIndex("worker_enrollments_token_hash").on(table.tokenHash),
    // An identity comes from exactly one enrollment.
    uniqueIndex("worker_enrollments_completion_worker").on(table.completionWorker),
  ],
);

/** Worker-owned agent availability; presence is deliberately not part of session reads. */
export const workerAgents = pgTable(
  "worker_agents",
  {
    id: id(),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    icon: text("icon"),
    source: text("source", { enum: literals(acpAgentReportValidator.shape.source) }).notNull(),
    status: text("status", { enum: literals(acpAgentStatusValidator) }).notNull(),
    /** Short reason for `unavailable`/`failed`; never stderr or credentials. */
    error: text("error"),
    capabilities: json<AcpAgentCapabilities>("capabilities").notNull(),
    authMethods: json<AcpAuthMethod[]>("auth_methods").notNull(),
    /** Last config/commands seen from `session/new` on this Worker, for drafts. */
    defaults: json<NonNullable<AcpAgentReport["defaults"]>>("defaults"),
    /** Last session-list sync of this agent; absent until the first one. */
    sessionsSync: json<{
      status: "running" | "done" | "failed";
      at: number;
      count?: number;
      truncated?: boolean;
      error?: string;
    }>("sessions_sync"),
    checkedAt: instant("checked_at").notNull(),
    legacyContent: json<LegacyBox>("legacy_content"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("worker_agents_source", table.source, literals(acpAgentReportValidator.shape.source)),
    checkIn("worker_agents_status", table.status, literals(acpAgentStatusValidator)),
    // One catalog entry per agent and Worker; serves the Worker's catalog replace
    // (acp.reportAgents), agent lookups (policy.findAgent) and, joined from `workers`, the
    // workspace catalog (acp.ListAgents, session-list sync by agent).
    uniqueIndex("worker_agents_worker_agent").on(table.worker, table.agentId),
  ],
);

/**
 * Short-lived Worker handoff status, with optional correlation to durable chat history. Keyless
 * workspaces with unpaired Workers use plaintext `edit_request`/`bash_request`/`result`; paired
 * Workers get only the sealed request (`sealed_*`, sealed to the Worker encryption key
 * `sealed_key_id`) and answer with `sealed_result`. `request_id` deduplicates dispatch to one
 * Worker. Claim is `update … set status = 'processing', claim_id = $c, revision = revision + 1,
 * attempt = attempt + 1 where id = $1 and worker = $w and status = 'sent' returning`; completion
 * and status changes are conditional on `(status, claim_id, revision)`, so a stale attempt never
 * finishes a later one. Terminal rows are deleted five minutes after `terminal_at`.
 */
export const workerTasks = pgTable(
  "worker_tasks",
  {
    id: id(),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    operation: text("operation").notNull(),
    chat: text("chat").references(() => chats.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id"),
    status: text("status", { enum: literals(workerTaskStatus) }).notNull(),
    revision: integer("revision").notNull(),
    attempt: integer("attempt").notNull(),
    updatedAt: instant("updated_at").notNull(),
    /** Set exactly while the status is `failed` or `success`. */
    terminalAt: instant("terminal_at"),
    editRequest: json<WorkerEditRequest>("edit_request"),
    bashRequest: json<WorkerBashRequest>("bash_request"),
    sealedKeyId: text("sealed_key_id"),
    sealedEncapsulated: bytes("sealed_encapsulated"),
    sealedRequest: bytes("sealed_request"),
    /** The user who dispatched a chat tool task. */
    editOwnerId: text("edit_owner_id").references(() => user.id, { onDelete: "restrict" }),
    claimId: text("claim_id"),
    result: json<WorkerEditResult>("result"),
    sealedResult: bytes("sealed_result"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("worker_tasks_status", table.status, literals(workerTaskStatus)),
    check(
      "worker_tasks_terminal_at",
      sql`(${table.status} in ('failed', 'success')) = (${table.terminalAt} is not null)`,
    ),
    check(
      "worker_tasks_sealed",
      sql`num_nonnulls(${table.sealedKeyId}, ${table.sealedEncapsulated}, ${table.sealedRequest}) in (0, 3)`,
    ),
    check(
      "worker_tasks_one_request",
      sql`num_nonnulls(${table.editRequest}, ${table.bashRequest}, ${table.sealedRequest}) <= 1`,
    ),
    // Dispatch dedupe: one task per request ID and Worker (worker_tasks.create, chat dispatch).
    uniqueIndex("worker_tasks_worker_request").on(table.worker, table.requestId),
    // The Worker's queue: its assignable tasks of one status and operation (worker_tasks.assigned).
    index("worker_tasks_queue").on(table.worker, table.status, table.operation),
    // Retention: terminal tasks past five minutes (retention job).
    index("worker_tasks_terminal_at")
      .on(table.terminalAt)
      .where(sql`${table.terminalAt} is not null`),
    // Cascade from `chats`.
    index("worker_tasks_chat")
      .on(table.chat)
      .where(sql`${table.chat} is not null`),
  ],
);

/**
 * Durable chat tool-call idempotency and output receipts; internal-only access. `request_key`
 * binds a receipt to its canonical request (the request ID for sealed tasks). Receipts outlive
 * their short-lived task (`task` becomes null when it is pruned); the completion claim and
 * revision fence acknowledgments. Sealed tasks never store a plaintext `result`: the Worker seals
 * `sealed_result` to the chat key epoch `receipt_epoch`.
 */
export const workerChatCalls = pgTable(
  "worker_chat_calls",
  {
    id: id(),
    chat: text("chat")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    directory: text("directory").notNull(),
    tool: text("tool", { enum: literals(workerChatTool) }).notNull(),
    toolCallId: text("tool_call_id").notNull(),
    stage: text("stage", { enum: literals(workerChatStage) }).notNull(),
    requestKey: text("request_key").notNull(),
    task: text("task").references(() => workerTasks.id, { onDelete: "set null" }),
    result: json<WorkerEditResult>("result"),
    sealedResult: bytes("sealed_result"),
    receiptEpoch: integer("receipt_epoch"),
    completionClaimId: text("completion_claim_id"),
    completionRevision: integer("completion_revision"),
    legacyContent: json<LegacyBox>("legacy_content"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("worker_chat_calls_tool", table.tool, literals(workerChatTool)),
    checkIn("worker_chat_calls_stage", table.stage, literals(workerChatStage)),
    check(
      "worker_chat_calls_completion",
      sql`num_nonnulls(${table.completionClaimId}, ${table.completionRevision}) in (0, 2)`,
    ),
    // One receipt per call stage; also the call's stages for dispatch binding and chat cleanup.
    uniqueIndex("worker_chat_calls_chat_call_stage").on(table.chat, table.toolCallId, table.stage),
    // A task serves one call stage; completion and outcome reads look the receipt up by task.
    uniqueIndex("worker_chat_calls_task").on(table.task),
  ],
);

/**
 * Gateway access of one Worker: whether it may mint a Gateway API key, the key it holds while
 * `active`, and the telemetry choice applied to that key.
 */
export const workerGateway = pgTable(
  "worker_gateway",
  {
    id: id(),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    access: text("access", { enum: literals(acpGatewayAccessValidator) }).notNull(),
    telemetry: text("telemetry", { enum: literals(keyTelemetryValidator) }).notNull(),
    /** Set exactly while `access` is `active`. */
    apiKey: text("api_key").references(() => apiKeys.id, { onDelete: "restrict" }),
    updatedAt: instant("updated_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("worker_gateway_access", table.access, literals(acpGatewayAccessValidator)),
    checkIn("worker_gateway_telemetry", table.telemetry, literals(keyTelemetryValidator)),
    check(
      "worker_gateway_active_key",
      sql`(${table.access} = 'active') = (${table.apiKey} is not null)`,
    ),
    // One row per Worker; the Worker's and the owner's lookups.
    uniqueIndex("worker_gateway_worker").on(table.worker),
    // A key belongs to one Worker; key deletion clears the Worker's access (keys.deleteKey).
    uniqueIndex("worker_gateway_api_key").on(table.apiKey),
  ],
);
