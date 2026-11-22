import { z } from "zod";
import type { ChatRequestEnd } from "../notifications/session";

/**
 * How a chat's latest request stopped before its reply finished, stored on the chat so the
 * Session can offer to continue it after a reload. `interrupted`: the user stopped it or the
 * browser went away. `failed`: an error ended it. `step_limit`: the model was still calling
 * tools when the request reached its step cap. The chat HTTP action clears it when the next
 * request starts and records it when one ends.
 *
 * New interruptions never carry error text: provider errors can echo prompts or account data, and
 * the stored chat must stay free of readable content. The Session that ran the request shows the
 * streamed error transiently; after a reload it shows a fixed generic line. `message` survives
 * only on historical rows: a non-empty value is legacy plaintext, and the empty string marks text
 * that moved into the chat's sealed sidecar (`e2ee/migration-chat.ts`).
 */
export const chatInterruptionValidator = z.object({
  kind: z.union([z.literal("interrupted"), z.literal("failed"), z.literal("step_limit")]),
  message: z.optional(z.string()),
});
export type ChatInterruption = z.infer<typeof chatInterruptionValidator>;

/**
 * The interruption one request end leaves on its chat, or `undefined` when it ended normally
 * (finished, or waiting on an approval or question). A stop wins over an error, since the error
 * is then a consequence of the stop. `stepLimitReached` means the last step still asked for tool
 * calls when the step cap ended it.
 */
export function chatInterruption(
  end: ChatRequestEnd,
  stepLimitReached = false,
): ChatInterruption | undefined {
  if (end.isAborted || end.isCancelled || end.outcome.status === "aborted") {
    return { kind: "interrupted" };
  }
  if (end.failed || end.outcome.status === "failed") return { kind: "failed" };
  if (stepLimitReached) return { kind: "step_limit" };
  return undefined;
}
