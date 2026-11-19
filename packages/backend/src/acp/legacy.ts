import { v } from "convex/values";
import { query } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireAccessibleChat, requireOwnedWorkspace } from "../../convex/workspaces";

/** Read a historical sidecar only; this endpoint cannot claim, answer, retry or execute it. */
export const HistoricalRelayContent = query({
  args: { record: v.union(v.id("acp_commands"), v.id("acp_interactions"), v.id("worker_tasks"), v.id("worker_chat_calls"), v.id("worker_agents")) },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return null;
    const row = await ctx.db.get(args.record);
    if (!row?.legacyContent) return null;
    const table = ["acp_commands", "acp_interactions", "worker_tasks", "worker_chat_calls", "worker_agents"] as const;
    const source = table.find((name) => ctx.db.normalizeId(name, args.record) !== null);
    if (!source) return null;
    const chatId = "chat" in row ? row.chat : "chatId" in row ? row.chatId : undefined;
    if ("by" in row && row.by !== identity._id) return null;
    if (chatId) await requireAccessibleChat(ctx, chatId);
    else if ("editOwnerId" in row) {
      if (row.editOwnerId !== identity._id) return null;
    } else if (!("by" in row)) await requireOwnedWorkspace(ctx, row.workspace);
    return { table: source, record: row._id, workspace: row.workspace, chatId, historical: true as const, legacyContent: row.legacyContent };
  },
});
