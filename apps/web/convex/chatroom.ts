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
  getDefaultWorkspaceForUser,
  requireAccessibleChat,
  requireOwnedWorkspace,
  resolveWorkspaceForChat,
  requireWorkspaceAccess,
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

export type EffectiveWorkspaceSettings = {
  workspace: Id<"workspaces">;
  defaultModel?: string;
  titleModel?: string;
  enableChainOfThought?: boolean;
  telemetry?: NonNullable<Doc<"workspace_settings">["telemetry"]>;
  builtinToolSets: string[];
  mcpServers: Id<"mcp_servers">[];
};

export type WorkspaceSettingsOverrides = Partial<
  Pick<
    EffectiveWorkspaceSettings,
    | "defaultModel"
    | "titleModel"
    | "enableChainOfThought"
    | "telemetry"
    | "builtinToolSets"
    | "mcpServers"
  >
>;

async function workspaceSettingsRow(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">) {
  const current = await ctx.db
    .query("workspace_settings")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspaceId))
    .first();
  return current;
}

function settingsValue(
  workspace: Id<"workspaces">,
  settings:
    | Pick<
        EffectiveWorkspaceSettings,
        | "defaultModel"
        | "titleModel"
        | "enableChainOfThought"
        | "telemetry"
        | "builtinToolSets"
        | "mcpServers"
      >
    | null
    | undefined,
): EffectiveWorkspaceSettings {
  return {
    workspace,
    ...(settings?.defaultModel !== undefined ? { defaultModel: settings.defaultModel } : {}),
    ...(settings?.titleModel !== undefined ? { titleModel: settings.titleModel } : {}),
    ...(settings?.enableChainOfThought !== undefined
      ? { enableChainOfThought: settings.enableChainOfThought }
      : {}),
    ...(settings?.telemetry !== undefined ? { telemetry: settings.telemetry } : {}),
    builtinToolSets: settings?.builtinToolSets ?? [],
    mcpServers: settings?.mcpServers ?? [],
  };
}

/** Preserve all effective fields when a legacy settings row is materialized. */
export function materializeWorkspaceSettings(
  settings: EffectiveWorkspaceSettings,
  overrides: WorkspaceSettingsOverrides,
): EffectiveWorkspaceSettings {
  const defaultModel = "defaultModel" in overrides ? overrides.defaultModel : settings.defaultModel;
  const titleModel = "titleModel" in overrides ? overrides.titleModel : settings.titleModel;
  const enableChainOfThought =
    "enableChainOfThought" in overrides
      ? overrides.enableChainOfThought
      : settings.enableChainOfThought;
  const telemetry = "telemetry" in overrides ? overrides.telemetry : settings.telemetry;

  return {
    workspace: settings.workspace,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(titleModel !== undefined ? { titleModel } : {}),
    ...(enableChainOfThought !== undefined ? { enableChainOfThought } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    builtinToolSets: overrides.builtinToolSets ?? settings.builtinToolSets,
    mcpServers: overrides.mcpServers ?? settings.mcpServers,
  };
}

/** Read the effective workspace settings without letting legacy values bleed into other workspaces. */
export async function getEffectiveWorkspaceSettings(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
): Promise<EffectiveWorkspaceSettings> {
  const current = await workspaceSettingsRow(ctx, workspace._id);
  if (current) return settingsValue(workspace._id, current);

  const defaultWorkspace = await getDefaultWorkspaceForUser(ctx, workspace.ownerId);
  if (defaultWorkspace?._id !== workspace._id) {
    return settingsValue(workspace._id, undefined);
  }

  const legacy = await ctx.db
    .query("chatroom_settings")
    .withIndex("by_userId", (q) => q.eq("userId", workspace.ownerId))
    .first();
  return settingsValue(workspace._id, legacy);
}

/** Read workspace settings, using the legacy row only for the default workspace. */
async function settingsForWorkspace(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">) {
  const workspace = await ctx.db.get("workspaces", workspaceId);
  return workspace ? getEffectiveWorkspaceSettings(ctx, workspace) : null;
}

export function canManageChat(
  chat: Pick<Doc<"aisdk_chats">, "userId" | "scope">,
  workspace: Pick<Doc<"workspaces">, "ownerId">,
  userId: string,
): boolean {
  return chat.userId === userId || (chat.scope === "workspace" && workspace.ownerId === userId);
}

/** Require chat access before allowing creator or workspace-owner management actions. */
export async function requireChatManager(ctx: QueryCtx | MutationCtx, chatId: Id<"aisdk_chats">) {
  const access = await requireAccessibleChat(ctx, chatId);
  if (!canManageChat(access.chat, access.workspace, access.userId)) {
    throw new Error("Chat not found.");
  }
  return access;
}

/**
 * Sanitise a selection against the workspace. Legacy user-owned servers are
 * accepted only by the deterministic migration workspace.
 */
async function sanitizeSelection(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  selection: ToolSelection,
): Promise<ToolSelection> {
  const builtinToolSets = selection.builtinToolSets.filter((id) => VALID_BUILTIN_IDS.has(id));

  const defaultWorkspace = await getDefaultWorkspaceForUser(ctx, workspace.ownerId);
  const acceptsLegacyServers = defaultWorkspace?._id === workspace._id;
  const mcpServers: Id<"mcp_servers">[] = [];
  for (const serverId of selection.mcpServers) {
    const server = await ctx.db.get("mcp_servers", serverId);
    if (!server) continue;

    const workspaceServer = server.workspace === workspace._id;
    const legacyServer =
      acceptsLegacyServers && server.workspace === undefined && server.userId === workspace.ownerId;
    if (workspaceServer || legacyServer) mcpServers.push(serverId);
  }

  return { builtinToolSets, mcpServers };
}

/** Read the user's default tool selection. */
export const getToolDefaults = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<ToolSelection> => {
    const workspace = await requireWorkspaceAccess(ctx, args.workspace);
    return resolveDefaults(ctx, workspace);
  },
});

