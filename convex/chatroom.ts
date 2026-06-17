import { v } from "convex/values";
import { BUILTIN_TOOL_SETS, WEB_SEARCH_TOOL_ID } from "@/utils/chatroom/tools";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { requireUserId } from "./keys";

/**
 * Chatroom configuration, keyed by BetterAuth user. A user has a single
 * {@link chatroom_settings} row holding their default model and default tool
 * "selection" (which built-in tool sets and MCP servers are active). Chats
 * without a per-chat tool override inherit those defaults.
 *
 * The chat HTTP handler resolves a chat's effective selection via
 * {@link resolveChatTools}; runtime secrets are loaded from Secret Store by the
 * action that needs them.
 */

const VALID_BUILTIN_IDS = new Set<string>(BUILTIN_TOOL_SETS.map((toolSet) => toolSet.id));

const toolSelectionValidator = v.object({
  builtinToolSets: v.array(v.string()),
  mcpServers: v.array(v.id("mcp_servers")),
});

type ToolSelection = {
  builtinToolSets: string[];
  mcpServers: Id<"mcp_servers">[];
};

const EMPTY_SELECTION: ToolSelection = { builtinToolSets: [], mcpServers: [] };

/** Load a chat and assert it belongs to the signed-in user. */
async function requireOwnedChat(ctx: QueryCtx | MutationCtx, chatId: Id<"aisdk_chats">) {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");

  const chat = await ctx.db.get("aisdk_chats", chatId);
  if (!chat || chat.userId !== identity._id) throw new Error("Chat not found.");
  return chat;
}

/** Read the signed-in user's settings row, if any. */
function settingsForUser(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query("chatroom_settings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * Sanitise a client-supplied selection against `userId`: drop unknown built-in
 * ids and any MCP server that does not belong to the user. Keeps stored
 * selections from drifting to invalid or cross-tenant references.
 */
async function sanitizeSelection(
  ctx: MutationCtx,
  userId: string,
  selection: ToolSelection,
): Promise<ToolSelection> {
  const builtinToolSets = selection.builtinToolSets.filter((id) => VALID_BUILTIN_IDS.has(id));

  const mcpServers: Id<"mcp_servers">[] = [];
  for (const serverId of selection.mcpServers) {
    const server = await ctx.db.get("mcp_servers", serverId);
    if (server && server.userId === userId) mcpServers.push(serverId);
  }

  return { builtinToolSets, mcpServers };
}

/** Read the user's default tool selection. */
export const getToolDefaults = query({
  args: {},
  handler: async (ctx): Promise<ToolSelection> => {
    const userId = await requireUserId(ctx);
    const row = await settingsForUser(ctx, userId);
    if (!row) return EMPTY_SELECTION;
    return { builtinToolSets: row.builtinToolSets, mcpServers: row.mcpServers };
  },
});

/** Replace the user's default tool selection. */
export const setToolDefaults = mutation({
  args: { selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const selection = await sanitizeSelection(ctx, userId, args.selection);

    const existing = await settingsForUser(ctx, userId);
    if (existing) {
      await ctx.db.patch("chatroom_settings", existing._id, selection);
      return existing._id;
    }
    return await ctx.db.insert("chatroom_settings", { userId, ...selection });
  },
});

/**
 * Read the user's default model slug, or `null` if unset. The stored slug is
 * validated against the catalogue so a removed model never sticks as a phantom
 * default.
 */
export const getModelDefault = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const userId = await requireUserId(ctx);
    const row = await settingsForUser(ctx, userId);
    if (!row?.defaultModel) return null;

    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", row.defaultModel!))
      .unique();
    return model ? row.defaultModel : null;
  },
});

/** Set (or clear, when `model` is omitted) the user's default model slug. */
export const setModelDefault = mutation({
  args: { model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    if (args.model) {
      const model = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.model!))
        .unique();
      if (!model) throw new Error("Unknown model.");
    }

    const existing = await settingsForUser(ctx, userId);
    if (existing) {
      await ctx.db.patch("chatroom_settings", existing._id, { defaultModel: args.model });
      return existing._id;
    }
    return await ctx.db.insert("chatroom_settings", {
      userId,
      defaultModel: args.model,
      builtinToolSets: [],
      mcpServers: [],
    });
  },
});

/**
 * The effective tool selection for a chat: its own override when present,
 * otherwise the user's defaults. `source` tells the UI whether toggling will
 * create a per-chat override or is still reflecting the defaults.
 */
export const getChatTools = query({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args): Promise<ToolSelection & { source: "chat" | "defaults" }> => {
    const chat = await requireOwnedChat(ctx, args.chatId);
    if (chat.tools) return { ...chat.tools, source: "chat" };

    const defaults = await resolveDefaults(ctx, chat.userId);
    return { ...defaults, source: "defaults" };
  },
});

/** Set (or clear) a chat's per-chat tool override. */
export const setChatTools = mutation({
  args: { chatId: v.id("aisdk_chats"), selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    const chat = await requireOwnedChat(ctx, args.chatId);
    const selection = await sanitizeSelection(ctx, chat.userId, args.selection);
    await ctx.db.patch("aisdk_chats", args.chatId, { tools: selection });
  },
});

async function resolveDefaults(ctx: QueryCtx, userId: string): Promise<ToolSelection> {
  const defaults = await settingsForUser(ctx, userId);
  if (!defaults) return EMPTY_SELECTION;
  return { builtinToolSets: defaults.builtinToolSets, mcpServers: defaults.mcpServers };
}

/**
 * Resolve a chat's effective tool selection into something the HTTP handler can
 * act on: the enabled built-in ids plus the selected MCP server records.
 */
export const resolveChatTools = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return { builtinToolSets: [] as string[], mcpServers: [] as ResolvedMcpServer[] };

    const selection = chat.tools ?? (await resolveDefaults(ctx, chat.userId));

    const mcpServers: ResolvedMcpServer[] = [];
    for (const serverId of selection.mcpServers) {
      const server = await ctx.db.get("mcp_servers", serverId);
      if (!server || server.userId !== chat.userId) continue;
      mcpServers.push({
        _id: server._id,
        name: server.name,
        url: server.url,
        transport: server.transport,
        auth: server.auth,
      });
    }

    return { builtinToolSets: selection.builtinToolSets, mcpServers };
  },
});

/**
 * Resolve whether the Web Search tool is enabled for a chat and which balance
 * owns its Exa credential.
 */
export const resolveWebSearch = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    enabled: boolean;
    balance: Id<"balances"> | null;
  }> => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return { enabled: false, balance: null };

    const selection = chat.tools ?? (await resolveDefaults(ctx, chat.userId));
    const enabled = selection.builtinToolSets.includes(WEB_SEARCH_TOOL_ID);
    if (!enabled) return { enabled: false, balance: null };

    return { enabled, balance: chat.balance };
  },
});

type ResolvedMcpServer = {
  _id: Id<"mcp_servers">;
  name: string;
  url: string;
  transport: Doc<"mcp_servers">["transport"];
  auth: Doc<"mcp_servers">["auth"];
};
