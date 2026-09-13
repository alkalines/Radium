import { v } from "convex/values";
import { BUILTIN_TOOL_SETS, WEB_SEARCH_TOOL_ID } from "@/utils/chatroom/tools";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireAccessibleChat,
  resolveWorkspaceForChat,
  requireOwnedWorkspace,
} from "./workspaces";
import { isWorkspaceProviderEnabled, workspaceProviderRecords } from "./provider_records";

/**
 * Workspace Chatroom configuration replaces the legacy per-user
 * {@link chatroom_settings} row holding default models and tool selections
 * (which built-in tool sets and MCP servers are active). Chats without a
 * per-chat tool override inherit the active workspace defaults.
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

/** Load a chat and apply its explicit personal/workspace ownership policy. */
async function requireOwnedChat(ctx: QueryCtx | MutationCtx, chatId: Id<"aisdk_chats">) {
  return (await requireAccessibleChat(ctx, chatId)).chat;
}

/** Read workspace settings, falling back to the legacy per-user row during migration. */
async function settingsForWorkspace(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">) {
  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace) return null;
  const current = await ctx.db
    .query("workspace_settings")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspaceId))
    .first();
  if (current) return current;

  return await ctx.db
    .query("chatroom_settings")
    .withIndex("by_userId", (q) => q.eq("userId", workspace.ownerId))
    .first();
}

async function requireSettingsWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
) {
  return await requireOwnedWorkspace(ctx, workspaceId);
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
  workspaceId: Id<"workspaces">,
): Promise<ToolSelection> {
  const builtinToolSets = selection.builtinToolSets.filter((id) => VALID_BUILTIN_IDS.has(id));

  const mcpServers: Id<"mcp_servers">[] = [];
  for (const serverId of selection.mcpServers) {
    const server = await ctx.db.get("mcp_servers", serverId);
    if (
      server &&
      server.userId === userId &&
      (server.workspace === undefined || server.workspace === workspaceId)
    ) {
      mcpServers.push(serverId);
    }
  }

  return { builtinToolSets, mcpServers };
}

/** Read the user's default tool selection. */
export const getToolDefaults = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<ToolSelection> => {
    await requireSettingsWorkspace(ctx, args.workspace);
    const row = await settingsForWorkspace(ctx, args.workspace);
    if (!row) return EMPTY_SELECTION;
    return { builtinToolSets: row.builtinToolSets, mcpServers: row.mcpServers };
  },
});

/** Replace the user's default tool selection. */
export const setToolDefaults = mutation({
  args: { workspace: v.id("workspaces"), selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    const workspace = await requireSettingsWorkspace(ctx, args.workspace);
    const selection = await sanitizeSelection(
      ctx,
      workspace.ownerId,
      args.selection,
      args.workspace,
    );

    const existing = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .first();
    if (existing) {
      await ctx.db.patch("workspace_settings", existing._id, selection);
      return existing._id;
    }
    return await ctx.db.insert("workspace_settings", {
      workspace: args.workspace,
      builtinToolSets: selection.builtinToolSets,
      mcpServers: selection.mcpServers,
    });
  },
});

/**
 * Read the user's default model slug, or `null` if unset. The stored slug is
 * validated against the catalogue so a removed model never sticks as a phantom
 * default.
 */
export const getModelDefault = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<string | null> => {
    const workspace = await requireSettingsWorkspace(ctx, args.workspace);
    const row = await settingsForWorkspace(ctx, args.workspace);
    if (!row?.defaultModel) return null;

    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", row.defaultModel!))
      .unique();
    return model && (await workspaceHasModel(ctx, workspace, row.defaultModel))
      ? row.defaultModel
      : null;
  },
});

/** Set (or clear, when `model` is omitted) the user's default model slug. */
export const setModelDefault = mutation({
  args: { workspace: v.id("workspaces"), model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const workspace = await requireSettingsWorkspace(ctx, args.workspace);

    if (args.model) {
      const model = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.model!))
        .unique();
      if (!model) throw new Error("Unknown model.");
      if (!(await workspaceHasModel(ctx, workspace, args.model))) {
        throw new Error("Model is not configured for this workspace.");
      }
    }

    const existing = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .first();
    if (existing) {
      await ctx.db.patch("workspace_settings", existing._id, { defaultModel: args.model });
      return existing._id;
    }
    return await ctx.db.insert("workspace_settings", {
      workspace: workspace._id,
      defaultModel: args.model,
      builtinToolSets: [],
      mcpServers: [],
    });
  },
});

/** Read the user's title-generator model slug, or `null` if unset/removed. */
export const getTitleModelDefault = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<string | null> => {
    const workspace = await requireSettingsWorkspace(ctx, args.workspace);
    const row = await settingsForWorkspace(ctx, args.workspace);
    if (!row?.titleModel) return null;

    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", row.titleModel!))
      .unique();
    return isTitleGenerationModel(model) &&
      (await workspaceHasModel(ctx, workspace, row.titleModel))
      ? row.titleModel
      : null;
  },
});

