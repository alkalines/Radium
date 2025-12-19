import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import {
  PersistentTextStreaming,
  StreamId,
} from "@convex-dev/persistent-text-streaming";
import { components } from "./_generated/api";

const streaming = new PersistentTextStreaming(
  components.persistentTextStreaming
);

// Mutation
export const CreateChat = mutation({
  args: {
    balance: v.id("balances"),
    messages_queue: queuedMessageSchema,
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";

    return await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: [],
      messages_queue: args.messages_queue,
      balance: args.balance,
      userId: identity._id,
    });
  },
});

export const EditChat = internalMutation({
  args: {
    messages: v.optional(v.array(messageSchema)),
    activeStreamId: v.optional(v.union(v.string(), v.null())),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat) return "Chat not Found.";
    
    ctx.db.patch(args.chatId, {
      messages: args.messages || chat.messages,
      messages_queue: args.messages_queue,
      activeStreamId: args.activeStreamId,
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
    const chat = await ctx.db.get(args.chatId);
    if (!chat || chat.userId !== identity._id) return "Chat not Found.";

    return {
      id: chat?._id,
      messages: chat?.messages,
      title: chat?.title,
      activeStream: chat.activeStreamId,
      messages_queue: chat.messages_queue,
    };
  },
});

export const GetChatOwner = internalQuery({
  args: {
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    return chat?.userId;
  },
});

export const GetChatStream = internalQuery({
  args: {
    chatId: v.id("aisdk_chats"),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    let body;

    try {
      body = await streaming.getStreamBody(ctx, chat!.activeStreamId as StreamId);
    } catch (e) {
      return null
    }

    return {
      chunks: body.text.split("[NEXT-CHUNK]"),
      status: body.status
    };
  },
})

export const ListChats = query({
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    return ctx.db
      .query("aisdk_chats")
      .filter((q) => q.eq(q.field("userId"), identity._id))
      .collect();
  },
});
