import { v } from "convex/values";
import { internalMutation } from "../../convex/_generated/server";
import {
  notificationTitle,
  sessionNotificationKindValidator,
  type SessionNotificationKind,
} from "./contract";
import { notify } from "./notify";

type MessagePart = { type: string; state?: unknown; toolName?: unknown };

/** What `toUIMessageStream`'s `onEnd` reports about one Chatroom request. */
export type ChatRequestEnd = {
  /** The request was stopped by the user or the browser disconnected. */
  isAborted: boolean;
  isCancelled?: boolean;
  outcome: { status: string };
  /** An error chunk was streamed (the outcome may still read `completed` after one). */
  failed: boolean;
  responseMessage: { role: string; parts: readonly MessagePart[] };
};

function toolName(part: MessagePart): string | undefined {
  if (part.type === "dynamic-tool")
    return typeof part.toolName === "string" ? part.toolName : undefined;
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : undefined;
}

/**
 * Which notification, if any, the end of one Chatroom request deserves. A stopped or abandoned
 * request notifies nobody: the user stopped it or closed the tab running it. Pending approvals
 * and questions mirror the web client's `getPendingApprovals`/`getPendingQuestions`
 * (`apps/web/src/components/session/message-parts.ts`), so the notification matches the prompt
 * the Session shows.
 */
export function sessionNotificationKind(end: ChatRequestEnd): SessionNotificationKind | undefined {
  if (end.isAborted || end.isCancelled || end.outcome.status === "aborted") return undefined;
  if (end.failed || end.outcome.status === "failed") return "session_failed";

  const parts = end.responseMessage.role === "assistant" ? end.responseMessage.parts : [];
  if (parts.some((part) => toolName(part) !== undefined && part.state === "approval-requested")) {
    return "session_approval";
  }
  if (parts.some((part) => toolName(part) === "question" && part.state === "input-available")) {
    return "session_question";
  }
  return end.outcome.status === "completed" ? "session_finished" : undefined;
}

/**
 * Notify the user who sent a Chatroom request how it ended. Called by the chat HTTP action after
 * it saved the messages; the action has already authorized `userId` for the chat. The body names
 * the session (and the error for failures), so the notification never carries more of a private
 * chat than its title.
 */
export const notifySession = internalMutation({
  args: {
    userId: v.string(),
    chat: v.id("aisdk_chats"),
    kind: sessionNotificationKindValidator,
    detail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chat);
    if (!chat) return null;

    const title = chat.title?.trim() || "Untitled session";
    await notify(ctx, {
      userId: args.userId,
      ...(chat.workspace ? { workspace: chat.workspace } : {}),
      kind: args.kind,
      title: notificationTitle(args.kind),
      body: args.detail ? `${title} · ${args.detail}` : title,
      chat: args.chat,
      createdAt: Date.now(),
    });
    return null;
  },
});
