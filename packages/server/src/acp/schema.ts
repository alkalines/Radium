import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  acpAgentDefinitionValidator,
  acpCommandKindValidator,
  acpCommandStatusValidator,
  acpHistoryValidator,
  acpInteractionStatusValidator,
  acpProfileValidator,
  acpSessionStatusValidator,
  acpStopReasonValidator,
  type AcpAgentDefinition,
  type AcpCommandInfo,
  type AcpCommandPayload,
  type AcpConfig,
  type AcpDeletedTarget,
  type AcpDraftConfig,
  type AcpInteractionAnswer,
  type AcpInteractionRequest,
  type AcpSessionProof,
  type AcpSignedBinding,
  type AcpTurnUsage,
  type AcpUsage,
} from "contracts/acp/contract";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import { user } from "../auth/schema";
import { chats } from "../chatroom/schema";
import { bytes, checkIn, createdAt, id, instant, json, literals } from "../db/columns";
import { workers } from "../worker/schema";
import { workspaces } from "../workspaces/schema";

const AGENT_SOURCES = literals(acpAgentDefinitionValidator.shape.source);
const PROFILES = literals(acpProfileValidator);
const SESSION_STATUSES = literals(acpSessionStatusValidator);
const STOP_REASONS = literals(acpStopReasonValidator);
const HISTORIES = literals(acpHistoryValidator);
const COMMAND_KINDS = literals(acpCommandKindValidator);
const COMMAND_STATUSES = literals(acpCommandStatusValidator);
const INTERACTION_STATUSES = literals(acpInteractionStatusValidator);
const INTERACTION_KINDS = ["permission", "elicitation"] as const;

/**
 * Owner-defined launch configuration of one agent, shared by every Worker in the workspace. A
 * Worker resolves `command` on its `PATH` unless it is a path; `env` holds non-secret launch
 * settings; `version` pins a registry release. `authorization_*` is the owner's executable
 * authorization; paired Workers refuse definitions without it.
 */
export const acpAgents = pgTable(
  "acp_agents",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    command: text("command").notNull(),
    args: text("args").array().notNull(),
    env: json<AcpAgentDefinition["env"]>("env").notNull(),
    gateway: json<NonNullable<AcpAgentDefinition["gateway"]>>("gateway"),
    enabled: boolean("enabled").notNull(),
    source: text("source", { enum: AGENT_SOURCES }).notNull(),
    icon: text("icon"),
    version: text("version"),
    authorizationIssuedAt: instant("authorization_issued_at"),
    authorizationSignerKeyId: text("authorization_signer_key_id"),
    authorizationSignature: bytes("authorization_signature"),
    updatedAt: instant("updated_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("acp_agents_source", table.source, AGENT_SOURCES),
    check(
      "acp_agents_authorization",
      sql`num_nonnulls(${table.authorizationIssuedAt}, ${table.authorizationSignerKeyId}, ${table.authorizationSignature}) in (0, 3)`,
    ),
    // One definition per agent id; a workspace's definitions (Agents page, Worker
    // `definitions`, Home's enabled agents, CreateSession's gateway check).
    uniqueIndex("acp_agents_workspace_agent").on(table.workspace, table.agentId),
  ],
);

/**
 * Owner-only agent session catalog, independent of Radium chat creation: small agent-owned
 * metadata, never conversation content. A paired Worker never sends `title`: it seals it to the
 * workspace owner key (`sealed_title_*`, AAD `acp_agent_sessions`/workerId/`${agentId}:${sessionId}`/
 * `title`) and diffs on `title_tag`, a keyed tag only that Worker can compute. `chat` is the Radium
 * chat opened on the session, if any.
 */
