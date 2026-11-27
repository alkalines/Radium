import type { Hono } from "hono";
import { chatAccess } from "../chatroom/access";
import { disableIdleTimeout } from "../gateway/http";
import type { Runtime } from "../runtime";
import { workspaceAccess } from "../workspaces/access";
import { isAcpChat } from "../acp/sessions";

type ShapeApp = Hono<{ Variables: { runtime: Runtime } }>;

/**
 * Electric shape proxy (`docs/Backend_Migration/Live_Data.md`, Electric Collections), on only
 * when `ELECTRIC_URL` is configured. Every shape is server-defined: the table, the columns and a
 * parameterized `where` come from here, after the same check the collection's tRPC query makes;
 * the client sends only Electric protocol parameters and the shape's own selector
 * (`workspace` or `chat`). Every live request passes here again, so lost access ends at the next
 * poll.
 */

/**
 * Electric protocol parameters a client may send. The on-demand `subset__*` parameters are left
 * out: a client-written predicate could probe columns its shape excludes.
 */
const PROTOCOL_PARAMETERS = [
  "live",
  "live_sse",
  "experimental_live_sse",
  "handle",
  "offset",
  "cursor",
  "expired_handle",
  "log",
  "cache-buster",
] as const;

type Shape = { table: string; columns: readonly string[]; where: string; params: string[] };

/** Workspace settings every member reads (Chatroom defaults, tool and prompt switches). */
const MEMBER_SETTINGS_COLUMNS = [
  "id",
  "workspace",
  "default_model",
  "title_model",
  "enable_chain_of_thought",
  "builtin_tool_sets",
  "disabled_builtin_tool_sets",
  "worker_tools",
  "system_prompt_enabled",
  "system_prompt_model_identity",
] as const;
/** Owner-only settings: telemetry capture, routing and limit thresholds. */
const OWNER_SETTINGS_COLUMNS = [
  ...MEMBER_SETTINGS_COLUMNS,
  "telemetry_enabled",
  "telemetry_record_inputs",
  "telemetry_record_outputs",
  "telemetry_retention_days",
  "routing",
  "limits",
] as const;

/**
 * The shape of `collection` for `userId`, or `null` when the collection is unknown or the caller
 * may not read it (both answered like a missing shape).
 */
async function shapeFor(
  runtime: Runtime,
  userId: string,
  collection: string,
  selector: URLSearchParams,
): Promise<Shape | null> {
  const { db } = runtime.drivers;
  const workspace = selector.get("workspace");
  const chat = selector.get("chat");

  if (collection === "notifications") {
    return {
      table: "notifications",
      columns: [
        "id",
        "kind",
        "user_id",
        "sealed_key_id",
        "sealed_box",
        "legacy_content",
        "workspace",
        "chat",
        "created_at",
        "seen_at",
        "delivery_at",
      ],
      where: "user_id = $1",
      params: [userId],
    };
  }
  if (collection === "userPreferences") {
    return {
      table: "user_preferences",
      columns: ["id", "user_id", "pinned_models", "hidden_models", "notifications"],
      where: "user_id = $1",
      params: [userId],
    };
  }

  if (collection === "workspaceSettings" || collection === "projects" || collection === "projectFolders") {
    if (!workspace) return null;
    const access = await workspaceAccess(db, userId, workspace);
    if (!access) return null;
    if (collection === "workspaceSettings") {
      return {
        table: "workspace_settings",
        columns: access.role === "owner" ? OWNER_SETTINGS_COLUMNS : MEMBER_SETTINGS_COLUMNS,
        where: "workspace = $1",
        params: [workspace],
      };
    }
    if (collection === "projects") {
      return {
        table: "projects",
        columns: ["id", "workspace", "user_id", "name", "color", "icon", "legacy_content", "created_at"],
        where: "workspace = $1",
        params: [workspace],
      };
    }
    // Worker folders are owner-only, as in `projects.list`.
    if (access.role !== "owner") return null;
    return {
      table: "project_folders",
      columns: ["id", "project", "workspace", "worker", "directory", "position", "is_default"],
      where: "workspace = $1",
      params: [workspace],
    };
  }

  if (collection === "acpSession") {
    if (!chat || !(await chatAccess(db, userId, chat)) || !(await isAcpChat(db, chat))) return null;
    return {
      table: "acp_sessions",
      columns: [
        "id",
        "chat",
        "workspace",
        "worker",
        "agent_id",
        "agent_version",
        "profile",
        "cwd",
        "session_id",
        "status",
        "epoch",
        "cooled_epoch",
        "stop_reason",
        "error",
        "config",
        "commands",
        "usage",
        "turn_usage",
        "history",
        "user_titled",
        "binding",
        "sealed_error_epoch",
        "sealed_error_box",
        "updated_at",
      ],
      where: "chat = $1",
      params: [chat],
    };
  }
  return null;
}

/** `GET /api/shapes/:collection`: see the module comment. `404` while Electric is off. */
export function mountShapeRoutes(app: ShapeApp) {
  app.get("/api/shapes/:collection", async (c) => {
    const runtime = c.var.runtime;
    const { ELECTRIC_URL, ELECTRIC_SECRET } = runtime.config;
    if (!ELECTRIC_URL || !ELECTRIC_SECRET) return c.json({ error: "Not found" }, 404);
    const request = c.req.raw;
    const session = await runtime.auth.api.getSession({ headers: request.headers });
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const incoming = new URL(request.url).searchParams;
    const shape = await shapeFor(runtime, session.user.id, c.req.param("collection"), incoming);
    if (!shape) return c.json({ error: "Not found" }, 404);

    const upstream = new URL("/v1/shape", ELECTRIC_URL);
    for (const name of PROTOCOL_PARAMETERS) {
      const value = incoming.get(name);
      if (value !== null && value.length <= 256) upstream.searchParams.set(name, value);
    }
    upstream.searchParams.set("table", shape.table);
    upstream.searchParams.set("columns", shape.columns.join(","));
    upstream.searchParams.set("where", shape.where);
    shape.params.forEach((value, index) => upstream.searchParams.set(`params[${index + 1}]`, value));
    upstream.searchParams.set("secret", ELECTRIC_SECRET);

    disableIdleTimeout(request);
    const response = await fetch(upstream, { signal: request.signal });
    const headers = new Headers(response.headers);
    // `fetch` already decoded the body; CORS headers do not apply to a same-origin route.
    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) {
      headers.delete(name);
    }
    for (const name of [...headers.keys()]) {
      if (name.startsWith("access-control-")) headers.delete(name);
    }
    // Per-user content: never stored by a shared cache.
    headers.set("cache-control", "private, no-store");
    headers.set("vary", "cookie");
    return new Response(response.body, { status: response.status, headers });
  });
}
