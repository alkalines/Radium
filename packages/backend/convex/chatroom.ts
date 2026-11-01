export { Watch, LiveFrames } from "../src/acp/live";
import { v } from "convex/values";
import { WEB_SEARCH_TOOL_ID } from "@/chatroom/tools";
import {
  readStoredSelection,
  storedSelection,
  toolSelectionValidator,
  type WorkspaceToolSelection,
} from "@/chatroom/tool-selection";
import {
  firstUserMessageText,
  generateChatTitle,
  isTitleGenerationModel,
  sanitizeTitle,
} from "@/chatroom/titles";
import { loadFirstUserMessage } from "@/chatroom/messages";
import {
  chatModelIdentityValidator,
  DEFAULT_SYSTEM_PROMPT_SETTINGS,
  systemPromptSettingsValidator,
  type SystemPromptSettings,
} from "../src/chatroom/system-prompt";
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
import { isGatewayCompletionWithoutChat } from "../src/workspaces/policy";
import {
  getDefaultWorkspaceForUser,
  requireAccessibleChat,
  loadWorkspaceSettings,
  requireChatManager,
  resolveWorkspaceForChat,
} from "./workspaces";
import { ownedWorkspaceMutation, workspaceQuery } from "./helpers";
import { isWorkspaceProviderEnabled, workspaceProviderRecords } from "./provider_records";
import { chatWorkerToolValidator, type ChatWorkerTool } from "../src/worker/chat-config";
import { accessibleSession } from "../src/acp/policy";

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

/** Read the user's default tool selection. */
export const getToolDefaults = workspaceQuery({
  args: {},
  handler: async (ctx): Promise<WorkspaceToolSelection> => {
    return readStoredSelection(ctx, ctx.workspace, ctx.workspace.settings);
  },
});

/** Replace the user's default tool selection. */
export const setToolDefaults = ownedWorkspaceMutation({
  args: { selection: toolSelectionValidator },
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    const selection = await storedSelection(ctx, ctx.workspace, args.selection);

    return await ctx.workspace.updateSettings(selection);
  },
});

/** Read the workspace's default Worker tools; members may read, absent means none. */
export const getWorkerToolDefaults = workspaceQuery({
  args: {},
  returns: v.array(chatWorkerToolValidator),
  handler: async (ctx): Promise<ChatWorkerTool[]> => {
    return ctx.workspace.settings.workerTools ?? [];
  },
});

/** Replace the workspace's default Worker tools. Owner only; tools must be unique. */
export const setWorkerToolDefaults = ownedWorkspaceMutation({
  args: { tools: v.array(chatWorkerToolValidator) },
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    if (new Set(args.tools).size !== args.tools.length) {
      throw new Error("Worker tools must be unique.");
    }

    return await ctx.workspace.updateSettings({ workerTools: args.tools });
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

/** Read the workspace's system prompt switches; absent means everything on. */
export const getSystemPromptSettings = workspaceQuery({
  args: {},
  returns: systemPromptSettingsValidator,
  handler: async (ctx): Promise<SystemPromptSettings> => {
    return ctx.workspace.settings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT_SETTINGS;
  },
});

/** Set whether chats send the system prompt and whether it names the model. Owner only. */
export const setSystemPromptSettings = ownedWorkspaceMutation({
  args: systemPromptSettingsValidator.fields,
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    return await ctx.workspace.updateSettings({
      systemPrompt: { enabled: args.enabled, modelIdentity: args.modelIdentity },
    });
  },
});

/**
 * What the system prompt of one chat request names, or `null` when the workspace switched the
 * prompt off. `model` is the identity from the global `models` catalogue, absent when the
 * workspace hid it. The chat action builds the text with `chatSystemPrompt` once it knows the Code
 * Mode catalog. Callers authorize the chat first; this only reads workspace settings and the
 * public catalogue.
 */
export const resolveSystemPrompt = internalQuery({
  args: { workspace: v.id("workspaces"), model: v.string() },
  returns: v.union(v.object({ model: v.optional(chatModelIdentityValidator) }), v.null()),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    const settings =
      (workspace && (await loadWorkspaceSettings(ctx, workspace)).systemPrompt) ??
      DEFAULT_SYSTEM_PROMPT_SETTINGS;
    if (!settings.enabled) return null;
    if (!settings.modelIdentity) return {};

    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", args.model))
      .unique();
    const author = model ? await ctx.db.get("authors", model.author) : null;
    return {
      model: {
        slug: args.model,
        ...(model ? { name: model.name } : {}),
        ...(author ? { author: author.name } : {}),
      },
    };
  },
});

