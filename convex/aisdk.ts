import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { messageSchema } from "./aisdk_schemas";

// Mutation
export const CreateChat = mutation({
  args: {
    balance: v.id("balances"),
  },
  handler: async (ctx, args): Promise<Id<"aisdk_chats"> | "Not logged in!"> => {
    const identity = await authComponent.getAuthUser(ctx);

    if (!identity) return "Not logged in!";

    return await ctx.db.insert("aisdk_chats", {
      chat_completions: [],
      messages: [],
      balance: args.balance,
      userId: identity._id,
    });
  },
});

export const EditChat = internalMutation({
  args: {
    messages: v.array(messageSchema),
    chatId: v.id("aisdk_chats"),
    user: v.id("users"),
  },
  handler: async (ctx, args) => {},
});

export const GetChat = query({
  args: {
    chatId: v.id("aisdk_chats")
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";
    const chat = await ctx.db.get(args.chatId)
    if (!chat || chat.userId !== identity._id) return 'Chat not Found.'

    return {
      id: chat?._id,
      messages: chat?.messages,
      title: chat?.title
    }
  }
})

export const ListChats = query({
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    return ctx.db.query("aisdk_chats").filter((q) => q.eq(q.field("userId"), identity._id)).collect()
  }
})