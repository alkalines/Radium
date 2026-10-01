import { v } from "convex/values";
import { BUILTIN_TOOL_SETS, WEB_SEARCH_TOOL_ID } from "@/chatroom/tools";
import {
  firstUserMessageText,
  generateChatTitle,
  isTitleGenerationModel,
  sanitizeTitle,
} from "@/chatroom/titles";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { createInternalGatewayProvider } from "./ai_gateway";
import {
  isGatewayCompletionWithoutChat,
  isOwnerManagedGatewayTrace,
} from "../src/workspaces/policy";
import {
  getDefaultWorkspaceForUser,
  requireAccessibleChat,
  loadWorkspaceSettings,
  requireChatManager,
  resolveWorkspaceForChat,
} from "./workspaces";
import { ownedWorkspaceMutation, workspaceQuery } from "./helpers";
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
export const getToolDefaults = workspaceQuery({
  args: {},
  handler: async (ctx): Promise<ToolSelection> => {
    return sanitizeSelection(ctx, ctx.workspace, ctx.workspace.settings);
  },
});

/** Replace the user's default tool selection. */
export const setToolDefaults = ownedWorkspaceMutation({
  args: { selection: toolSelectionValidator },
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    const selection = await sanitizeSelection(ctx, ctx.workspace, args.selection);

    return await ctx.workspace.updateSettings(selection);
  },
});

/**
 * Read the user's default model slug, or `null` if unset. The stored slug is
 * validated against the catalogue so a removed model never sticks as a phantom
 * default.
 */
export const getModelDefault = workspaceQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    if (!ctx.workspace.settings.defaultModel) return null;

    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", ctx.workspace.settings.defaultModel!))
      .unique();
    return model &&
      (await workspaceHasModel(ctx, ctx.workspace, ctx.workspace.settings.defaultModel))
      ? ctx.workspace.settings.defaultModel
      : null;
  },
});

/** Set (or clear, when `model` is omitted) the user's default model slug. */
export const setModelDefault = ownedWorkspaceMutation({
  args: { model: v.optional(v.string()) },
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    const workspace = ctx.workspace;

    if (args.model) {
      const model = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.model!))
        .unique();
      if (!model) throw new Error("Unknown model.");
      if (!(await workspaceHasModel(ctx, ctx.workspace, args.model))) {
        throw new Error("Model is not configured for this workspace.");
      }
    }

    return await workspace.updateSettings({ defaultModel: args.model });
  },
});

/** Read the user's title-generator model slug, or `null` if unset/removed. */
export const getTitleModelDefault = workspaceQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    if (!ctx.workspace.settings.titleModel) return null;

    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", ctx.workspace.settings.titleModel!))
      .unique();
    return isTitleGenerationModel(model) &&
      (await workspaceHasModel(ctx, ctx.workspace, ctx.workspace.settings.titleModel))
      ? ctx.workspace.settings.titleModel
      : null;
  },
});

/** Set (or clear, when `model` is omitted) the title-generator model slug. */
export const setTitleModelDefault = ownedWorkspaceMutation({
  args: { model: v.optional(v.string()) },
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    const workspace = ctx.workspace;

    if (args.model) {
      const model = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.model!))
        .unique();
      if (!isTitleGenerationModel(model)) throw new Error("Unknown title model.");
      if (!(await workspaceHasModel(ctx, ctx.workspace, args.model))) {
        throw new Error("Title model is not configured for this workspace.");
      }
    }

    return await workspace.updateSettings({ titleModel: args.model });
  },
});

/** Read whether reasoning and tool activity use the combined Chain of Thought UI. */
export const getChainOfThoughtEnabled = workspaceQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    return ctx.workspace.settings.enableChainOfThought ?? true;
  },
});

