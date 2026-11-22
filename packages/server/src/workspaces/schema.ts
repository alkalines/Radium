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
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { StoredNotificationPreferences } from "contracts/notifications/contract";
import type { LimitSettings } from "contracts/limits/meters";
import type { RoutingSettings } from "contracts/routing/settings";
import { chatWorkerToolValidator } from "contracts/worker/chat-config";
import { user } from "../auth/schema";
import { mcpServers } from "../chatroom/schema";
import { createdAt, id, instant, json, literals } from "../db/columns";
import { workers } from "../worker/schema";

const WORKER_TOOLS = literals(chatWorkerToolValidator);

/**
 * A workspace is the ownership and credential boundary for Gateway resources. Ownership is
 * personal-user only; explicit members are in {@link workspaceMembers}. Better Auth organizations
 * do not grant access.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    icon: text("icon"),
    /** Tile color name from `contracts/workspaces/colors`; unknown names resolve to the default. */
    color: text("color"),
    /** Archived workspaces refuse every request (`../trpc/procedures.ts`). */
    archivedAt: instant("archived_at"),
    /**
     * Current workspace key epoch (`e2ee_workspace_epochs.epoch`); null until the owner creates
     * keys. Epochs count up from 1.
     */
    keyEpoch: integer("key_epoch"),
    /** Sealed form of the plaintext fields written before the workspace had keys. */
    legacyContent: json<LegacyBox>("legacy_content"),
    createdAt: createdAt(),
  },
  (table) => [
    check("workspaces_key_epoch", sql`${table.keyEpoch} is null or ${table.keyEpoch} >= 1`),
    // The workspaces a user owns.
    index("workspaces_owner").on(table.ownerId),
  ],
);

/** Direct workspace access for an existing user; no invitation acceptance. */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["member"] }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("workspace_members_role", sql`${table.role} in ('member')`),
    // One membership per user and workspace; also the access check's lookup.
    uniqueIndex("workspace_members_workspace_user").on(table.workspace, table.userId),
    // The workspaces a user is a member of.
    index("workspace_members_user").on(table.userId),
  ],
);

/**
 * Workspace defaults, one row per workspace, created on the first owner change. A missing row
 * reads as the column defaults. `routing` and `limits` stay nullable because their defaults live
 * in code and may change; null follows them.
 */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    defaultModel: text("default_model"),
    titleModel: text("title_model"),
    enableChainOfThought: boolean("enable_chain_of_thought").notNull().default(true),
    /** Telemetry capture is opt-in; content recording is opt-in per direction. */
    telemetryEnabled: boolean("telemetry_enabled").notNull().default(false),
    telemetryRecordInputs: boolean("telemetry_record_inputs").notNull().default(false),
    telemetryRecordOutputs: boolean("telemetry_record_outputs").notNull().default(false),
    /** Days to keep captured requests; null keeps them until deleted. */
    telemetryRetentionDays: integer("telemetry_retention_days"),
    /** Opted-in built-in tool sets (`contracts/chatroom/tools`). */
    builtinToolSets: text("builtin_tool_sets").array().notNull().default([]),
    /** Default-on built-in tool sets switched off. */
    disabledBuiltinToolSets: text("disabled_builtin_tool_sets").array().notNull().default([]),
    /** Worker tools preselected when a Worker is picked for a new chat. */
    workerTools: text("worker_tools").array().notNull().default([]),
    /** Gateway routing strategy, session affinity, retry and cooldown; null means the defaults. */
    routing: json<RoutingSettings>("routing"),
    /** Usage-limit alert thresholds; null means the defaults. */
    limits: json<LimitSettings>("limits"),
    /**
     * Chatroom system prompt switches. `modelIdentity` only applies while `enabled` is on; it
     * is kept when the prompt is off so switching the prompt back on restores the choice.
     */
    systemPromptEnabled: boolean("system_prompt_enabled").notNull().default(true),
    systemPromptModelIdentity: boolean("system_prompt_model_identity").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "workspace_settings_telemetry_content",
      sql`${table.telemetryEnabled} or not (${table.telemetryRecordInputs} or ${table.telemetryRecordOutputs})`,
    ),
    check(
      "workspace_settings_telemetry_retention",
      sql`${table.telemetryRetentionDays} is null or ${table.telemetryRetentionDays} >= 1`,
    ),
    check(
      "workspace_settings_worker_tools",
      sql`${table.workerTools} <@ ${sql.raw(`array[${WORKER_TOOLS.map((tool) => `'${tool}'`).join(", ")}]::text[]`)}`,
    ),
    // One settings row per workspace; also every settings read (workspace defaults, limit
    // thresholds, routing settings, telemetry capture). The retention job scans the whole
    // table, one small row per workspace, so `telemetry_retention_days` has no index.
    uniqueIndex("workspace_settings_workspace").on(table.workspace),
  ],
);