/**
 * The effective tool selection for a chat: its own override when present,
 * otherwise the user's defaults. `source` tells the UI whether toggling will
 * create a per-chat override or is still reflecting the defaults.
 */
export const getChatTools = query({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args): Promise<WorkspaceToolSelection & { source: "chat" | "defaults" }> => {
    const { chat, workspace } = await requireAccessibleChat(ctx, args.chatId);
    if (chat.tools) {
      const selection = await readStoredSelection(ctx, workspace, chat.tools);
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
    const selection = await storedSelection(ctx, workspace, args.selection);
    await ctx.db.patch("aisdk_chats", args.chatId, { tools: selection });
  },
});

async function resolveDefaults(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
): Promise<WorkspaceToolSelection> {
  const defaults = await loadWorkspaceSettings(ctx, workspace);
  return readStoredSelection(ctx, workspace, defaults);
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
      ? await readStoredSelection(ctx, workspace, chat.tools)
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
        codeMode: server.codeMode ?? true,
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
      ? await readStoredSelection(ctx, workspace, chat.tools)
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
  /** Tools reachable only inside Code Mode (`true`) or as direct tool calls (`false`). */
  codeMode: boolean;
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

    const provider = createInternalGatewayProvider(ctx, chat.workspace, {}, undefined, undefined, {
      userId: chat.userId,
      chatId: args.chatId,
    });

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

    const firstUserMessage = await loadFirstUserMessage(ctx, chat);
    const initialUserMessage = firstUserMessageText({
      messages_queue: chat.messages_queue,
      messages: firstUserMessage ? [firstUserMessage] : [],
    });
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

/**
 * Authorize an ACP viewer and resolve the ordinary workspace title model without reading a
 * transcript. The action receives the first prompt only in memory, never through this query.
 */
export const acpTitleGenerationInfo = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.union(
    v.null(),
    v.object({
      workspace: v.id("workspaces"),
      userId: v.string(),
      model: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const { chat, session, workspace } = await accessibleSession(ctx, args.chatId);
    if (chat.title || session.userTitled) return null;
    const settings = await loadWorkspaceSettings(ctx, workspace);
    const model = await firstAvailableModel(
      ctx,
      workspace,
      settings?.titleModel ?? settings?.defaultModel,
    );
    if (!model) return null;
    return { workspace: workspace._id, userId: chat.userId, model };
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

    // Match both ownership keys during the legacy migration; a legacy balance
    // alone identifies a chat only when it has no workspace id yet.
    let belongsToWorkspace = false;
    if (chat.workspace) {
      belongsToWorkspace =
        chat.workspace === workspaceId &&
        (chat.balance === undefined || chat.balance === workspace.legacyBalance);
    } else {
      belongsToWorkspace = chat.balance !== undefined && chat.balance === workspace.legacyBalance;
    }

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
 * A captured request is visible to the workspace owner when it came through Gateway without a
 * chat, or when its chat passes the Chatroom privacy policy. Ownership alone never exposes
 * another user's private chat, so personal-chat requests stay hidden.
 */
export async function isRequestVisible(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  request: Doc<"telemetry_requests">,
  cache: VisibilityCache = new Map(),
): Promise<boolean> {
  if (request.workspace !== workspace._id) return false;
  if (request.chatId === undefined) return true;
  return await isChatVisibleToWorkspace(ctx, workspace._id, request.chatId, cache);
}

/** Filter before callers derive counts, truncation, or latency aggregates. */
export async function filterVisibleRequests(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  requests: Doc<"telemetry_requests">[],
): Promise<Doc<"telemetry_requests">[]> {
  const cache: VisibilityCache = new Map();
  const visible: Doc<"telemetry_requests">[] = [];
  for (const request of requests) {
    if (await isRequestVisible(ctx, workspace, request, cache)) visible.push(request);
  }
  return visible;
}
