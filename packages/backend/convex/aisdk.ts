import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { authComponent } from "./auth";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import { internal } from "./_generated/api";
import { requireAccessibleChat, requireChatManager, resolveWorkspaceForChat } from "./workspaces";
import { workspaceMutation, workspaceQuery } from "./helpers";
import { firstUserMessageText } from "@/chatroom/titles";
import {
  cleanupChatContent,
  insertChatMessages,
  loadChatMessages,
  loadFirstUserMessage,
  saveChatMessages,
} from "../src/chatroom/messages";
import { linkChatFiles, storedFileUrls } from "../src/chatroom/files";
import { canManageChat } from "../src/workspaces/policy";
import { chatWorkerSelectionValidator, type ChatWorkerSelection } from "../src/worker/chat-config";
import {
  rederiveChatWorkerDirectory,
  resolveChatWorkerSelection,
} from "../src/worker/chat-selection";
import { requireWorkspaceProject } from "../src/projects/projects";
import { storedSelection, toolSelectionValidator } from "../src/chatroom/tool-selection";
import { chatInterruptionValidator } from "../src/chatroom/interruption";
import { findSession, requireChatActor } from "../src/acp/policy";
import { queueChatDeletion } from "../src/acp/retention";

const chatScopeValidator = v.union(v.literal("personal"), v.literal("workspace"));
// A Home page never scans more than this many chats, whatever its filters skip.
const CHAT_PAGE_MAX_ROWS_READ = 400;
// Pinned chats sort first however old they are, so they are read apart from the pages.
const MAX_PINNED_CANDIDATES = 100;
// Legacy balance-only chats have no workspace index; keep the wider pre-split window for them.
const MAX_LEGACY_CANDIDATES = 100;

/** Registered for `DeleteChat`; implementation in src/chatroom/messages.ts. */
export { cleanupChatContent };

// Mutation
/**
 * Create a private-by-default chat and schedule title generation from its queued prompt.
 * `project` must belong to the same workspace. `tools` becomes the chat's per-chat tool override
 * after sanitizing, so a draft's tool choices never write workspace defaults. `worker` is
 * owner-only; its `directory` is ignored and derived from the Project folder or the Worker's
 * reported temp directory.
 */
export const CreateChat = workspaceMutation({
  args: {
    scope: v.optional(chatScopeValidator),
    messages_queue: queuedMessageSchema,
    worker: v.optional(chatWorkerSelectionValidator),
    project: v.optional(v.id("projects")),
    tools: v.optional(toolSelectionValidator),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args): Promise<Id<"aisdk_chats">> => {
    if (args.project) {
      await requireWorkspaceProject(ctx, args.project, ctx.workspace._id);
    }

    let worker: ChatWorkerSelection | undefined;
    if (args.worker) {
      worker = await resolveChatWorkerSelection(ctx, {
        requested: args.worker,
        userId: ctx.identity._id,
        workspace: ctx.workspace,
        project: args.project,
        current: undefined,
      });
    }
    const tools = args.tools ? await storedSelection(ctx, ctx.workspace, args.tools) : undefined;

    const chatId = await ctx.db.insert("aisdk_chats", {
      messages_queue: args.messages_queue,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      worker,
      project: args.project,
      tools,
      userId: ctx.identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });
    await linkChatFiles(
      ctx,
      args.workspace,
      chatId,
      storedFileUrls([{ parts: args.messages_queue.files }]),
    );

    await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, { chatId });
    return chatId;
  },
});

/**
 * Creates a new chat seeded with an existing conversation history (a "fork").
 *
 * Used by the message-level fork actions: assistant forks pass the history up to
 * and including the assistant turn and no queue (the user continues with a new
 * model), while user forks pass the prior history plus a `messages_queue` so the
 * forked user turn is regenerated with another model on load. `project` must belong to the
 * same workspace.
 */
export const ForkChat = workspaceMutation({
  args: {
    scope: v.optional(chatScopeValidator),
    messages: v.array(messageSchema),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
    project: v.optional(v.id("projects")),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args): Promise<Id<"aisdk_chats">> => {
    if (args.project) {
      await requireWorkspaceProject(ctx, args.project, ctx.workspace._id);
    }

    const chatId = await ctx.db.insert("aisdk_chats", {
      messages_queue: args.messages_queue ?? undefined,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      project: args.project,
      userId: ctx.identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });
    await insertChatMessages(ctx, chatId, args.workspace, args.messages);
    if (args.messages_queue) {
      await linkChatFiles(
        ctx,
        args.workspace,
        chatId,
        storedFileUrls([{ parts: args.messages_queue.files }]),
      );
    }

    if (args.messages_queue?.text.trim()) {
      await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, { chatId });
    }
    return chatId;
  },
});

