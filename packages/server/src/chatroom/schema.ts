import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { acpChatScopeValidator } from "contracts/acp/contract";
import type { ChatInterruption } from "contracts/chatroom/interruption";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { ChatWorkerSelection } from "contracts/worker/chat-config";
import { user } from "../auth/schema";
import { bytes, checkIn, createdAt, id, instant, json, literals } from "../db/columns";
import { workers } from "../worker/schema";
import { projects, workspaces } from "../workspaces/schema";

/** Persisted AI SDK UI message; parts stay open because AI SDK data parts are extensible. */
export type StoredUIMessage = {
  id?: string;
  role: "system" | "user" | "assistant";
  metadata?: unknown;
  parts: unknown[];
};

/** User message held for the next assistant generation before it joins the history (Home). */
export type QueuedChatMessage = {
  text: string;
  files: {
    type: "file";
    mediaType: string;
    filename?: string;
    url?: string;
    providerMetadata?: unknown;
  }[];
  /** Model slug, not its id. */
  model: string;
  provider?: string;
  serviceTier?: string;
  inferenceMode?: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
  webSearch: boolean;
};

const CHAT_SCOPES = literals(acpChatScopeValidator);

/**
 * A chat (Convex `aisdk_chats`). `scope`: `personal` is the creator only, `shared` the creator
 * plus {@link chatMembers}, `workspace` every workspace member. An ACP chat is the chat with an
 * `acp_sessions` row, which holds its agent binding (Worker, agent, profile, version, folder,
 * session id); a built-in chat is replying while it has an active {@link chatRuns} row.
 */
export const chats = pgTable(
  "chats",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    /** Creator. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: CHAT_SCOPES }).notNull().default("personal"),
    /** Optional Project grouping in the same workspace; never grants visibility. */
    project: text("project").references(() => projects.id, { onDelete: "set null" }),
    title: text("title"),
    emoji: text("emoji"),
    pinnedAt: instant("pinned_at"),
    /** Home ordering; paged by `(last_interaction_at, id)`. */
    lastInteractionAt: instant("last_interaction_at").notNull().defaultNow(),
    /** The queued first prompt of a chat started from Home (keyless chats). */
    messagesQueue: json<QueuedChatMessage>("messages_queue"),
    /** The queued first prompt as a box sealed to chat key `sealed_queue_epoch`. */
    sealedQueueEpoch: integer("sealed_queue_epoch"),
    sealedQueueBox: bytes("sealed_queue_box"),
    /** How the latest request stopped short, if it did (`contracts/chatroom/interruption`). */
    interruption: json<ChatInterruption>("interruption"),
    /**
     * Per-chat tool override; both null means the chat inherits the workspace defaults. Once set,
     * an empty list is an override too. The override's MCP servers are {@link chatMcpServers}.
     */
    builtinToolSets: text("builtin_tool_sets").array(),
    /** Default-on built-in tool sets switched off for this chat. */
    disabledBuiltinToolSets: text("disabled_builtin_tool_sets").array(),
    /** Owner-selected Worker for built-in Worker tools. */
    worker: text("worker").references(() => workers.id, { onDelete: "set null" }),
    /**
     * The rest of the Worker selection: tools, the server-derived `directory` (Project folder,
     * else the Worker's temp directory) and the owner's `grant`; dispatch rechecks authority.
     */
    workerSelection: json<Omit<ChatWorkerSelection, "workerId">>("worker_selection"),
    /**
     * End-to-end encryption (`docs/E2EE/Data.md`). `e2ee_id` is the client-chosen AAD parent of
     * everything sealed for this chat; null means a plaintext (pre-key) chat. `key_epoch` is the
     * current `e2ee_chat_keys` epoch. `rekey` asks the next writer to start a new chat key epoch
     * because a recipient lost access.
     */
    e2eeId: text("e2ee_id"),
    keyEpoch: integer("key_epoch"),
    rekey: boolean("rekey").notNull().default(false),
    /** Title and emoji (`{ title, emoji }` JSON) as a box sealed to chat key `sealed_title_epoch`. */
    sealedTitleEpoch: integer("sealed_title_epoch"),
    sealedTitleBox: bytes("sealed_title_box"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("chats_scope", table.scope, CHAT_SCOPES),
    check(
      "chats_sealed_queue",
      sql`num_nonnulls(${table.sealedQueueEpoch}, ${table.sealedQueueBox}) in (0, 2)`,
    ),
    check(
      "chats_sealed_title",
      sql`num_nonnulls(${table.sealedTitleEpoch}, ${table.sealedTitleBox}) in (0, 2)`,
    ),
    check("chats_e2ee", sql`num_nonnulls(${table.e2eeId}, ${table.keyEpoch}) in (0, 2)`),
    check(
      "chats_tools",
      sql`num_nonnulls(${table.builtinToolSets}, ${table.disabledBuiltinToolSets}) in (0, 2)`,
    ),
    check(
      "chats_worker_selection",
      sql`${table.worker} is null or ${table.workerSelection} is not null`,
    ),
    // Target of the composite foreign keys that keep chat children in the chat's workspace.
    unique("chats_id_workspace").on(table.id, table.workspace),
    // The AAD parent names one chat.
    uniqueIndex("chats_e2ee_id").on(table.e2eeId),
    // Home: a user's own chats in a workspace, newest first (ListChats own branch, `project:
    // null` filter); member removal's shared chats they created; workspace archive's "any chat".
    index("chats_owner_recent").on(
      table.workspace,
      table.userId,
      table.lastInteractionAt,
      table.id,
    ),
    // Home: workspace-scoped chats, newest first (ListChats workspace branch).
    index("chats_workspace_recent")
      .on(table.workspace, table.lastInteractionAt, table.id)
      .where(sql`${table.scope} = 'workspace'`),
    // Home: a user's own pinned chats (ListPinnedChats).
    index("chats_owner_pinned")
      .on(table.workspace, table.userId, table.pinnedAt)
      .where(sql`${table.pinnedAt} is not null`),
    // Home: pinned workspace-scoped chats (ListPinnedChats).
    index("chats_workspace_pinned")
      .on(table.workspace, table.pinnedAt)
      .where(sql`${table.scope} = 'workspace' and ${table.pinnedAt} is not null`),
    // Home filtered to one Project, newest first (ListChats with `project`); Project deletion
    // (`set null`).
    index("chats_project_recent")
      .on(table.project, table.lastInteractionAt, table.id)
      .where(sql`${table.project} is not null`),
    // Worker removal (`set null`).
    index("chats_worker")
      .on(table.worker)
      .where(sql`${table.worker} is not null`),
  ],
);