/**
 * The workspace's default MCP servers. Both sides cascade: deleting a server drops it from every
 * default list, and the set is unordered. The composite key keeps a listed server inside the
 * workspace.
 */
export const workspaceMcpServers = pgTable(
  "workspace_mcp_servers",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    mcpServer: text("mcp_server").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "workspace_mcp_servers_mcp_server_fk",
      columns: [table.workspace, table.mcpServer],
      foreignColumns: [mcpServers.workspace, mcpServers.id],
    }).onDelete("cascade"),
    // A server is listed once per workspace; the workspace's default servers; server deletion.
    uniqueIndex("workspace_mcp_servers_workspace_server").on(table.workspace, table.mcpServer),
  ],
);

/**
 * Folder-like grouping of chats inside a workspace. Any member may read and create Projects; the
 * creator and the workspace owner manage them. Deleting a Project detaches its chats (their
 * `project` is set null); chat privacy is still decided per chat. A Project's Worker working
 * directories are in {@link projectFolders}.
 */
export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Better Auth user id of the creator. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    color: text("color"),
    icon: text("icon"),
    legacyContent: json<LegacyBox>("legacy_content"),
    createdAt: createdAt(),
  },
  (table) => [
    // A workspace's Projects (projects.list sorts the at most 200 by name).
    index("projects_workspace").on(table.workspace),
  ],
);

/**
 * One Worker's absolute working directory for chats in a Project; owner-set, at most one per
 * Worker and Project. `isDefault` marks the Worker picked for a new chat in the Project (at most
 * one, and by being a row it is always one of the Project's folders).
 */
export const projectFolders = pgTable(
  "project_folders",
  {
    id: id(),
    project: text("project")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    directory: text("directory").notNull(),
    /** Order the owner arranged the folders in; the editor shows them in this order. */
    position: integer("position").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    check("project_folders_directory", sql`${table.directory} <> ''`),
    check("project_folders_position", sql`${table.position} >= 0`),
    // One folder per Worker in a Project; also a Project's folders (project list, a chat's
    // folder for its Worker) and the cascade from `projects`.
    uniqueIndex("project_folders_project_worker").on(table.project, table.worker),
    uniqueIndex("project_folders_project_position").on(table.project, table.position),
    // At most one default Worker per Project.
    uniqueIndex("project_folders_one_default")
      .on(table.project)
      .where(sql`${table.isDefault}`),
    // ACP session catalog: which Project owns a (Worker, directory) pair (acp.browser
    // projectFolders); also the cascade from `workers`.
    index("project_folders_worker_directory").on(table.worker, table.directory),
  ],
);

/**
 * Per-user interface preferences. They follow the user across workspaces and never grant model
 * access: pickers still list only workspace-configured models. Pinned and hidden lists keep
 * insertion order.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pinnedModels: text("pinned_models").array().notNull().default([]),
    hiddenModels: text("hidden_models").array().notNull().default([]),
    /** Categories switched off or silenced; null means every default. */
    notifications: json<StoredNotificationPreferences>("notifications"),
    createdAt: createdAt(),
  },
  (table) => [
    // One row per user; also the preferences read and the notification producer's lookup.
    uniqueIndex("user_preferences_user").on(table.userId),
  ],
);
