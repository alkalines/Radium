import type { VirtualRowProps, WithoutVirtualProps } from "@tanstack/react-db";
import type { inferRouterOutputs } from "@trpc/server";
import {
  notificationCategory,
  notificationPath,
  notificationTitle,
  resolveNotificationPreferences,
  type NotificationKind,
  type NotificationPreferences,
  type StoredNotificationPreferences,
} from "contracts/notifications/contract";
import type { ChatWorkerTool } from "contracts/worker/chat-config";
import { toBase64Url } from "radium-crypto";
import type { AppRouter } from "server/router";

/**
 * The Electric shapes behind the synced collections (`packages/server/src/shapes/http.ts`): each
 * shape's UI row, its key, and how a shape row (snake_case columns) becomes that row. A mapping
 * depends on the row alone, so whichever Tab syncs a shape for the others (`lib/live-relay.ts`)
 * builds it from the shape's name and selector.
 */

/** A shape row as Electric sends it: snake_case columns, Postgres text for unparsed types. */
export type ShapeRow = Record<string, unknown>;

type Outputs = inferRouterOutputs<AppRouter>;

/** One notification as `notifications.recent` returns it. */
export type NotificationRow = Outputs["notifications"]["recent"][number];

/** The signed-in user's interface preferences (one `user_preferences` row). */
export type UserPreferences = {
  id: string;
  /** Model slugs shown first, in pin order. */
  pinnedModels: string[];
  /** Model slugs left out of pickers unless selected. */
  hiddenModels: string[];
  notifications: NotificationPreferences;
};

/** A workspace's Chatroom defaults every member reads (one `workspace_settings` row). */
export type WorkspaceSettings = {
  id: string;
  workspace: string;
  /** Stored default model; check it with `offeredModel` before using it. */
  defaultModel: string | null;
  /** Stored title model; check it with `offeredTitleModel` before using it. */
  titleModel: string | null;
  chainOfThought: boolean;
  systemPrompt: { enabled: boolean; modelIdentity: boolean };
  /** Worker tools preselected when a Worker is picked for a new chat. */
  workerTools: ChatWorkerTool[];
};

type ProjectSummary = Outputs["projects"]["list"][number];

/** A Project without its Worker folders. */
export type ProjectRow = Omit<ProjectSummary, "folders" | "defaultWorkerId"> & {
  /** Tie-break after the name: creation time, or the list position the server sorted by it. */
  order: number;
  /**
   * The creator, from the shape; `canManage` is then completed by the reader, who knows its own
   * role. `null` for rows from `projects.list`, whose `canManage` is final.
   */
  creator: string | null;
};

/** One owner-set Worker folder of a Project. */
export type FolderRow = {
  id: string;
  project: string;
  workerId: string;
  directory: string;
  position: number;
  isDefault: boolean;
};

type AcpSession = Outputs["acp"]["getSession"];

/**
 * The live lifecycle of an ACP chat's session, in `acp.getSession`'s field shapes: what the bound
 * Worker changes while a Tab watches. `getSession` supplies the rest (agent, defaults, warmth).
 */
export type AcpSessionLive = Pick<
  AcpSession,
  | "status"
  | "epoch"
  | "stream"
  | "stopReason"
  | "error"
  | "sealedError"
  | "binding"
  | "config"
  | "commands"
  | "usage"
  | "turnUsage"
  | "history"
> & { id: string; sessionId: string | null };

/** The UI row of each shape. */
export type ShapeRows = {
  notifications: NotificationRow;
  userPreferences: UserPreferences;
  workspaceSettings: WorkspaceSettings;
  projects: ProjectRow;
  projectFolders: FolderRow;
  acpSession: AcpSessionLive;
};

export type ShapeName = keyof ShapeRows;

/** A shape's selector (`/api/shapes/<shape>?workspace=` or `?chat=`). */
export type ShapeSelector = { workspace?: string; chat?: string };

type ShapeDefinition<T> = {
  getKey: (row: T) => string;
  fromShape: (row: ShapeRow) => T;
};

