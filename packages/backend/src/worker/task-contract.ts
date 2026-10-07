import { v, type Infer } from "convex/values";
import { workerEditRequest, workerEditResult } from "./edit-contract";

/** Short-lived coordination state; chats remain the owner of tool-call history. */
export const workerTaskStatus = v.union(
  v.literal("sent"),
  v.literal("processing"),
  v.literal("failed"),
  v.literal("retrying"),
  v.literal("success"),
);

export type WorkerTaskStatus = Infer<typeof workerTaskStatus>;

/** Terminal records become eligible for deletion five minutes after completion. */
export const WORKER_TASK_RETENTION_MS = 5 * 60_000;

/** A cleanup transaction deletes at most this many records of each terminal status. */
export const WORKER_TASK_CLEANUP_BATCH = 100;

/**
 * Legacy tasks persist coordination metadata. Edit tasks additionally carry bounded,
 * short-lived tool requests/results; chats remain the durable history owner.
 * `requestId` deduplicates dispatch to one Worker; `revision` fences stale status
 * updates and `attempt` counts starts, including explicitly requested retries.
 */
export const workerTaskFields = {
  workspace: v.id("workspaces"),
  workerId: v.string(),
  requestId: v.string(),
  operation: v.string(),
  chatId: v.optional(v.id("aisdk_chats")),
  toolCallId: v.optional(v.string()),
  status: workerTaskStatus,
  revision: v.number(),
  attempt: v.number(),
  updatedAt: v.number(),
  terminalAt: v.optional(v.number()),
  editRequest: v.optional(workerEditRequest),
  editOwnerId: v.optional(v.string()),
  claimId: v.optional(v.string()),
  result: v.optional(workerEditResult),
};

export const workerTaskRecord = v.object({
  _id: v.id("worker_tasks"),
  _creationTime: v.number(),
  ...workerTaskFields,
});

/**
 * Retries are explicit state changes, never automatic execution retries.
 * Success is immutable; failure may be retried until its record is cleaned up.
 */
export function canTransitionWorkerTask(from: WorkerTaskStatus, to: WorkerTaskStatus): boolean {
  switch (from) {
    case "sent":
    case "retrying":
      return to === "processing";
    case "processing":
      return to === "retrying" || to === "failed" || to === "success";
    case "failed":
      return to === "retrying";
    case "success":
      return false;
  }
}
