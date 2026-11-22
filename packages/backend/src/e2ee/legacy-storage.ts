import { v } from "convex/values";
import { query } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import type { Id, TableNames } from "../../convex/_generated/dataModel";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import { requireWorkspaceAccessForUser, requireWorkspaceOwnedByUser, authorizeChatRecord } from "../../convex/workspaces";
import { readMigrationState } from "./migration-contract";

const historicalAccess: Record<string, "chat" | "owner" | "member" | "notification"> = {
  aisdk_chats: "chat", chat_messages: "chat", chat_files: "chat", chat_frames: "chat",
  acp_sessions: "chat", acp_commands: "chat", acp_interactions: "chat", worker_chat_calls: "chat",
  acp_agent_sessions: "owner", worker_tasks: "chat", worker_agents: "owner",
  telemetry_blobs: "owner", telemetry_nodes: "owner", telemetry_requests: "owner",
  telemetry_traces: "owner", telemetry_spans: "owner", telemetry_payloads: "owner",
  notifications: "notification", projects: "member", workspaces: "member",
};

type HistoricalRow = {
  _id: string; legacyContent?: LegacyBox; userId?: string;
  workspace?: Id<"workspaces">; chat?: Id<"aisdk_chats">; chatId?: Id<"aisdk_chats">;
  trace?: Id<"telemetry_traces">;
  by?: string; editOwnerId?: string;
};

/** Resolves only the envelope attached to an authorized source row, never arbitrary storage IDs. */
export const storageUrl = query({
  args: { table: v.string(), record: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");
    const access = Object.hasOwn(historicalAccess, args.table) ? historicalAccess[args.table] : undefined;
    if (!access) throw new Error("Invalid historical table");
    const table = args.table as TableNames;
    const id = ctx.db.normalizeId(table, args.record);
    if (!id) return null;
    // The table allowlist and Convex schema establish the shared routing fields of these records.
    const row = await ctx.db.get(table, id) as unknown as HistoricalRow | null;
    if (!row?.legacyContent?.storageId) return null;
    if (args.table === "acp_commands" && row.by !== identity._id) throw new Error("Not authorized.");
    let workspace = args.table === "workspaces" ? row._id as Id<"workspaces"> : row.workspace;
    let chatId = args.table === "aisdk_chats" ? row._id as Id<"aisdk_chats"> : row.chat ?? row.chatId;
    if (row.trace) {
      const trace = await ctx.db.get("telemetry_traces", row.trace);
      workspace ??= trace?.workspace;
      chatId ??= trace?.chatId;
    }
    if (access === "notification") {
      if (row.userId !== identity._id) throw new Error("Not authorized.");
    } else {
      if (chatId) {
        const authorized = await authorizeChatRecord(ctx, chatId, identity._id);
        if (!authorized) throw new Error("Not authorized.");
        workspace ??= authorized.workspace._id;
      }
      if (args.table === "worker_tasks" && !chatId) {
        if (row.editOwnerId !== identity._id) throw new Error("Not authorized.");
      } else if (args.table === "chat_files" && !chatId) {
        if (row.userId !== identity._id) throw new Error("Not authorized.");
      } else {
        if (!workspace) throw new Error("Historical ownership is missing");
        if (access === "owner" || (access === "chat" && !chatId)) await requireWorkspaceOwnedByUser(ctx, workspace, identity._id);
        else await requireWorkspaceAccessForUser(ctx, workspace, identity._id);
      }
    }
    return ctx.storage.getUrl(row.legacyContent.storageId);
  },
});

/** Client gate reveals only rollout state, never custody keys, row counts or other users' data. */
export const cutoverState = query({
  args: {},
  returns: v.union(v.null(), v.object({ frozen: v.boolean(), requiresEncryption: v.boolean() })),
  handler: async (ctx) => {
    if (!await authComponent.getAuthUser(ctx)) return null;
    const state = await readMigrationState(ctx);
    return { frozen: state?.frozen ?? false, requiresEncryption: state?.cutoverComplete ?? false };
  },
});
