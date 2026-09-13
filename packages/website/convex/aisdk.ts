import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import { internal } from "./_generated/api";
import { requireAccessibleChat, requireOwnedWorkspace } from "./workspaces";
import { firstUserMessageText } from "./chat_titles";

// Mutation
export const CreateChat = mutation({
  args: {
    workspace: v.id("workspaces"),
    scope: v.optional(v.union(v.literal("personal"), v.literal("workspace"))),
    messages_queue: queuedMessageSchema,
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";
    await requireOwnedWorkspace(ctx, args.workspace);

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
export const ForkChat = mutation({
  args: {
    workspace: v.id("workspaces"),
    scope: v.optional(v.union(v.literal("personal"), v.literal("workspace"))),
    messages: v.array(messageSchema),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";
    await requireOwnedWorkspace(ctx, args.workspace);

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

export const GetChat = query({
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
      scope: chat.scope,
      messages: chat?.messages,
      title: chat?.title,
      activeStream: chat.activeStream,
      messages_queue: chat.messages_queue,
    };
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

    const { chat } = await requireAccessibleChat(ctx, args.chatId);

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

    await requireAccessibleChat(ctx, args.chatId);

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

    const { chat } = await requireAccessibleChat(ctx, args.chatId);
    if (!firstUserMessageText(chat)) return "Chat has no prompt to title.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title: undefined, emoji: undefined });
    await ctx.scheduler.runAfter(0, internal.chat_titles.generateForChat, {
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

    await requireAccessibleChat(ctx, args.chatId);

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

export const ListChats = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);

    const workspaceChats = await ctx.db
      .query("aisdk_chats")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .take(100);
    const legacyChats = workspace.legacyBalance
      ? await ctx.db
          .query("aisdk_chats")
          .withIndex("by_userId", (q) => q.eq("userId", identity._id))
          .take(100)
      : [];
    const chats = [
      ...workspaceChats,
      ...legacyChats.filter((chat) => chat.workspace === undefined),
    ].filter(
      (chat) =>
        chat.userId === identity._id &&
        (chat.workspace === workspace._id ||
          (chat.workspace === undefined && chat.balance === workspace.legacyBalance)),
    );

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
      }));
  },
});