export const acpAgentSessions = pgTable(
  "acp_agent_sessions",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    workspace: text("workspace").notNull(),
    worker: text("worker").notNull(),
    agentId: text("agent_id").notNull(),
    sessionId: text("session_id").notNull(),
    cwd: text("cwd").notNull(),
    title: text("title"),
    sealedTitleEpoch: integer("sealed_title_epoch"),
    sealedTitleBox: bytes("sealed_title_box"),
    titleTag: text("title_tag"),
    /** The agent's own last-update time of the session. */
    updatedAt: instant("updated_at").notNull(),
    chat: text("chat").references(() => chats.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "acp_agent_sessions_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
    }).onDelete("cascade"),
    check(
      "acp_agent_sessions_sealed_title",
      sql`num_nonnulls(${table.sealedTitleEpoch}, ${table.sealedTitleBox}) in (0, 2)`,
    ),
    // One entry per agent session on a Worker (sync upserts, session patch, chat deletion).
    uniqueIndex("acp_agent_sessions_worker_session").on(
      table.worker,
      table.agentId,
      table.sessionId,
    ),
    // An agent's sessions, newest first (ListAgentSessionIndex).
    index("acp_agent_sessions_agent_recent").on(
      table.workspace,
      table.agentId,
      table.updatedAt,
      table.id,
    ),
    // Home: sessions Radium has not opened, newest first (ListUnopenedAgentSessions).
    index("acp_agent_sessions_unopened")
      .on(table.workspace, table.updatedAt, table.id)
      .where(sql`${table.chat} is null`),
    // Home filtered to a Project: unopened sessions in one Worker folder (ListUnopenedAgentSessions).
    index("acp_agent_sessions_unopened_folder")
      .on(table.worker, table.cwd, table.updatedAt, table.id)
      .where(sql`${table.chat} is null`),
    // Usage activity: the agent and folder of a session id (usage/activity resolveSession).
    index("acp_agent_sessions_session").on(table.workspace, table.sessionId),
    // Chat deletion (`set null`).
    index("acp_agent_sessions_chat")
      .on(table.chat)
      .where(sql`${table.chat} is not null`),
  ],
);

/**
 * Durable ACP lifecycle of one chat, and the chat's agent binding: which agent (`agent_id`,
 * `agent_version`, launch `profile`) runs in which folder (`cwd`) on which Worker. Conversation
 * content belongs to the agent on its Worker. `session_id` is written once, by the bound Worker.
 *
 * Prompt admission is `update … set status = 'starting' where chat = $1 and status in ('idle',
 * 'failed') returning`. `epoch` numbers the chat's live stream `c/<chat>/acp/<epoch>`; cooling
 * sets `cooled_epoch` to it, clearing that epoch and every older one, so the Worker must open a
 * newer one. Both advance only through conditional updates on their current values.
 */
