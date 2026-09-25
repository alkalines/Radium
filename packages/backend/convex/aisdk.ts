import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import { internal } from "./_generated/api";
import { requireAccessibleChat, requireWorkspaceAccess } from "./workspaces";
import { sessionMutation, sessionQuery, workspaceMutation, workspaceQuery } from "./auth";
import { canManageChat, requireChatManager } from "./chatroom";
import { firstUserMessageText } from "./chat_titles";

const chatScopeValidator = v.union(v.literal("personal"), v.literal("workspace"));
const MAX_CHAT_CANDIDATES = 100;

// Mutation
export const CreateChat = workspaceMutation({
  role: "member",
  allowUnauthenticated: true,
  args: {
    workspace: v.id("workspaces"),
    scope: v.optional(chatScopeValidator),
    messages_queue: queuedMessageSchema,
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";
    await requireWorkspaceAccess(ctx, args.workspace);

    const chatId = await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: [],
      messages_queue: args.messages_queue,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      userId: identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.chat_titles.generateForChat, { chatId });
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
  role: "member",
  allowUnauthenticated: true,
  args: {
    workspace: v.id("workspaces"),
    scope: v.optional(chatScopeValidator),
    messages: v.array(messageSchema),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";
    await requireWorkspaceAccess(ctx, args.workspace);

    const chatId = await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: args.messages,
      messages_queue: args.messages_queue ?? undefined,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      userId: identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });

    if (args.messages_queue?.text.trim()) {
      await ctx.scheduler.runAfter(0, internal.chat_titles.generateForChat, { chatId });
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

export const GetChat = sessionQuery({
  args: {
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";
    const { chat, workspace } = await requireAccessibleChat(ctx, args.chatId);

    return {
      id: chat?._id,
      workspace: workspace._id,
      scope: chat.scope ?? "personal",
      canManage: canManageChat(chat, workspace, identity._id),
      canManageScope: chat.userId === identity._id,
      messages: chat?.messages,
      title: chat?.title,
      activeStream: chat.activeStream,
      messages_queue: chat.messages_queue,
    };
  },
});

/** Change a chat's visibility. Only its creator may change its scope. */
export const SetChatScope = sessionMutation({
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

export const RenameChat = sessionMutation({
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

export const SetChatPinned = sessionMutation({
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

export const RegenerateChatTitle = sessionMutation({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    const { chat } = await requireChatManager(ctx, args.chatId);
    if (!firstUserMessageText(chat)) return "Chat has no prompt to title.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title: undefined, emoji: undefined });
    await ctx.scheduler.runAfter(0, internal.chat_titles.generateForChat, {
      chatId: args.chatId,
      force: true,
    });
    return null;
  },
});

export const DeleteChat = sessionMutation({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    await requireChatManager(ctx, args.chatId);

    await ctx.db.delete("aisdk_chats", args.chatId);
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
  role: "member",
  allowUnauthenticated: true,
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";
    const workspace = await requireWorkspaceAccess(ctx, args.workspace);

    const [ownChats, sharedChats, legacyChats] = await Promise.all([
      ctx.db
        .query("aisdk_chats")
        .withIndex("by_workspace_and_userId_and_lastInteractionAt", (q) =>
          q.eq("workspace", args.workspace).eq("userId", identity._id),
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
      workspace.legacyBalance
        ? ctx.db
            .query("aisdk_chats")
            .withIndex("by_balance_and_lastInteractionAt", (q) =>
              q.eq("balance", workspace.legacyBalance!),
            )
            .order("desc")
            .take(MAX_CHAT_CANDIDATES)
        : Promise.resolve([]),
    ]);

    const chatsById = new Map<Id<"aisdk_chats">, (typeof ownChats)[number]>();
    const belongsToWorkspace = (chat: (typeof ownChats)[number]) =>
      chat.workspace === workspace._id &&
      (chat.balance === undefined || chat.balance === workspace.legacyBalance);
    for (const chat of ownChats) {
      if (belongsToWorkspace(chat)) chatsById.set(chat._id, chat);
    }
    for (const chat of sharedChats) {
      if (belongsToWorkspace(chat)) chatsById.set(chat._id, chat);
    }
    for (const chat of legacyChats) {
      if (
        chat.workspace === undefined &&
        chat.userId === identity._id &&
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
        canManage: canManageChat(chat, workspace, identity._id),
      }));
  },
});