/** Replace the user's default tool selection. */
export const setToolDefaults = mutation({
  args: { workspace: v.id("workspaces"), selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const selection = await sanitizeSelection(ctx, workspace, args.selection);

    const existing = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .first();
    if (existing) {
      await ctx.db.patch("workspace_settings", existing._id, selection);
      return existing._id;
    }
    return await ctx.db.insert(
      "workspace_settings",
      materializeWorkspaceSettings(await getEffectiveWorkspaceSettings(ctx, workspace), selection),
    );
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
    const workspace = await requireWorkspaceAccess(ctx, args.workspace);
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
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);

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
    return await ctx.db.insert(
      "workspace_settings",
      materializeWorkspaceSettings(await getEffectiveWorkspaceSettings(ctx, workspace), {
        defaultModel: args.model,
      }),
    );
  },
});

/** Read the user's title-generator model slug, or `null` if unset/removed. */
export const getTitleModelDefault = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<string | null> => {
    const workspace = await requireWorkspaceAccess(ctx, args.workspace);
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
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);

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
    return await ctx.db.insert(
      "workspace_settings",
      materializeWorkspaceSettings(await getEffectiveWorkspaceSettings(ctx, workspace), {
        titleModel: args.model,
      }),
    );
  },
});

/** Read whether reasoning and tool activity use the combined Chain of Thought UI. */
export const getChainOfThoughtEnabled = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<boolean> => {
    await requireWorkspaceAccess(ctx, args.workspace);
    const row = await settingsForWorkspace(ctx, args.workspace);
    return row?.enableChainOfThought ?? true;
  },
});

/** Set whether reasoning and tool activity use the combined Chain of Thought UI. */
export const setChainOfThoughtEnabled = mutation({
  args: { workspace: v.id("workspaces"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
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
    return await ctx.db.insert(
      "workspace_settings",
      materializeWorkspaceSettings(await getEffectiveWorkspaceSettings(ctx, workspace), {
        enableChainOfThought: args.enabled,
      }),
    );
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
    const { chat, workspace } = await requireAccessibleChat(ctx, args.chatId);
    if (chat.tools) {
      const selection = await sanitizeSelection(ctx, workspace, chat.tools);
      return { ...selection, source: "chat" };
    }

    const defaults = await resolveDefaults(ctx, workspace);
    return { ...defaults, source: "defaults" };
  },
});

/** Set (or clear) a chat's per-chat tool override. */
export const setChatTools = mutation({
  args: { chatId: v.id("aisdk_chats"), selection: toolSelectionValidator },
  handler: async (ctx, args) => {
    const { workspace } = await requireChatManager(ctx, args.chatId);
    const selection = await sanitizeSelection(ctx, workspace, args.selection);
    await ctx.db.patch("aisdk_chats", args.chatId, { tools: selection });
  },
});

async function resolveDefaults(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
): Promise<ToolSelection> {
  const defaults = await settingsForWorkspace(ctx, workspace._id);
  if (!defaults) return EMPTY_SELECTION;
  return sanitizeSelection(ctx, workspace, {
    builtinToolSets: defaults.builtinToolSets,
    mcpServers: defaults.mcpServers,
  });
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
    const selection = chat.tools
      ? await sanitizeSelection(ctx, workspace, chat.tools)
      : await resolveDefaults(ctx, workspace);
    const defaultWorkspace = await getDefaultWorkspaceForUser(ctx, workspace.ownerId);
    const acceptsLegacyServers = defaultWorkspace?._id === workspace._id;

    const mcpServers: ResolvedMcpServer[] = [];
    for (const serverId of selection.mcpServers) {
      const server = await ctx.db.get("mcp_servers", serverId);
      if (!server) continue;

      const workspaceServer = server.workspace === workspace._id;
      const legacyServer =
        acceptsLegacyServers &&
        server.workspace === undefined &&
        server.userId === workspace.ownerId;
      if (!workspaceServer && !legacyServer) continue;

      mcpServers.push({
        _id: server._id,
        workspace: workspace._id,
        legacy: legacyServer,
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
    const selection = chat.tools
      ? await sanitizeSelection(ctx, workspace, chat.tools)
      : await resolveDefaults(ctx, workspace);
    const enabled = selection.builtinToolSets.includes(WEB_SEARCH_TOOL_ID);
    if (!enabled) return { enabled: false, workspace: null };

    return { enabled, workspace: workspace._id };
  },
});

type ResolvedMcpServer = {
  _id: Id<"mcp_servers">;
  workspace: Id<"workspaces">;
  legacy: boolean;
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