/**
 * One persisted AI SDK UI message per row, ordered by `position` (0-based) within its chat. Rows
 * carry no access data: every read authorizes the parent chat first. Encrypted chats store
 * `sealed_envelope` (an envelope under capsule `sealed_capsule_id`) instead of `message`;
 * `message_id` and `revision` let saves skip unchanged rows without reading content.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    chat: text("chat")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    message: json<StoredUIMessage>("message"),
    messageId: text("message_id"),
    revision: integer("revision"),
    sealedCapsuleId: text("sealed_capsule_id"),
    sealedEnvelope: bytes("sealed_envelope"),
    createdAt: createdAt(),
  },
  (table) => [
    check("chat_messages_position", sql`${table.position} >= 0`),
    check(
      "chat_messages_sealed",
      sql`num_nonnulls(${table.sealedCapsuleId}, ${table.sealedEnvelope}) in (0, 2)`,
    ),
    // A sealed row never keeps plaintext beside it.
    check(
      "chat_messages_one_form",
      sql`num_nonnulls(${table.message}, ${table.sealedEnvelope}) <= 1`,
    ),
    // History order and saves (GetChatMessages, chatMessageHeads, saves); chat deletion cascade.
    uniqueIndex("chat_messages_chat_position").on(table.chat, table.position),
  ],
);

/**
 * Members of a `shared` chat other than its creator. Grants visibility (the access check reads
 * it); `last_interaction_at` mirrors the chat so Home can page shared chats per member.
 */