/** Set (or clear, when `model` is omitted) the title-generator model slug. */
export const setTitleModelDefault = mutation({
  args: { workspace: v.id("workspaces"), model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const workspace = await requireSettingsWorkspace(ctx, args.workspace);

    if (args.model) {
      const model = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.model!))
        .unique();
      if (!isTitleGenerationModel(model)) throw new Error("Unknown title model.");
      if (!(await workspaceHasModel(ctx, workspace, args.model))) {
        throw new Error("Title model is not configured for this workspace.");
      }
    }

    const existing = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .first();
    if (existing) {
      await ctx.db.patch("workspace_settings", existing._id, { titleModel: args.model });
      return existing._id;
    }
    return await ctx.db.insert("workspace_settings", {
      workspace: workspace._id,
      titleModel: args.model,
      builtinToolSets: [],
      mcpServers: [],
    });
  },
});

/** Read whether reasoning and tool activity use the combined Chain of Thought UI. */
export const getChainOfThoughtEnabled = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<boolean> => {
    await requireSettingsWorkspace(ctx, args.workspace);
    const row = await settingsForWorkspace(ctx, args.workspace);
    return row?.enableChainOfThought ?? true;
  },
});

/** Set whether reasoning and tool activity use the combined Chain of Thought UI. */
export const setChainOfThoughtEnabled = mutation({
  args: { workspace: v.id("workspaces"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const workspace = await requireSettingsWorkspace(ctx, args.workspace);
    const existing = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .first();
    if (existing) {
      await ctx.db.patch("workspace_settings", existing._id, {
        enableChainOfThought: args.enabled,
      });
      return existing._id;
    }
    return await ctx.db.insert("workspace_settings", {
      workspace: workspace._id,
      enableChainOfThought: args.enabled,
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

    const workspace = await resolveWorkspaceForChat(ctx, chat);
    const defaults = workspace ? await resolveDefaults(ctx, workspace._id) : EMPTY_SELECTION;
    return { ...defaults, source: "defaults" };
  },
});

/** Set (or clear) a chat's per-chat tool override. */
export const setChatTools = mutation({
  args: { chatId: v.id("aisdk_chats"), selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    const chat = await requireOwnedChat(ctx, args.chatId);
    const workspace = await resolveWorkspaceForChat(ctx, chat);
    if (!workspace) throw new Error("Chat workspace not found.");
    const selection = await sanitizeSelection(ctx, chat.userId, args.selection, workspace._id);
    await ctx.db.patch("aisdk_chats", args.chatId, { tools: selection });
  },
});

async function resolveDefaults(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<ToolSelection> {
  const defaults = await settingsForWorkspace(ctx, workspaceId);
  if (!defaults) return EMPTY_SELECTION;
  return { builtinToolSets: defaults.builtinToolSets, mcpServers: defaults.mcpServers };
}

async function workspaceHasModel(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  modelSlug: string,
) {
  const records = await workspaceProviderRecords(ctx, workspace);
  return records.some(
    (record) =>
      isWorkspaceProviderEnabled(record) &&
      record.provider.models.some((model) => model.model === modelSlug),
  );
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

    const workspace = await resolveWorkspaceForChat(ctx, chat);
    if (!workspace) return { builtinToolSets: [], mcpServers: [] };
    const selection = chat.tools ?? (await resolveDefaults(ctx, workspace._id));

    const mcpServers: ResolvedMcpServer[] = [];
    for (const serverId of selection.mcpServers) {
      const server = await ctx.db.get("mcp_servers", serverId);
      if (
        !server ||
        server.userId !== chat.userId ||
        (workspace && server.workspace !== undefined && server.workspace !== workspace._id)
      ) {
        continue;
      }
      mcpServers.push({
        _id: server._id,
        workspace: workspace._id,
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
 * Resolve whether the Web Search tool is enabled for a chat and which workspace
 * owns its Exa credential.
 */
export const resolveWebSearch = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    enabled: boolean;
    workspace: Id<"workspaces"> | null;
  }> => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return { enabled: false, workspace: null };

    const workspace = await resolveWorkspaceForChat(ctx, chat);
    if (!workspace) return { enabled: false, workspace: null };
    const selection = chat.tools ?? (await resolveDefaults(ctx, workspace._id));
    const enabled = selection.builtinToolSets.includes(WEB_SEARCH_TOOL_ID);
    if (!enabled) return { enabled: false, workspace: null };

    return { enabled, workspace: workspace._id };
  },
});

type ResolvedMcpServer = {
  _id: Id<"mcp_servers">;
  workspace: Id<"workspaces">;
  name: string;
  url: string;
  transport: Doc<"mcp_servers">["transport"];
  auth: Doc<"mcp_servers">["auth"];
};

function isTitleGenerationModel(model: Doc<"models"> | null) {
  return (
    model?.type === "chat" &&
    model.architecture.input_modalities.includes("text") &&
    model.architecture.output_modalities.includes("text")
  );
}
