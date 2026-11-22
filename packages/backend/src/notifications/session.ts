import { v } from "convex/values";
import { sessionNotificationKindValidator } from "contracts/notifications/contract";
import { internalMutation } from "../../convex/_generated/server";
import { zodToConvex } from "../zod-validators";
import { notify } from "./notify";

/** Notify the user who sent a Chatroom request without persisting chat content. */
export const notifySession = internalMutation({
  args: {
    userId: v.string(),
    chat: v.id("aisdk_chats"),
    kind: zodToConvex(sessionNotificationKindValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chat);
    if (!chat) return null;

    await notify(ctx, {
      userId: args.userId,
      ...(chat.workspace ? { workspace: chat.workspace } : {}),
      kind: args.kind,
      chat: args.chat,
      createdAt: Date.now(),
    });
    return null;
  },
});