export const chatMembers = pgTable(
  "chat_members",
  {
    id: id(),
    chat: text("chat").notNull(),
    workspace: text("workspace").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    lastInteractionAt: instant("last_interaction_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "chat_members_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    // One membership per chat and user; the access check; chat deletion cascade.
    uniqueIndex("chat_members_chat_user").on(table.chat, table.userId),
    // Home: chats shared with a user, newest first (ListChats, ListPinnedChats); member removal.
    index("chat_members_user_recent").on(
      table.workspace,
      table.userId,
      table.lastInteractionAt,
      table.chat,
    ),
  ],
);

/**
 * Chat attachments in the object store. A row is one chat's reference to a stored object
 * (`storage_key`); `chat` is null between upload and the first save that references it. The
 * object is deleted once no row references it (`files.orphans` job). `legacy_url` is the Convex
 * storage URL that imported messages still carry (`/api/files/resolve`).
 */
export const chatFiles = pgTable(
  "chat_files",
  {
    id: id(),
    legacyContent: json<LegacyBox>("legacy_content"),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Uploader. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** Object store key; null only on imported rows whose bytes moved into `legacy_content`. */
    storageKey: text("storage_key"),
    legacyUrl: text("legacy_url"),
    mediaType: text("media_type").notNull(),
    filename: text("filename"),
    size: bigint("size", { mode: "number" }).notNull(),
    chat: text("chat"),
    /**
     * Encrypted uploads: the stored bytes are an envelope under the object key derived from
     * `capsule` (sealed to chat key `chat_epoch` of the chat whose `e2ee_id` is `e2ee_parent`) for
     * record `file_id`. `filename` and the plaintext size are not stored for them.
     */
    fileId: text("file_id"),
    capsule: bytes("capsule"),
    chatEpoch: integer("chat_epoch"),
    e2eeParent: text("e2ee_parent"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "chat_files_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    check(
      "chat_files_sealed",
      sql`num_nonnulls(${table.fileId}, ${table.capsule}, ${table.chatEpoch}, ${table.e2eeParent}) in (0, 4)`,
    ),
    // One reference per object and chat, and one pending registration per object (files.register,
    // link on save and fork); the last-reference check and the orphan job look objects up here.
    uniqueIndex("chat_files_storage_chat")
      .on(table.storageKey, sql`coalesce(${table.chat}, '')`)
      .where(sql`${table.storageKey} is not null`),
    // Imported attachments by their old URL (historicalFile, `/api/files/resolve`, link on save).
    index("chat_files_legacy_url")
      .on(table.workspace, table.legacyUrl, table.chat)
      .where(sql`${table.legacyUrl} is not null`),
    // A chat's attachments; chat deletion cascade.
    index("chat_files_chat")
      .on(table.chat)
      .where(sql`${table.chat} is not null`),
    // Pending uploads never sent, oldest first (`files.orphans` job).
    index("chat_files_pending")
      .on(table.createdAt)
      .where(sql`${table.chat} is null`),
  ],
);

const CHAT_RUN_STATUSES = ["active", "finished", "failed"] as const;

/**
 * One built-in reply generation (`/api/chat`), streamed at `c/<chat>/runs/<run>`. A chat has at
 * most one `active` run; a second sender gets `409`. The generator renews `lease_at` every 15 s,
 * and the retention job fails active runs whose lease went stale. Ended rows go with their stream.
 */
export const chatRuns = pgTable(
  "chat_runs",
  {
    id: id(),
    chat: text("chat")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** Sender. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: text("status", { enum: CHAT_RUN_STATUSES }).notNull().default("active"),
    leaseAt: instant("lease_at").notNull().defaultNow(),
    endedAt: instant("ended_at"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("chat_runs_status", table.status, CHAT_RUN_STATUSES),
    check("chat_runs_ended_at", sql`(${table.status} = 'active') = (${table.endedAt} is null)`),
    // Admission: one active built-in run per chat; also chats.get's active run.
    uniqueIndex("chat_runs_one_active")
      .on(table.chat)
      .where(sql`${table.status} = 'active'`),
    // Chat deletion cascade.
    index("chat_runs_chat").on(table.chat),
    // Lost runs: active runs with a stale lease (retention job).
    index("chat_runs_lease")
      .on(table.leaseAt)
      .where(sql`${table.status} = 'active'`),
  ],
);

const MCP_TRANSPORTS = ["http"] as const;

/** How the backend authenticates to an MCP server; a bearer token lives in `secrets`. */
export type McpServerAuth = { type: "none" } | { type: "bearer" };

/**
 * Workspace MCP (Model Context Protocol) server metadata. Secrets (the bearer token) are stored in
 * `secrets`; this table keeps only non-secret connection metadata and masked previews.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Who created it. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    transport: text("transport", { enum: MCP_TRANSPORTS }).notNull(),
    auth: json<McpServerAuth>("auth").notNull(),
    /** Masked, non-secret previews of the stored secrets for display. */
    preview: json<Record<string, string>>("preview"),
    /**
     * Whether the server's tools are reachable only inside Code Mode (`execute`); `false` exposes
     * them as direct tool calls instead.
     */
    codeMode: boolean("code_mode").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("mcp_servers_transport", table.transport, MCP_TRANSPORTS),
    // A workspace's servers (listMcpServers); target of the composite key that keeps chat
    // selections inside the workspace.
    unique("mcp_servers_workspace_id").on(table.workspace, table.id),
  ],
);

/**
 * The MCP servers of a chat's tool override (`chats.builtin_tool_sets` set). Deleting the server
 * or the chat removes the row; the server must belong to the chat's workspace.
 */
export const chatMcpServers = pgTable(
  "chat_mcp_servers",
  {
    id: id(),
    chat: text("chat").notNull(),
    workspace: text("workspace").notNull(),
    mcpServer: text("mcp_server").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "chat_mcp_servers_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    foreignKey({
      name: "chat_mcp_servers_mcp_server_fk",
      columns: [table.workspace, table.mcpServer],
      foreignColumns: [mcpServers.workspace, mcpServers.id],
    }).onDelete("cascade"),
    // A chat's selected servers (tool resolution); chat deletion cascade.
    uniqueIndex("chat_mcp_servers_chat_server").on(table.chat, table.mcpServer),
    // Server deletion cascade.
    index("chat_mcp_servers_server").on(table.workspace, table.mcpServer),
  ],
);
