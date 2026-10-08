import { v, type Infer } from "convex/values";
import { workerEditRequest, workerEditResult } from "./edit-contract";
import { chatWorkerToolValidator } from "./chat-config";
import { workerBashRequest } from "./bash-contract";

/** Short-lived coordination state; durable chat-call receipts are stored separately. */
export const workerTaskStatus = v.union(
  v.literal("sent"),
  v.literal("processing"),
  v.literal("failed"),
  v.literal("retrying"),
  v.literal("success"),
);

export type WorkerTaskStatus = Infer<typeof workerTaskStatus>;

export const workerChatTool = chatWorkerToolValidator;
export type WorkerChatTool = Infer<typeof workerChatTool>;

export const workerChatStage = v.union(
  v.literal("read"),
  v.literal("preview"),
  v.literal("apply"),
  v.literal("execute"),
);
export type WorkerChatStage = Infer<typeof workerChatStage>;

/** Terminal records become eligible for deletion five minutes after completion. */
export const WORKER_TASK_RETENTION_MS = 5 * 60_000;

/** A cleanup transaction deletes at most this many records of each terminal status. */
export const WORKER_TASK_CLEANUP_BATCH = 100;

/** A chat deletion drains durable tool-call receipts in bounded batches. */
export const WORKER_CHAT_CALL_CLEANUP_BATCH = 100;

/**
 * Legacy tasks persist coordination metadata. File/Bash tasks additionally carry bounded,
 * short-lived tool requests/results; chat-call receipts persist chat dispatch outcomes.
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
  bashRequest: v.optional(workerBashRequest),
  editOwnerId: v.optional(v.string()),
  claimId: v.optional(v.string()),
  result: v.optional(workerEditResult),
};

export const workerTaskRecord = v.object({
  _id: v.id("worker_tasks"),
  _creationTime: v.number(),
  ...workerTaskFields,
});

/** Durable idempotency receipts outlive the short-lived Worker coordination tasks. */
export const workerChatCallFields = {
  workspace: v.id("workspaces"),
  chatId: v.id("aisdk_chats"),
  userId: v.string(),
  workerId: v.string(),
  directory: v.string(),
  tool: workerChatTool,
  toolCallId: v.string(),
  stage: workerChatStage,
  requestKey: v.string(),
  taskId: v.id("worker_tasks"),
  result: v.optional(workerEditResult),
  completionClaimId: v.optional(v.string()),
  completionRevision: v.optional(v.number()),
};

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
