import { v, type Infer } from "convex/values";
import type { ChatRequestEnd } from "../notifications/session";

/**
 * How a chat's latest request stopped before its reply finished, stored on the chat so the
 * Session can offer to continue it after a reload. `interrupted`: the user stopped it or the
 * browser went away. `failed`: an error ended it; `message` is the error the client was shown.
 * The chat HTTP action clears it when the next request starts and records it when one ends.
 */
export const chatInterruptionValidator = v.object({
  kind: v.union(v.literal("interrupted"), v.literal("failed")),
  message: v.optional(v.string()),
});
export type ChatInterruption = Infer<typeof chatInterruptionValidator>;

/**
 * The interruption one request end leaves on its chat, or `undefined` when it ended normally
 * (finished, or waiting on an approval or question). A stop wins over an error, since the error
 * is then a consequence of the stop. `failure` is the formatted error streamed to the client.
 */
export function chatInterruption(
  end: ChatRequestEnd,
  failure?: string,
): ChatInterruption | undefined {
  if (end.isAborted || end.isCancelled || end.outcome.status === "aborted") {
    return { kind: "interrupted" };
  }
  if (end.failed || end.outcome.status === "failed") {
    return failure ? { kind: "failed", message: failure } : { kind: "failed" };
  }
  return undefined;
}