/**
 * Chat HTTP action write: request start (`activeStream: true`, queue cleared) and request end
 * (messages, `activeStream: false`, and the `interruption` if it stopped short). Omitted fields
 * other than `messages` are cleared, so every start drops the previous interruption. `messages`
 * replaces the stored history (only changed positions are written) and moves an unmigrated
 * chat's embedded history out of the chat document.
 */
export const EditChat = internalMutation({
  args: {
    messages: v.optional(v.array(messageSchema)),
    activeStream: v.optional(v.boolean()),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
    interruption: v.optional(chatInterruptionValidator),
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return "Chat not Found.";

    if (args.messages) {
      const workspace = await resolveWorkspaceForChat(ctx, chat);
      if (!workspace) return "Chat not Found.";
      await saveChatMessages(ctx, chat, workspace._id, args.messages);
    }

    await ctx.db.patch("aisdk_chats", args.chatId, {
      ...(args.messages ? { messages: undefined, chat_completions: undefined } : {}),
      messages_queue: args.messages_queue,
      activeStream: args.activeStream,
      interruption: args.interruption,
      lastInteractionAt: Date.now(),
    });
  },
});

/**
 * Chat metadata for a session Tab, without its history: every mounted Tab subscribes to this,
 * so it must stay cheap. History comes from `GetChatMessages`, subscribed only by opened Tabs.
 */
export const GetChat = query({
  args: {
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";
    const { chat, workspace, canManage } = await requireAccessibleChat(ctx, args.chatId);

    return {
      id: chat._id,
      workspace: workspace._id,
      scope: chat.scope ?? "personal",
      canManage,
      canManageScope: chat.userId === identity._id,
      title: chat.title,
      activeStream: chat.activeStream,
      interruption: chat.interruption ?? null,
      messages_queue: chat.messages_queue,
      worker: chat.worker,
      agent: chat.agent,
      project: chat.project ?? null,
    };
  },
});

/**
 * A chat's full history for the open session, with `activeStream` from the same snapshot so the
 * client can tell whether a request was still running when these messages were read.
 */
export const GetChatMessages = query({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.object({ messages: v.array(messageSchema), activeStream: v.boolean() }),
  handler: async (ctx, args) => {
    const { chat } = await requireAccessibleChat(ctx, args.chatId);
    return {
      messages: await loadChatMessages(ctx, chat),
      activeStream: chat.activeStream ?? false,
    };
  },
});

/**
 * Set (or clear) a chat's Worker selection. Only the workspace owner may do so. The client
 * `directory` is ignored: a changed Worker (or a missing stored directory) re-derives it from the
 * chat's Project folder or the Worker's temp directory; toggling tools keeps the stored one.
 */
export const SetChatWorker = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    selection: v.union(chatWorkerSelectionValidator, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireChatManager(ctx, args.chatId);
    if (chat.agent) throw new ConvexError({ code: "ACP_IMMUTABLE_BINDING" });

    if (!args.selection) {
      if (workspace.ownerId !== userId) {
        throw new Error("Only the workspace owner can configure a Worker for chats.");
      }
      await ctx.db.patch("aisdk_chats", chat._id, { worker: undefined });
      return null;
    }

    const worker = await resolveChatWorkerSelection(ctx, {
      requested: args.selection,
      userId,
      workspace,
      project: chat.project,
      current: chat.worker,
    });
    await ctx.db.patch("aisdk_chats", chat._id, { worker });
    return null;
  },
});

/**
 * File a chat under a Project in its own workspace, or detach it with `null`. Requires chat
 * management (creator, or workspace owner for shared chats); filing never changes visibility.
 * A chat with a Worker gets its directory re-derived for the new Project (owner-set folders).
 */
export const SetChatProject = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    project: v.union(v.id("projects"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace } = await requireChatManager(ctx, args.chatId);

    if (args.project) {
      await requireWorkspaceProject(ctx, args.project, workspace._id);
    }

    const project = args.project ?? undefined;
    let worker = chat.worker;
    const needsDirectory =
      worker?.workerId !== undefined &&
      (chat.project !== project || worker.directory === undefined);
    if (worker && needsDirectory) {
      worker = await rederiveChatWorkerDirectory(ctx, workspace._id, worker, project);
    }

    await ctx.db.patch("aisdk_chats", chat._id, { project, worker });
    return null;
  },
});