export const acpSessions = pgTable(
  "acp_sessions",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    chat: text("chat").notNull(),
    workspace: text("workspace").notNull(),
    worker: text("worker").notNull(),
    agentId: text("agent_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    profile: text("profile", { enum: PROFILES }).notNull().default("native"),
    cwd: text("cwd").notNull(),
    sessionId: text("session_id"),
    status: text("status", { enum: SESSION_STATUSES }).notNull(),
    epoch: integer("epoch").notNull().default(0),
    cooledEpoch: integer("cooled_epoch"),
    stopReason: text("stop_reason", { enum: STOP_REASONS }),
    /** Generic text (or a fixed code) when the error is sealed in `sealed_error_*`. */
    error: text("error"),
    config: json<AcpConfig>("config"),
    commands: json<AcpCommandInfo[]>("commands"),
    usage: json<AcpUsage>("usage"),
    turnUsage: json<AcpTurnUsage>("turn_usage"),
    history: text("history", { enum: HISTORIES }),
    /** Choices made before the agent session exists, applied right after `session/new`. */
    draft: json<AcpDraftConfig>("draft"),
    /** Who started the current turn; notified when it ends or needs attention. */
    turnBy: text("turn_by").references(() => user.id, { onDelete: "restrict" }),
    userTitled: boolean("user_titled").notNull().default(false),
    /** Creator-signed binding (keyed workspaces); Workers execute nothing for a chat without it. */
    binding: json<AcpSignedBinding>("binding"),
    /** Who bound `session_id` to this chat; a paired Worker refuses an unproven session id. */
    sessionProof: json<AcpSessionProof>("session_proof"),
    /** Keyed chats: the error text sealed to chat key `sealed_error_epoch`. */
    sealedErrorEpoch: integer("sealed_error_epoch"),
    sealedErrorBox: bytes("sealed_error_box"),
    updatedAt: instant("updated_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "acp_sessions_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    foreignKey({
      name: "acp_sessions_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
      // Workers are revoked, never deleted; a deleted Worker's bindings go with it.
    }).onDelete("cascade"),
    checkIn("acp_sessions_profile", table.profile, PROFILES),
    checkIn("acp_sessions_status", table.status, SESSION_STATUSES),
    checkIn("acp_sessions_stop_reason", table.stopReason, STOP_REASONS),
    checkIn("acp_sessions_history", table.history, HISTORIES),
    check(
      "acp_sessions_epochs",
      sql`${table.epoch} >= 0 and (${table.cooledEpoch} is null or ${table.cooledEpoch} <= ${table.epoch})`,
    ),
    check(
      "acp_sessions_sealed_error",
      sql`num_nonnulls(${table.sealedErrorEpoch}, ${table.sealedErrorBox}) in (0, 2)`,
    ),
    // One session per chat (findSession, prompt admission, Electric `acpSession` shape); cascade.
    uniqueIndex("acp_sessions_chat").on(table.chat),
    // An agent session id is bound to one chat per agent and Worker (session patch, fork).
    uniqueIndex("acp_sessions_binding")
      .on(table.worker, table.agentId, table.sessionId)
      .where(sql`${table.sessionId} is not null`),
    // Worker restart: its sessions mid-turn (recoverWorker).
    index("acp_sessions_worker_busy")
      .on(table.worker, table.status)
      .where(sql`${table.status} in ('starting', 'running', 'awaiting')`),
    // Usage activity: the chat bound to a session id (usage/activity resolveSession).
    index("acp_sessions_session")
      .on(table.workspace, table.sessionId)
      .where(sql`${table.sessionId} is not null`),
  ],
);

/**
 * Browser → Worker intent. Payloads exist only until the assigned Worker claims them: the claim is
 * `update … set status = 'claimed', claimed_at = now(), payload = null, signed_* = null where id =
 * $1 and worker = $w and status = 'pending' returning`. Insert is `on conflict (worker, client_id)
 * do nothing returning`; a conflicting row from another issuer is refused. In keyed workspaces
 * `signed_*` replaces `payload`: a box sealed to the Worker's encryption key (AAD
 * `acp_commands`/chatId or ""/clientId/`payload`) and the issuer's signature over
 * `acpCommandStatement`. `close`/`delete` name no chat; `target` snapshots the deleted chat's
 * binding so the Worker can authorize them.
 */
export const acpCommands = pgTable(
  "acp_commands",
  {
    id: id(),
    workspace: text("workspace").notNull(),
    worker: text("worker").notNull(),
    /** The session's chat for session-level kinds. */
    chat: text("chat"),
    kind: text("kind", { enum: COMMAND_KINDS }).notNull(),
    /** Agent-level target; survives payload erasure so sync admission can debounce claimed work. */
    agentId: text("agent_id"),
    payload: json<AcpCommandPayload>("payload"),
    signedPayload: bytes("signed_payload"),
    signedSignature: bytes("signed_signature"),
    signedSignerKeyId: text("signed_signer_key_id"),
    target: json<AcpDeletedTarget>("target"),
    /** Issuer-chosen idempotency key (the signed one in keyed workspaces). */
    clientId: text("client_id").notNull(),
    issuedBy: text("issued_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: text("status", { enum: COMMAND_STATUSES }).notNull().default("pending"),
    error: text("error"),
    /** Worker result text; for `fork`, the target chat id. */
    result: text("result"),
    claimedAt: instant("claimed_at"),
    finishedAt: instant("finished_at"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "acp_commands_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
    }).onDelete("cascade"),
    foreignKey({
      name: "acp_commands_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    checkIn("acp_commands_kind", table.kind, COMMAND_KINDS),
    checkIn("acp_commands_status", table.status, COMMAND_STATUSES),
    check(
      "acp_commands_signed",
      sql`num_nonnulls(${table.signedPayload}, ${table.signedSignature}, ${table.signedSignerKeyId}) in (0, 3)`,
    ),
    // A pending command carries exactly one payload form; leaving `pending` erases it.
    check(
      "acp_commands_payload",
      sql`num_nonnulls(${table.payload}, ${table.signedPayload}) = (case when ${table.status} = 'pending' then 1 else 0 end)`,
    ),
    check(
      "acp_commands_session_kinds",
      sql`(${table.chat} is not null) = (${table.kind} in ('prompt', 'cancel', 'set_config', 'set_mode', 'history', 'fork'))`,
    ),
    check(
      "acp_commands_claimed_at",
      sql`${table.status} <> 'claimed' or ${table.claimedAt} is not null`,
    ),
    check(
      "acp_commands_finished_at",
      sql`(${table.status} in ('done', 'failed')) = (${table.finishedAt} is not null)`,
    ),
    // Dedupe by client id per Worker (enqueue, StartFork retry).
    uniqueIndex("acp_commands_worker_client").on(table.worker, table.clientId),
    // The Worker's queue and in-flight work, oldest first (pendingCommands, recoverWorker,
    // SyncAgentSessions debounce).
    index("acp_commands_worker_open")
      .on(table.worker, table.status, table.createdAt, table.id)
      .where(sql`${table.status} in ('pending', 'claimed')`),
    // A chat's queued and in-flight commands (Cancel, promptClaimed, RequestHistory); cascade.
    index("acp_commands_chat")
      .on(table.chat, table.status)
      .where(sql`${table.chat} is not null`),
    // Retention: finished commands past five minutes.
    index("acp_commands_finished")
      .on(table.finishedAt)
      .where(sql`${table.finishedAt} is not null`),
    // Retention: pending commands never claimed within seven days.
    index("acp_commands_pending_expiry")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/**
 * A blocking agent request answered in Chatroom: `pending` → `answered` (durable decision) →
 * `resolved` once the Worker relayed it, or `cancelled`. The first answer wins: `update … set
 * status = 'answered', … where id = $1 and status = 'pending' returning`; a Worker that finds a
 * sealed answer invalid re-opens it (`answered` → `pending`, answer cleared). Keyless workspaces
 * store `request`/`answer`; keyed ones the Worker-sealed, Worker-signed request (`sealed_request_*`,
 * chat key `sealed_request_epoch`, AAD `acp_interactions`/e2eeId/requestKey/`request`) and the
 * answer sealed to the Worker and signed by the answering user (`sealed_answer*`, AAD
 * `acp_interactions`/chatId/requestKey/`answer`). Resolved rows are deleted ten minutes after
 * `resolved_at`.
 */
export const acpInteractions = pgTable(
  "acp_interactions",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    workspace: text("workspace").notNull(),
    chat: text("chat").notNull(),
    worker: text("worker").notNull(),
    requestKey: text("request_key").notNull(),
    kind: text("kind", { enum: INTERACTION_KINDS }).notNull(),
    request: json<AcpInteractionRequest>("request"),
    sealedRequestEpoch: integer("sealed_request_epoch"),
    sealedRequestBox: bytes("sealed_request_box"),
    sealedRequestSignature: bytes("sealed_request_signature"),
    status: text("status", { enum: INTERACTION_STATUSES }).notNull().default("pending"),
    answer: json<AcpInteractionAnswer>("answer"),
    sealedAnswer: bytes("sealed_answer"),
    sealedAnswerSignature: bytes("sealed_answer_signature"),
    sealedAnswerSignerKeyId: text("sealed_answer_signer_key_id"),
    answeredBy: text("answered_by").references(() => user.id, { onDelete: "restrict" }),
    answeredAt: instant("answered_at"),
    resolvedAt: instant("resolved_at"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "acp_interactions_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    foreignKey({
      name: "acp_interactions_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
    }).onDelete("cascade"),
    checkIn("acp_interactions_kind", table.kind, INTERACTION_KINDS),
    checkIn("acp_interactions_status", table.status, INTERACTION_STATUSES),
    check(
      "acp_interactions_sealed_request",
      sql`num_nonnulls(${table.sealedRequestEpoch}, ${table.sealedRequestBox}, ${table.sealedRequestSignature}) in (0, 3)`,
    ),
    check(
      "acp_interactions_sealed_answer",
      sql`num_nonnulls(${table.sealedAnswer}, ${table.sealedAnswerSignature}, ${table.sealedAnswerSignerKeyId}) in (0, 3)`,
    ),
    check(
      "acp_interactions_one_request",
      sql`num_nonnulls(${table.request}, ${table.sealedRequestBox}) <= 1`,
    ),
    // Pending rows hold no answer; answered rows hold exactly one, with who and when.
    check(
      "acp_interactions_answer",
      sql`case ${table.status}
        when 'pending' then num_nonnulls(${table.answer}, ${table.sealedAnswer}, ${table.answeredBy}, ${table.answeredAt}) = 0
        when 'answered' then num_nonnulls(${table.answer}, ${table.sealedAnswer}) = 1 and ${table.answeredBy} is not null and ${table.answeredAt} is not null
        else true end`,
    ),
    check(
      "acp_interactions_resolved_at",
      sql`(${table.status} in ('resolved', 'cancelled')) = (${table.resolvedAt} is not null)`,
    ),
    // One interaction per agent request (openInteraction retries); a chat's open interactions
    // (resolveInteraction, the chat's run state); chat deletion cascade.
    uniqueIndex("acp_interactions_chat_request").on(table.chat, table.requestKey),
    // The Worker's answers to deliver and open requests to cancel on restart
    // (answeredInteractions, recoverWorker).
    index("acp_interactions_worker_open")
      .on(table.worker, table.status)
      .where(sql`${table.status} in ('pending', 'answered')`),
    // Retention: resolved interactions past ten minutes.
    index("acp_interactions_resolved")
      .on(table.resolvedAt)
      .where(sql`${table.resolvedAt} is not null`),
  ],
);
