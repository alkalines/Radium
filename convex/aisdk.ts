import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import { internal } from "./_generated/api";

// Mutation
export const CreateChat = mutation({
  args: {
    balance: v.id("balances"),
    messages_queue: queuedMessageSchema,
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";

    const chatId = await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: [],
      messages_queue: args.messages_queue,
      balance: args.balance,
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
    balance: v.id("balances"),
    messages: v.array(messageSchema),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";

    const chatId = await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: args.messages,
      messages_queue: args.messages_queue ?? undefined,
      balance: args.balance,
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
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat || chat.userId !== identity._id) return "Chat not Found.";

    return {
      id: chat?._id,
      messages: chat?.messages,
      title: chat?.title,
      activeStream: chat.activeStream,
      messages_queue: chat.messages_queue,
    };
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
  args: {},
  handler: async (ctx) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    const chats = await ctx.db
      .query("aisdk_chats")
      .withIndex("by_userId_and_lastInteractionAt", (q) => q.eq("userId", identity._id))
      .order("desc")
      .take(30);

    return chats.map((chat) => ({
      id: chat._id,
      title: chat.title,
      emoji: chat.emoji,
      lastInteractionAt: chat.lastInteractionAt ?? chat._creationTime,
      activeStream: chat.activeStream ?? false,
    }));
  },
});