/** Change a chat's visibility. Only its creator may change its scope. */
export const SetChatScope = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    scope: chatScopeValidator,
  },
  returns: v.object({ scope: chatScopeValidator }),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const { chat } = await requireAccessibleChat(ctx, args.chatId);
    if (chat.userId !== identity._id) {
      throw new Error("Only the chat creator can change its scope.");
    }

    await ctx.db.patch("aisdk_chats", args.chatId, { scope: args.scope });
    return { scope: args.scope };
  },
});

export const RenameChat = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    await requireChatActor(ctx, args.chatId);

    const title = args.title
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
    if (!title) return "Title is required.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title });
    const session = await findSession(ctx, args.chatId);
    if (session) await ctx.db.patch(session._id, { userTitled: true });
    return null;
  },
});

export const SetChatPinned = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    await requireChatActor(ctx, args.chatId);

    await ctx.db.patch("aisdk_chats", args.chatId, {
      pinnedAt: args.pinned ? Date.now() : undefined,
    });
    return null;
  },
});

export const RegenerateChatTitle = mutation({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    const { chat } = await requireChatManager(ctx, args.chatId);
    const firstUserMessage = await loadFirstUserMessage(ctx, chat);
    const prompt = firstUserMessageText({
      messages_queue: chat.messages_queue,
      messages: firstUserMessage ? [firstUserMessage] : [],
    });
    if (!prompt) return "Chat has no prompt to title.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title: undefined, emoji: undefined });
    await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, {
      chatId: args.chatId,
      force: true,
    });
    return null;
  },
});

export const DeleteChat = mutation({
  args: { chatId: v.id("aisdk_chats"), deleteInAgent: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    const access = await requireChatActor(ctx, args.chatId);
    await queueChatDeletion(ctx, access.chat, identity._id, args.deleteInAgent);

    await ctx.db.delete("aisdk_chats", args.chatId);
    await ctx.scheduler.runAfter(0, internal.worker_tasks.cleanupChatCalls, {
      chatId: args.chatId,
    });
    await ctx.scheduler.runAfter(0, internal.aisdk.cleanupChatContent, { chatId: args.chatId });
    return null;
  },
});

/** Match both ownership keys during the legacy migration for chats with a workspace id. */
function chatBelongsToWorkspace(chat: Doc<"aisdk_chats">, workspace: Doc<"workspaces">) {
  return (
    chat.workspace === workspace._id &&
    (chat.balance === undefined || chat.balance === workspace.legacyBalance)
  );
}

/** A legacy balance-only chat visible to `userId`: personal and theirs. */
function isLegacyChatOf(chat: Doc<"aisdk_chats">, userId: string) {
  return (
    chat.workspace === undefined &&
    chat.userId === userId &&
    (chat.scope === undefined || chat.scope === "personal")
  );
}

/** Validates a Project filter: a deleted Project lists nothing, a foreign one is an error. */
async function projectFilterExists(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  project: Id<"projects"> | null | undefined,
) {
  if (!project) return true;
  const row = await ctx.db.get("projects", project);
  if (!row) return false;
  if (row.workspace !== workspace) throw new Error("Project not found.");
  return true;
}

/** Home row for a chat, with its ACP agent's configured name. */
async function chatRows(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  userId: string,
  chats: Doc<"aisdk_chats">[],
) {
  const agentIds = new Set(chats.flatMap((chat) => (chat.agent ? [chat.agent.agentId] : [])));
  const agentNames = new Map(
    await Promise.all(
      [...agentIds].map(async (agentId) => {
        const definition = await ctx.db
          .query("acp_agents")
          .withIndex("by_workspace_and_agentId", (q) =>
            q.eq("workspace", workspace._id).eq("agentId", agentId),
          )
          .unique();
        return [agentId, definition?.name ?? agentId] as const;
      }),
    ),
  );
  return chats.map((chat) => ({
    id: chat._id,
    title: chat.title,
    emoji: chat.emoji,
    pinnedAt: chat.pinnedAt,
    lastInteractionAt: chat.lastInteractionAt ?? chat._creationTime,
    activeStream: chat.activeStream ?? false,
    agent: chat.agent
      ? {
          agentId: chat.agent.agentId,
          name: agentNames.get(chat.agent.agentId) ?? chat.agent.agentId,
          worker: chat.agent.worker,
        }
      : null,
    canManage: canManageChat(chat, workspace, userId),
    project: chat.project,
  }));
}

const projectFilterValidator = v.optional(v.union(v.id("projects"), v.null()));

/**
 * One page of the visible, unpinned chats in a workspace, most recent first (pinned ones come
 * from `ListPinnedChats`). `project` narrows to that Project's chats, `project: null` to chats
 * without a Project; the privacy filter (own chats plus workspace-scoped chats, and the caller's
 * legacy balance-only chats) is the same in every case.
 *
 * The creator-owned, shared and legacy indexes are merged into one stream by
 * `lastInteractionAt`, so a page reads only its own rows. Pages are reactive: clients pass
 * `endCursor` (convex-helpers `usePaginatedQuery` with `customPagination`) to keep them gapless.
 */