/** Every shape the server defines, by name. */
export const SHAPES: { [N in ShapeName]: ShapeDefinition<ShapeRows[N]> } = {
  notifications: {
    getKey: (row) => row.id,
    fromShape: (row) => {
      // The column's check constraint admits only notification kinds.
      const kind = text(row, "kind") as NotificationKind;
      const chat = nullableText(row, "chat");
      const sealedKeyId = nullableText(row, "sealed_key_id");
      const sealedBox = bytes(row, "sealed_box");
      return {
        id: text(row, "id"),
        kind,
        category: notificationCategory(kind),
        userId: text(row, "user_id"),
        sealed:
          sealedKeyId !== null && sealedBox !== null
            ? { keyId: sealedKeyId, box: sealedBox }
            : null,
        legacyContent: json<NotificationRow["legacyContent"]>(row, "legacy_content"),
        title: notificationTitle(kind),
        body: chat ? "Session" : "Workspace",
        path: notificationPath({ chat: chat ?? undefined }),
        workspace: nullableText(row, "workspace"),
        chat,
        createdAt: timestamp(row, "created_at"),
        claimed: row.seen_at != null,
        pushed: row.delivery_at != null,
      };
    },
  },
  userPreferences: {
    getKey: (row) => row.id,
    fromShape: (row) => ({
      id: text(row, "id"),
      pinnedModels: texts(row, "pinned_models"),
      hiddenModels: texts(row, "hidden_models"),
      notifications: resolveNotificationPreferences(
        json<StoredNotificationPreferences>(row, "notifications") ?? undefined,
      ),
    }),
  },
  workspaceSettings: {
    getKey: (row) => row.id,
    fromShape: (row) => ({
      id: text(row, "id"),
      workspace: text(row, "workspace"),
      defaultModel: nullableText(row, "default_model"),
      titleModel: nullableText(row, "title_model"),
      chainOfThought: row.enable_chain_of_thought !== false,
      systemPrompt: {
        enabled: row.system_prompt_enabled !== false,
        modelIdentity: row.system_prompt_model_identity !== false,
      },
      // The column's check constraint admits only Worker tool names.
      workerTools: texts(row, "worker_tools") as ChatWorkerTool[],
    }),
  },
  projects: {
    getKey: (row) => row.id,
    fromShape: (row) => ({
      id: text(row, "id") as ProjectRow["id"],
      name: text(row, "name"),
      color: nullableText(row, "color"),
      icon: nullableText(row, "icon"),
      legacyContent: json<ProjectRow["legacyContent"]>(row, "legacy_content"),
      canManage: false,
      creator: text(row, "user_id"),
      order: timestamp(row, "created_at"),
    }),
  },
  projectFolders: {
    getKey: (row) => row.id,
    fromShape: (row) => ({
      id: text(row, "id"),
      project: text(row, "project"),
      workerId: text(row, "worker"),
      directory: text(row, "directory"),
      position: nullableInt(row, "position") ?? 0,
      isDefault: row.is_default === true,
    }),
  },
  acpSession: {
    getKey: (row) => row.id,
    fromShape: (row) => {
      const epoch = nullableInt(row, "epoch") ?? 0;
      const cooledEpoch = nullableInt(row, "cooled_epoch") ?? 0;
      const sealedEpoch = nullableInt(row, "sealed_error_epoch");
      const sealedBox = bytes(row, "sealed_error_box");
      const binding = json<NonNullable<AcpSession["binding"]>>(row, "binding");
      return {
        id: text(row, "id"),
        sessionId: nullableText(row, "session_id"),
        // Columns constrained to `getSession`'s unions by the table's checks.
        status: text(row, "status") as AcpSession["status"],
        epoch,
        // The epoch stream is open from its start until cooling retires it.
        stream: epoch > 0 && epoch > cooledEpoch ? `c/${text(row, "chat")}/acp/${epoch}` : null,
        stopReason: nullableText(row, "stop_reason") as AcpSession["stopReason"],
        error: nullableText(row, "error"),
        sealedError:
          sealedEpoch !== null && sealedBox !== null
            ? { epoch: sealedEpoch, box: sealedBox }
            : null,
        binding: binding
          ? { version: binding.version, scope: binding.scope, members: binding.members }
          : null,
        config: json<AcpSession["config"]>(row, "config"),
        commands: json<AcpSession["commands"]>(row, "commands"),
        usage: json<AcpSession["usage"]>(row, "usage"),
        turnUsage: json<AcpSession["turnUsage"]>(row, "turn_usage"),
        history: nullableText(row, "history") as AcpSession["history"],
      };
    },
  },
};

/** One shape with its selector, as a string: `<shape>?<selector>`. */
export function shapeId(shape: ShapeName, selector: ShapeSelector): string {
  return `${shape}?${new URLSearchParams(selector)}`;
}

/** Shape `shape`'s key and row mapping, for code that holds rows of any shape. */
export function shapeDefinition(shape: ShapeName): ShapeDefinition<object> {
  // Each definition maps shape rows to its own row type and reads keys of that type only.
  return SHAPES[shape] as unknown as ShapeDefinition<object>;
}

/**
 * `row` without TanStack DB's `$`-prefixed row metadata, which collection and live query rows
 * carry, so they read like the tRPC answers they replace (and clone small between Tabs).
 */
export function plainRow<T extends object>(row: T): WithoutVirtualProps<T> {
  const {
    $hasPendingWrites: _pending,
    $origin: _origin,
    $key: _key,
    $collectionId: _collection,
    ...plain
  } = row as T & Partial<VirtualRowProps>;
  return plain as WithoutVirtualProps<T>;
}

/** The shape and selector of a {@link shapeId}, or `null` for anything else. */
export function parseShapeId(id: string): { shape: ShapeName; selector: ShapeSelector } | null {
  const [shape = "", query = ""] = id.split("?");
  if (!Object.hasOwn(SHAPES, shape)) return null;
  const params = new URLSearchParams(query);
  const selector: ShapeSelector = {};
  const workspace = params.get("workspace");
  const chat = params.get("chat");
  if (workspace) selector.workspace = workspace;
  if (chat) selector.chat = chat;
  // `Object.hasOwn` above checked the name.
  return { shape: shape as ShapeName, selector };
}

// --- Shape column readers -------------------------------------------------------------------
// Electric parses numbers, booleans, JSON and arrays; other types arrive as Postgres text.

function text(row: ShapeRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function nullableText(row: ShapeRow, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function nullableInt(row: ShapeRow, column: string): number | null {
  const value = row[column];
  return typeof value === "number" ? value : null;
}

function texts(row: ShapeRow, column: string): string[] {
  const value = row[column];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** A `json`/`jsonb` column, typed by the server's schema for it. */
function json<T>(row: ShapeRow, column: string): T | null {
  return (row[column] ?? null) as T | null;
}

/** A `timestamptz` column (`2026-11-25 20:39:13.123456+00`) in epoch milliseconds. */
export function timestamp(row: ShapeRow, column: string): number {
  const value = text(row, column)
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d\d)$/, "$1:00");
  return Date.parse(value);
}

/** A `bytea` column (`\x` hex text) as base64url, how tRPC sends bytes; null when absent. */
export function bytes(row: ShapeRow, column: string): string | null {
  const value = nullableText(row, column);
  if (value === null || !value.startsWith("\\x")) return null;
  const data = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < data.length; index++) {
    data[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return toBase64Url(data);
}