/** Set whether reasoning and tool activity use the combined Chain of Thought UI. */
export const setChainOfThoughtEnabled = ownedWorkspaceMutation({
  args: { enabled: v.boolean() },
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    return await ctx.workspace.updateSettings({ enableChainOfThought: args.enabled });
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
  const defaults = await loadWorkspaceSettings(ctx, workspace);
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

// Title generation

export const generateForChat = internalAction({
  args: { chatId: v.id("aisdk_chats"), force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.runQuery(internal.chatroom.titleGenerationInfo, {
      chatId: args.chatId,
    });
    if (!chat || (!args.force && chat.title) || !chat.initialUserMessage.trim()) return null;

    const provider = createInternalGatewayProvider(
      ctx,
      chat.workspace,
      () =>
        Response.json(
          { error: { message: "Internal gateway request failed", code: 500 } },
          { status: 500 },
        ),
      undefined,
      undefined,
      undefined,
      { userId: chat.userId, chatId: args.chatId },
    );

    try {
      const title = await generateChatTitle({
        model: provider(chat.model),
        initialUserMessage: chat.initialUserMessage,
      });
      await ctx.runMutation(internal.chatroom.saveGeneratedTitle, {
        chatId: args.chatId,
        force: args.force,
        ...title,
      });
    } catch (error) {
      console.error("Failed to generate chat title:", error);
    }

    return null;
  },
});

export const titleGenerationInfo = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.union(
    v.null(),
    v.object({
      workspace: v.id("workspaces"),
      userId: v.string(),
      initialUserMessage: v.string(),
      model: v.string(),
      title: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return null;

    const initialUserMessage = firstUserMessageText(chat);
    if (!initialUserMessage) return null;

    const workspace = await resolveWorkspaceForChat(ctx, chat);
    if (!workspace) return null;
    const settings = await loadWorkspaceSettings(ctx, workspace);

    const model = await firstAvailableModel(
      ctx,
      workspace,
      settings?.titleModel ?? settings?.defaultModel,
    );
    if (!model) return null;

    return {
      workspace: workspace._id,
      userId: chat.userId,
      initialUserMessage,
      model,
      title: chat.title,
    };
  },
});

export const saveGeneratedTitle = internalMutation({
  args: {
    chatId: v.id("aisdk_chats"),
    emoji: v.string(),
    title: v.string(),
    force: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat || (!args.force && chat.title)) return null;

    await ctx.db.patch("aisdk_chats", args.chatId, sanitizeTitle(args));
    return null;
  },
});

async function firstAvailableModel(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  preferred?: string,
) {
  if (workspace.archivedAt !== undefined) return null;
  const providerRecords = await workspaceProviderRecords(ctx, workspace);
  const isAvailable = (slug: string) =>
    providerRecords.some(
      (record) =>
        isWorkspaceProviderEnabled(record) &&
        record.provider.models.some((model) => model.model === slug),
    );

  if (preferred) {
    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", preferred))
      .unique();
    if (isTitleGenerationModel(model) && isAvailable(preferred)) return preferred;
  }

  const models = await ctx.db.query("models").take(200);
  return (
    models.find((model) => isTitleGenerationModel(model) && isAvailable(model.slug))?.slug ?? null
  );
}

// Chat visibility for Gateway usage, logs, and telemetry

type DatabaseCtx = QueryCtx | MutationCtx;

/** The attribution fields added to completions during the ownership rollout. */
export type AttributedCompletion = Doc<"chat_completions"> & {
  chatId?: Id<"aisdk_chats">;
  userId?: string;
};

type VisibilityCache = Map<string, boolean>;

function visibilityKey(workspaceId: Id<"workspaces">, chatId: Id<"aisdk_chats">) {
  return `${workspaceId}:${chatId}`;
}

/**
 * Resolve chat visibility through the same policy as Chatroom. Any missing,
 * deleted, cross-workspace, or malformed chat is intentionally invisible.
 */
export async function isChatVisibleToWorkspace(
  ctx: DatabaseCtx,
  workspaceId: Id<"workspaces">,
  chatId: Id<"aisdk_chats">,
  cache: VisibilityCache = new Map(),
): Promise<boolean> {
  const key = visibilityKey(workspaceId, chatId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let visible = false;
  try {
    const result = await requireAccessibleChat(ctx, chatId);
    const { chat, workspace } = result;
    const belongsToWorkspace = chat.workspace
      ? chat.workspace === workspaceId &&
        (chat.balance === undefined || chat.balance === workspace.legacyBalance)
      : chat.balance !== undefined && chat.balance === workspace.legacyBalance;
    visible = workspace._id === workspaceId && belongsToWorkspace;
  } catch {
    // A deleted or inaccessible chat must not turn into an observable row.
  }

  cache.set(key, visible);
  return visible;
}

/** A no-chat completion is visible only when its key proves it came from Gateway. */
export async function isCompletionVisible(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  completion: AttributedCompletion,
  cache: VisibilityCache = new Map(),
): Promise<boolean> {
  if (
    (completion.bill.workspace !== undefined && completion.bill.workspace !== workspace._id) ||
    (completion.bill.balance !== undefined &&
      completion.bill.balance !== workspace.legacyBalance) ||
    (completion.bill.workspace === undefined && completion.bill.balance === undefined)
  ) {
    return false;
  }
  if (completion.chatId !== undefined) {
    return await isChatVisibleToWorkspace(ctx, workspace._id, completion.chatId, cache);
  }

  // Internal Chatroom completions historically had neither key nor chat
  // attribution. Treat those rows as unknown rather than exposing private data.
  return isGatewayCompletionWithoutChat(completion);
}

/** Filter before callers derive counts, truncation, or cost aggregates. */
export async function filterVisibleCompletions(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  completions: AttributedCompletion[],
): Promise<AttributedCompletion[]> {
  const cache = new Map<string, boolean>();
  const visible: AttributedCompletion[] = [];
  for (const completion of completions) {
    if (await isCompletionVisible(ctx, workspace, completion, cache)) {
      visible.push(completion);
    }
  }
  return visible;
}

/**
 * Filter telemetry rows without allowing an un-attributed Chatroom trace to
 * become visible as a Gateway trace. A hidden Chatroom sibling also hides a
 * no-chat nested Gateway trace with the same request id.
 */
export async function filterVisibleTraces(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  traces: Doc<"telemetry_traces">[],
): Promise<Doc<"telemetry_traces">[]> {
  const cache = new Map<string, boolean>();
  const chatroomVisibilityByRequest = new Map<string, boolean>();

  for (const trace of traces) {
    if (trace.source !== "chatroom") continue;
    const visible =
      trace.chatId !== undefined &&
      (await isChatVisibleToWorkspace(ctx, workspace._id, trace.chatId, cache)) &&
      (await isTraceCompletionVisible(ctx, workspace, trace, cache));
    const previous = chatroomVisibilityByRequest.get(trace.requestId);
    chatroomVisibilityByRequest.set(
      trace.requestId,
      previous === undefined ? visible : previous && visible,
    );
  }

  const visible: Doc<"telemetry_traces">[] = [];
  for (const trace of traces) {
    if (!traceBelongsToWorkspace(trace, workspace)) continue;
    if (!(await isTraceCompletionVisible(ctx, workspace, trace, cache))) continue;
    if (trace.chatId !== undefined) {
      if (await isChatVisibleToWorkspace(ctx, workspace._id, trace.chatId, cache)) {
        visible.push(trace);
      }
      continue;
    }

    if (
      isOwnerManagedGatewayTrace(trace, workspace.ownerId) &&
      chatroomVisibilityByRequest.get(trace.requestId) !== false
    ) {
      visible.push(trace);
    }
  }
  return visible;
}

async function isTraceCompletionVisible(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  trace: Doc<"telemetry_traces">,
  cache: VisibilityCache,
): Promise<boolean> {
  if (trace.chatCompletionId === undefined) return true;
  const completion = await ctx.db.get("chat_completions", trace.chatCompletionId);
  return (
    completion !== null &&
    (await isCompletionVisible(ctx, workspace, completion as AttributedCompletion, cache))
  );
}

function traceBelongsToWorkspace(trace: Doc<"telemetry_traces">, workspace: Doc<"workspaces">) {
  if (trace.workspace !== undefined && trace.workspace !== workspace._id) return false;
  if (trace.balance !== undefined && trace.balance !== workspace.legacyBalance) return false;
  return trace.workspace !== undefined || trace.balance !== undefined;
}

/**
 * Detail reads need the same sibling check as list reads, otherwise a direct
 * request for a nested no-chat Gateway trace could bypass the list filter.
 */
export async function isTraceVisible(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  trace: Doc<"telemetry_traces">,
): Promise<boolean> {
  if (trace.chatId !== undefined || trace.source !== "gateway") {
    return (await filterVisibleTraces(ctx, workspace, [trace])).length === 1;
  }

  const related = await tracesWithRequestId(ctx, workspace, trace.requestId);
  const candidates = new Map(related.map((item) => [item._id, item]));
  candidates.set(trace._id, trace);
  const visible = await filterVisibleTraces(ctx, workspace, [...candidates.values()]);
  return visible.some((item) => item._id === trace._id);
}

async function tracesWithRequestId(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  requestId: string,
) {
  const current = await ctx.db
    .query("telemetry_traces")
    .withIndex("by_workspace_and_requestId", (q) =>
      q.eq("workspace", workspace._id).eq("requestId", requestId),
    )
    .take(101);

  if (!workspace.legacyBalance) return current;

  const legacy = await ctx.db
    .query("telemetry_traces")
    .withIndex("by_balance_and_requestId", (q) =>
      q.eq("balance", workspace.legacyBalance!).eq("requestId", requestId),
    )
    .take(101);
  const byId = new Map(current.map((trace) => [trace._id, trace]));
  for (const trace of legacy) byId.set(trace._id, trace);
  return [...byId.values()];
}