export const ListChats = workspaceQuery({
  args: { project: projectFilterValidator, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!(await projectFilterExists(ctx, ctx.workspace._id, args.project))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const workspace = ctx.workspace;
    const userId = ctx.identity._id;
    const project = args.project ?? undefined;
    const chats = () => stream(ctx.db, schema).query("aisdk_chats");

    // Read creator-owned and explicitly shared chats separately: workspace membership, including
    // ownership, must never expose another user's personal chats, and filing a chat under a
    // Project never shares it. The caller's own shared chats come from the first stream.
    const own =
      args.project === undefined
        ? chats().withIndex("by_workspace_and_userId_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("userId", userId),
          )
        : chats().withIndex("by_workspace_and_userId_and_project_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("userId", userId).eq("project", project),
          );
    const shared =
      args.project === undefined
        ? chats().withIndex("by_workspace_and_scope_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("scope", "workspace"),
          )
        : chats().withIndex("by_workspace_and_scope_and_project_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("scope", "workspace").eq("project", project),
          );
    const streams = [
      own.order("desc").filterWith(async (chat) => chatBelongsToWorkspace(chat, workspace)),
      shared
        .order("desc")
        .filterWith(
          async (chat) => chat.userId !== userId && chatBelongsToWorkspace(chat, workspace),
        ),
    ];
    if (workspace.legacyBalance) {
      streams.push(
        chats()
          .withIndex("by_balance_and_lastInteractionAt", (q) =>
            q.eq("balance", workspace.legacyBalance!),
          )
          .order("desc")
          .filterWith(
            async (chat) =>
              isLegacyChatOf(chat, userId) &&
              (args.project === undefined || chat.project === project),
          ),
      );
    }
    const result = await mergedStream(streams, ["lastInteractionAt"])
      .filterWith(async (chat) => !chat.pinnedAt)
      .paginate({ ...args.paginationOpts, maximumRowsRead: CHAT_PAGE_MAX_ROWS_READ });
    return { ...result, page: await chatRows(ctx, workspace, userId, result.page) };
  },
});

/**
 * Every visible pinned chat (bounded) under the same filters as `ListChats`, newest pin first.
 * Pinned chats sort first however old they are, so they are read apart from the pages.
 */
export const ListPinnedChats = workspaceQuery({
  args: { project: projectFilterValidator },
  handler: async (ctx, args) => {
    if (!(await projectFilterExists(ctx, ctx.workspace._id, args.project))) return [];
    const workspace = ctx.workspace;
    const userId = ctx.identity._id;
    const project = args.project ?? undefined;
    const matchesProject = (chat: Doc<"aisdk_chats">) =>
      args.project === undefined || chat.project === project;

    // Pinned chats are few; read them across Projects and filter here instead of adding a Project
    // variant of each pinned index.
    const [own, shared, legacy] = await Promise.all([
      ctx.db
        .query("aisdk_chats")
        .withIndex("by_workspace_and_userId_and_pinnedAt", (q) =>
          q.eq("workspace", workspace._id).eq("userId", userId).gt("pinnedAt", 0),
        )
        .order("desc")
        .take(MAX_PINNED_CANDIDATES),
      ctx.db
        .query("aisdk_chats")
        .withIndex("by_workspace_and_scope_and_pinnedAt", (q) =>
          q.eq("workspace", workspace._id).eq("scope", "workspace").gt("pinnedAt", 0),
        )
        .order("desc")
        .take(MAX_PINNED_CANDIDATES),
      workspace.legacyBalance
        ? ctx.db
            .query("aisdk_chats")
            .withIndex("by_balance_and_lastInteractionAt", (q) =>
              q.eq("balance", workspace.legacyBalance!),
            )
            .order("desc")
            .take(MAX_LEGACY_CANDIDATES)
        : Promise.resolve([]),
    ]);
    const pinned = new Map<Id<"aisdk_chats">, Doc<"aisdk_chats">>();
    for (const chat of [...own, ...shared]) {
      if (chatBelongsToWorkspace(chat, workspace) && matchesProject(chat)) {
        pinned.set(chat._id, chat);
      }
    }
    for (const chat of legacy) {
      if (chat.pinnedAt && isLegacyChatOf(chat, userId) && matchesProject(chat)) {
        pinned.set(chat._id, chat);
      }
    }
    const chats = [...pinned.values()].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    return chatRows(ctx, workspace, userId, chats);
  },
});
