import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

/**
 * One relay cleanup parked by the encryption cutover freeze (`acp_deferred_cleanups`). Cleanup jobs that
 * were already queued must not delete legacy relay frames while the freeze lets the seal run capture
 * them, and must not be lost either. Entries hold only the operation kind and its identifier arguments,
 * never content. `key` dedupes one parked operation per kind, chat and epoch; the first entry keeps its
 * `cutoff`, which only ever makes the resumed cleanup more conservative.
 *
 * This module is pure (no schema import) so `schema.ts` can use the validator without an import cycle.
 */
export const acpDeferredCleanupValidator = v.union(
  v.object({
    kind: v.literal("clearColdChat"),
    key: v.string(),
    chat: v.id("aisdk_chats"),
    epoch: v.number(),
    cutoff: v.number(),
  }),
  v.object({
    kind: v.literal("deleteStream"),
    key: v.string(),
    chat: v.id("aisdk_chats"),
    epoch: v.number(),
  }),
);

/** Dedupe key of a parked cleanup. */
export function deferredCleanupKey(kind: "clearColdChat" | "deleteStream", chat: string, epoch: number): string {
  return `${kind}:${chat}:${epoch}`;
}

/**
 * Cutover hook: schedule this (empty args) from the same transaction that unfreezes writes
 * (`setFrozen(false)` and `finishCutover`) so cleanups parked by the freeze run again. It is a no-op
 * while frozen again, and drains the journal in bounded batches without any timed retry.
 */
export const resumeDeferredCleanupReference = makeFunctionReference<"mutation", Record<string, never>, null>(
  "acp:resumeDeferredCleanup",
);
