import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import { components, internal } from "./_generated/api";
import { requireAccessibleChat, requireChatManager } from "./workspaces";
import { workspaceMutation, workspaceQuery } from "./helpers";
import { firstUserMessageText } from "@/chatroom/titles";
import { canManageChat } from "../src/workspaces/policy";
import {
  chatWorkerSelectionValidator,
  validateChatWorkerSelection,
} from "../src/worker/chat-config";

const chatScopeValidator = v.union(v.literal("personal"), v.literal("workspace"));
const MAX_CHAT_CANDIDATES = 100;

// Mutation
export const CreateChat = workspaceMutation({
  args: {
    scope: v.optional(chatScopeValidator),
    messages_queue: queuedMessageSchema,
    worker: v.optional(chatWorkerSelectionValidator),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args): Promise<Id<"aisdk_chats">> => {
    if (args.worker) {
      await validateChatWorkerSelection(
        args.worker,
        ctx.identity._id,
        { id: ctx.workspace._id, ownerId: ctx.workspace.ownerId },
        () =>
          ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
            workspaceId: ctx.workspace._id,
            workerId: args.worker!.workerId,
          }),
      );
    }

    const chatId = await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: [],
      messages_queue: args.messages_queue,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      worker: args.worker,
      userId: ctx.identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });

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
 * forked user turn is regenerated with another model on load.
 */
export const ForkChat = workspaceMutation({
  args: {
    scope: v.optional(chatScopeValidator),
    messages: v.array(messageSchema),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args): Promise<Id<"aisdk_chats">> => {
    const chatId = await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: args.messages,
      messages_queue: args.messages_queue ?? undefined,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      userId: ctx.identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });

    if (args.messages_queue?.text.trim()) {
      await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, { chatId });
    }
    return chatId;
  },
});

export const EditChat = internalMutation({
  args: {
    messages: v.optional(v.array(messageSchema)),
    activeStream: v.optional(v.boolean()),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return "Chat not Found.";

    await ctx.db.patch("aisdk_chats", args.chatId, {
      messages: args.messages || chat.messages,
      messages_queue: args.messages_queue,
      activeStream: args.activeStream,
      lastInteractionAt: Date.now(),
    });
  },
});

export const GetChat = query({
  args: {
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";
    const { chat, workspace, canManage } = await requireAccessibleChat(ctx, args.chatId);

    return {
      id: chat?._id,
      workspace: workspace._id,
      scope: chat.scope ?? "personal",
      canManage,
      canManageScope: chat.userId === identity._id,
      messages: chat?.messages,
      title: chat?.title,
      activeStream: chat.activeStream,
      messages_queue: chat.messages_queue,
      worker: chat.worker,
    };
  },
});

/** Set (or clear) a chat's Worker configuration. Only the workspace owner may do so. */
export const SetChatWorker = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    selection: v.union(chatWorkerSelectionValidator, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireChatManager(ctx, args.chatId);

    if (args.selection) {
      await validateChatWorkerSelection(
        args.selection,
        userId,
        { id: workspace._id, ownerId: workspace.ownerId },
        () =>
          ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
            workspaceId: workspace._id,
            workerId: args.selection!.workerId,
          }),
      );
    } else if (workspace.ownerId !== userId) {
      throw new Error("Only the workspace owner can configure a Worker for chats.");
    }

    await ctx.db.patch("aisdk_chats", chat._id, { worker: args.selection ?? undefined });
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
    if (chat.userId !== identity._id)
      throw new Error("Only the chat creator can change its scope.");

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

    await requireChatManager(ctx, args.chatId);

    const title = args.title
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
    if (!title) return "Title is required.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title });
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

    await requireChatManager(ctx, args.chatId);

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
    if (!firstUserMessageText(chat)) return "Chat has no prompt to title.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title: undefined, emoji: undefined });
    await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, {
      chatId: args.chatId,
      force: true,
    });
    return null;
  },
});

export const DeleteChat = mutation({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    await requireChatManager(ctx, args.chatId);

    await ctx.db.delete("aisdk_chats", args.chatId);
    await ctx.scheduler.runAfter(0, internal.worker_tasks.cleanupChatCalls, {
      chatId: args.chatId,
    });
    return null;
  },
});

export const InternalChatInfo = internalQuery({
  args: {
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    return chat;
  },
});

export const ListChats = workspaceQuery({
  args: {},
  handler: async (ctx, args) => {
    const [ownChats, sharedChats, legacyChats] = await Promise.all([
      ctx.db
        .query("aisdk_chats")
        .withIndex("by_workspace_and_userId_and_lastInteractionAt", (q) =>
          q.eq("workspace", args.workspace).eq("userId", ctx.identity._id),
        )
        .order("desc")
        .take(MAX_CHAT_CANDIDATES),
      ctx.db
        .query("aisdk_chats")
        .withIndex("by_workspace_and_scope_and_lastInteractionAt", (q) =>
          q.eq("workspace", args.workspace).eq("scope", "workspace"),
        )
        .order("desc")
        .take(MAX_CHAT_CANDIDATES),
      ctx.workspace.legacyBalance
        ? ctx.db
            .query("aisdk_chats")
            .withIndex("by_balance_and_lastInteractionAt", (q) =>
              q.eq("balance", ctx.workspace.legacyBalance!),
            )
            .order("desc")
            .take(MAX_CHAT_CANDIDATES)
        : Promise.resolve([]),
    ]);

    const chatsById = new Map<Id<"aisdk_chats">, (typeof ownChats)[number]>();
    const belongsToWorkspace = (chat: (typeof ownChats)[number]) =>
      chat.workspace === ctx.workspace._id &&
      (chat.balance === undefined || chat.balance === ctx.workspace.legacyBalance);
    for (const chat of ownChats) {
      if (belongsToWorkspace(chat)) chatsById.set(chat._id, chat);
    }
    for (const chat of sharedChats) {
      if (belongsToWorkspace(chat)) chatsById.set(chat._id, chat);
    }
    for (const chat of legacyChats) {
      if (
        chat.workspace === undefined &&
        chat.userId === ctx.identity._id &&
        (chat.scope === undefined || chat.scope === "personal")
      ) {
        chatsById.set(chat._id, chat);
      }
    }
    const chats = [...chatsById.values()];

    return chats
      .sort((a, b) => {
        const pinnedDelta = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
        if (pinnedDelta !== 0) return pinnedDelta;
        return (b.lastInteractionAt ?? b._creationTime) - (a.lastInteractionAt ?? a._creationTime);
      })
      .slice(0, 30)
      .map((chat) => ({
        id: chat._id,
        title: chat.title,
        emoji: chat.emoji,
        pinnedAt: chat.pinnedAt,
        lastInteractionAt: chat.lastInteractionAt ?? chat._creationTime,
        activeStream: chat.activeStream ?? false,
        canManage: canManageChat(chat, ctx.workspace, ctx.identity._id),
      }));
  },
});
