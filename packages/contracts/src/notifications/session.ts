import { chatInterruption } from "../chatroom/interruption";
import type { SessionNotificationKind } from "./contract";

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
  const interruption = chatInterruption(end);
  if (interruption) return interruption.kind === "failed" ? "session_failed" : undefined;

  const parts = end.responseMessage.role === "assistant" ? end.responseMessage.parts : [];
  if (parts.some((part) => toolName(part) !== undefined && part.state === "approval-requested")) {
    return "session_approval";
  }
  if (parts.some((part) => toolName(part) === "question" && part.state === "input-available")) {
    return "session_question";
  }
  return end.outcome.status === "completed" ? "session_finished" : undefined;
}
