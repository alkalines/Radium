import { ConvexError, v } from "convex/values";
import { components } from "../../convex/_generated/api";
import { internalMutation } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireAccessibleChat, requireWorkspaceOwnedByUser } from "../../convex/workspaces";
import { workerMutation, workerQuery } from "./machine";
import {
  canTransitionWorkerTask,
  WORKER_TASK_CLEANUP_BATCH,
  WORKER_TASK_RETENTION_MS,
  workerTaskRecord,
  workerTaskStatus,
} from "./task-contract";

function taskDenied(): never {
  throw new ConvexError({ code: "WORKER_TASK_DENIED" });
}

/**
 * Internal, owner-authorized dispatch metadata for a future app orchestration path.
 * A repeated request ID must describe the same assignment. No executable payload
 * is admitted here; tool approvals and execution contracts are separate work.
 */
export const create = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    workerId: v.string(),
    requestId: v.string(),
    operation: v.string(),
    chatId: v.optional(v.id("aisdk_chats")),
    toolCallId: v.optional(v.string()),
  },
  returns: v.id("worker_tasks"),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    await requireWorkspaceOwnedByUser(ctx, args.workspace, user._id);

    if (
      !args.requestId ||
      args.requestId.length > 128 ||
      !args.operation.trim() ||
      args.operation.length > 80 ||
      (args.toolCallId !== undefined &&
        (!args.chatId || !args.toolCallId || args.toolCallId.length > 128))
    ) {
      return taskDenied();
    }

    if (args.chatId) {
      const access = await requireAccessibleChat(ctx, args.chatId);
      if (access.workspace._id !== args.workspace) return taskDenied();
    }

    const worker = await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId: args.workspace,
      workerId: args.workerId,
    });
    if (!worker || worker.status !== "active") return taskDenied();

    const existing = await ctx.db
      .query("worker_tasks")
      .withIndex("by_worker_request", (q) =>
        q
          .eq("workspace", args.workspace)
          .eq("workerId", args.workerId)
          .eq("requestId", args.requestId),
      )
      .unique();

    if (existing) {
      if (
        existing.operation !== args.operation ||
        existing.chatId !== args.chatId ||
        existing.toolCallId !== args.toolCallId
      ) {
        return taskDenied();
      }

      return existing._id;
    }

    return await ctx.db.insert("worker_tasks", {
      ...args,
      status: "sent",
      revision: 0,
      attempt: 0,
      updatedAt: Date.now(),
    });
  },
});

/** Bounded subscription to one status of this machine's own assignments. */
export const assigned = workerQuery({
  args: { status: workerTaskStatus },
  returns: v.array(workerTaskRecord),
  handler: async (ctx, args) =>
    await ctx.db
      .query("worker_tasks")
      .withIndex("by_worker_status", (q) =>
        q
          .eq("workspace", ctx.worker.workspaceId)
          .eq("workerId", ctx.worker.workerId)
          .eq("status", args.status),
      )
      .take(100),
});

/**
 * Compare-and-set an assigned task's status inside the machine-authorized transaction.
 * A duplicate of the immediately preceding update is idempotent. Older revisions
 * cannot finish a later attempt; returning to processing increments `attempt`.
 */
export const updateStatus = workerMutation({
  args: {
    taskId: v.id("worker_tasks"),
    expectedRevision: v.number(),
    status: workerTaskStatus,
  },
  returns: workerTaskRecord,
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (
      !task ||
      task.workspace !== ctx.worker.workspaceId ||
      task.workerId !== ctx.worker.workerId ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    ) {
      return taskDenied();
    }

    if (task.revision === args.expectedRevision + 1 && task.status === args.status) return task;
    if (task.revision !== args.expectedRevision) {
      throw new ConvexError({ code: "WORKER_TASK_STALE_REVISION" });
    }
    if (!canTransitionWorkerTask(task.status, args.status)) {
      throw new ConvexError({ code: "WORKER_TASK_INVALID_TRANSITION" });
    }

    const now = Date.now();
    const patch = {
      status: args.status,
      revision: task.revision + 1,
      attempt: task.attempt + (args.status === "processing" ? 1 : 0),
      updatedAt: now,
      terminalAt: args.status === "failed" || args.status === "success" ? now : undefined,
    };
    await ctx.db.patch(task._id, patch);
    return { ...task, ...patch };
  },
});

/**
 * Delete only terminal coordination records aged at least five minutes.
 * Indexed, bounded batches leave active/retrying tasks and chat history intact;
 * a backlog is drained by subsequent five-minute cron ticks.
 */
export const prune = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - WORKER_TASK_RETENTION_MS;
    let deleted = 0;

    for (const status of ["failed", "success"] as const) {
      const tasks = await ctx.db
        .query("worker_tasks")
        .withIndex("by_status_terminalAt", (q) =>
          q.eq("status", status).gte("terminalAt", 0).lte("terminalAt", cutoff),
        )
        .take(WORKER_TASK_CLEANUP_BATCH);
      for (const task of tasks) {
        await ctx.db.delete(task._id);
        deleted += 1;
      }
    }

    return deleted;
  },
});
