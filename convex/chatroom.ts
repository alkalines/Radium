import { v } from "convex/values";
import { BUILTIN_TOOL_SETS, WEB_SEARCH_TOOL_ID } from "@/utils/chatroom/tools";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { requireOwnedBalance } from "./keys";

/**
 * Chatroom tool configuration: the per-user default tool selection and the
 * per-chat override. A "selection" is which built-in tool sets and which MCP
 * servers are active. Chats without an override inherit the user's defaults.
 *
 * The chat HTTP handler resolves a chat's effective selection (and the secrets
 * it needs) via {@link resolveChatTools}.
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

/**
 * Sanitise a client-supplied selection against `balance`: drop unknown built-in
 * ids and any MCP server that does not belong to the balance. Keeps stored
 * selections from drifting to invalid or cross-tenant references.
 */
async function sanitizeSelection(
  ctx: MutationCtx,
  balance: Id<"balances">,
  selection: ToolSelection,
): Promise<ToolSelection> {
  const builtinToolSets = selection.builtinToolSets.filter((id) => VALID_BUILTIN_IDS.has(id));

  const mcpServers: Id<"mcp_servers">[] = [];
  for (const serverId of selection.mcpServers) {
    const server = await ctx.db.get("mcp_servers", serverId);
    if (server && server.balance === balance) mcpServers.push(serverId);
  }

  return { builtinToolSets, mcpServers };
}

/** Read the user's default tool selection for a balance. */
export const getToolDefaults = query({
  args: { balance: v.id("balances") },
  handler: async (ctx, args): Promise<ToolSelection> => {
    await requireOwnedBalance(ctx, args.balance);

    const row = await ctx.db
      .query("chatroom_tool_defaults")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .unique();

    if (!row) return EMPTY_SELECTION;
    return { builtinToolSets: row.builtinToolSets, mcpServers: row.mcpServers };
  },
});

/** Replace the user's default tool selection for a balance. */
export const setToolDefaults = mutation({
  args: { balance: v.id("balances"), selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);
    const selection = await sanitizeSelection(ctx, args.balance, args.selection);

    const existing = await ctx.db
      .query("chatroom_tool_defaults")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .unique();

    if (existing) {
      await ctx.db.patch("chatroom_tool_defaults", existing._id, selection);
      return existing._id;
    }
    return await ctx.db.insert("chatroom_tool_defaults", { balance: args.balance, ...selection });
  },
});

/**
 * The effective tool selection for a chat: its own override when present,
 * otherwise the user's defaults. `source` tells the UI whether toggling will
 * create a per-chat override or is still reflecting the defaults.
 */
export const getChatTools = query({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (
    ctx,
    args,
  ): Promise<ToolSelection & { source: "chat" | "defaults" }> => {
    const chat = await requireOwnedChat(ctx, args.chatId);
    if (chat.tools) return { ...chat.tools, source: "chat" };

    const defaults = await resolveDefaults(ctx, chat.balance);
    return { ...defaults, source: "defaults" };
  },
});

/** Set (or clear) a chat's per-chat tool override. */
export const setChatTools = mutation({
  args: { chatId: v.id("aisdk_chats"), selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    const chat = await requireOwnedChat(ctx, args.chatId);
    const selection = await sanitizeSelection(ctx, chat.balance, args.selection);
    await ctx.db.patch("aisdk_chats", args.chatId, { tools: selection });
  },
});

async function resolveDefaults(
  ctx: QueryCtx,
  balance: Id<"balances">,
): Promise<ToolSelection> {
  const defaults = await ctx.db
    .query("chatroom_tool_defaults")
    .withIndex("by_balance", (q) => q.eq("balance", balance))
    .unique();
  if (!defaults) return EMPTY_SELECTION;
  return { builtinToolSets: defaults.builtinToolSets, mcpServers: defaults.mcpServers };
}

/**
 * Resolve a chat's effective tool selection into something the HTTP handler can
 * act on: the enabled built-in ids plus the full (still-encrypted) MCP server
 * records. Secrets are decrypted by the caller at request time, never here.
 */
export const resolveChatTools = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return { builtinToolSets: [] as string[], mcpServers: [] as ResolvedMcpServer[] };

    const selection = chat.tools ?? (await resolveDefaults(ctx, chat.balance));

    const mcpServers: ResolvedMcpServer[] = [];
    for (const serverId of selection.mcpServers) {
      const server = await ctx.db.get("mcp_servers", serverId);
      if (!server || server.balance !== chat.balance) continue;
      mcpServers.push({
        _id: server._id,
        name: server.name,
        url: server.url,
        transport: server.transport,
        auth: server.auth,
        encrypted: server.encrypted,
      });
    }

    return { builtinToolSets: selection.builtinToolSets, mcpServers };
  },
});

/**
 * Resolve the Web Search tool's runtime needs for a chat: whether it is enabled
 * in the chat's effective selection, and the balance's still-encrypted Exa
 * credential record (decrypted by the caller at request time, never here).
 */
export const resolveWebSearch = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    enabled: boolean;
    exaEncrypted: Doc<"exa_credentials">["encrypted"] | null;
  }> => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return { enabled: false, exaEncrypted: null };

    const selection = chat.tools ?? (await resolveDefaults(ctx, chat.balance));
    const enabled = selection.builtinToolSets.includes(WEB_SEARCH_TOOL_ID);
    if (!enabled) return { enabled: false, exaEncrypted: null };

    const credential = await ctx.db
      .query("exa_credentials")
      .withIndex("by_balance", (q) => q.eq("balance", chat.balance))
      .unique();

    return { enabled, exaEncrypted: credential?.encrypted ?? null };
  },
});

type ResolvedMcpServer = {
  _id: Id<"mcp_servers">;
  name: string;
  url: string;
  transport: Doc<"mcp_servers">["transport"];
  auth: Doc<"mcp_servers">["auth"];
  encrypted: Doc<"mcp_servers">["encrypted"];
};
