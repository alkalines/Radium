import { ConvexError, v } from "convex/values";
import { components } from "../../convex/_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { authComponent } from "../../convex/auth";
import { requireAccessibleChat, requireWorkspaceOwnedByUser } from "../../convex/workspaces";
import { workerMutation, workerQuery } from "./machine";
import {
  validWorkerEditRequest,
  workerEditDispatchRequest,
  workerEditResult,
  workerEditRequestKey,
  WORKER_EDIT_OUTPUT_BYTES,
} from "./edit-contract";
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

type DispatchScope = {
  workspace: Id<"workspaces">;
  workerId: string;
  requestId: string;
  chatId?: Id<"aisdk_chats">;
  toolCallId?: string;
};

async function authorizeDispatch(ctx: MutationCtx, args: DispatchScope) {
  const user = await authComponent.getAuthUser(ctx);
  await requireWorkspaceOwnedByUser(ctx, args.workspace, user._id);
  if (
    !args.requestId ||
    args.requestId.length > 128 ||
    (args.toolCallId !== undefined &&
      (!args.chatId || !args.toolCallId || args.toolCallId.length > 128))
  )
    return taskDenied();
  if (args.chatId) {
    const access = await requireAccessibleChat(ctx, args.chatId);
    if (access.workspace._id !== args.workspace) return taskDenied();
  }
  const worker = await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
    workspaceId: args.workspace,
    workerId: args.workerId,
  });
  if (!worker || worker.status !== "active") return taskDenied();
  return user;
}

async function existingDispatch(ctx: MutationCtx, args: DispatchScope) {
  return await ctx.db
    .query("worker_tasks")
    .withIndex("by_worker_request", (q) =>
      q
        .eq("workspace", args.workspace)
        .eq("workerId", args.workerId)
        .eq("requestId", args.requestId),
    )
    .unique();
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
    await authorizeDispatch(ctx, args);
    if (!args.operation.trim() || args.operation.length > 80) return taskDenied();
    const existing = await existingDispatch(ctx, args);

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
  args: { status: workerTaskStatus, operation: v.optional(v.literal("edit")) },
  returns: v.array(workerTaskRecord),
  handler: async (ctx, args) =>
    await ctx.db
      .query("worker_tasks")
      .withIndex("by_worker_status", (q) => {
        const scoped = q
          .eq("workspace", ctx.worker.workspaceId)
          .eq("workerId", ctx.worker.workerId)
          .eq("status", args.status);
        return args.operation ? scoped.eq("operation", args.operation) : scoped;
      })
      .take(4),
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
      task.editRequest !== undefined ||
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

/** Owner-only edit dispatch. Each apply request explicitly selects a staged preview. */
export const dispatchEdit = mutation({
  args: {
    workspace: v.id("workspaces"),
    workerId: v.string(),
    requestId: v.string(),
    request: workerEditDispatchRequest,
    chatId: v.optional(v.id("aisdk_chats")),
    toolCallId: v.optional(v.string()),
  },
  returns: v.id("worker_tasks"),
  handler: async (ctx, args) => {
    const user = await authorizeDispatch(ctx, args);
    if (!validWorkerEditRequest(args.request)) return taskDenied();
    const existing = await existingDispatch(ctx, args);
    if (existing) {
      if (
        existing.operation !== "edit" ||
        existing.editOwnerId !== user._id ||
        existing.chatId !== args.chatId ||
        existing.toolCallId !== args.toolCallId ||
        !existing.editRequest ||
        workerEditRequestKey(existing.editRequest) !== workerEditRequestKey(args.request)
      )
        return taskDenied();
      return existing._id;
    }
    return await ctx.db.insert("worker_tasks", {
      workspace: args.workspace,
      workerId: args.workerId,
      requestId: args.requestId,
      operation: "edit",
      editRequest: args.request,
      editOwnerId: user._id,
      chatId: args.chatId,
      toolCallId: args.toolCallId,
      status: "sent",
      revision: 0,
      attempt: 0,
      updatedAt: Date.now(),
    });
  },
});

/** Subscribe to one task's output with the same owner/private-chat policy as dispatch. */
export const outcome = query({
  args: { workspace: v.id("workspaces"), taskId: v.id("worker_tasks") },
  returns: v.union(v.null(), workerTaskRecord),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    await requireWorkspaceOwnedByUser(ctx, args.workspace, user._id);
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    if (task.workspace !== args.workspace || (task.editOwnerId && task.editOwnerId !== user._id))
      return taskDenied();
    if (task.chatId) await requireAccessibleChat(ctx, task.chatId);
    return task;
  },
});

async function assignedEdit(
  ctx: MutationCtx & { worker: { workspaceId: string; workerId: string } },
  taskId: Id<"worker_tasks">,
) {
  const task = await ctx.db.get(taskId);
  if (
    !task ||
    !task.editRequest ||
    task.workspace !== ctx.worker.workspaceId ||
    task.workerId !== ctx.worker.workerId
  )
    return taskDenied();
  return task;
}

/** A per-process claim token prevents two connections from both executing a task. */
export const claimEdit = workerMutation({
  args: { taskId: v.id("worker_tasks"), claimId: v.string() },
  returns: v.union(v.null(), workerTaskRecord),
  handler: async (ctx, args) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.claimId)) return taskDenied();
    const task = await assignedEdit(ctx, args.taskId);
    if (task.status === "processing" && task.claimId === args.claimId) return task;
    if (task.status !== "sent") return null;
    const patch = {
      status: "processing" as const,
      claimId: args.claimId,
      revision: task.revision + 1,
      attempt: task.attempt + 1,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(task._id, patch);
    return { ...task, ...patch };
  },
});

/** Complete once; repeating an identical receipt is safe, execution itself is never retried. */
export const completeEdit = workerMutation({
  args: {
    taskId: v.id("worker_tasks"),
    claimId: v.string(),
    expectedRevision: v.number(),
    result: workerEditResult,
  },
  returns: workerTaskRecord,
  handler: async (ctx, args) => {
    const task = await assignedEdit(ctx, args.taskId);
    if (
      task.claimId !== args.claimId ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      return taskDenied();
    if (
      (args.result.output !== undefined &&
        new TextEncoder().encode(args.result.output).length > WORKER_EDIT_OUTPUT_BYTES) ||
      (!args.result.ok && !/^[A-Z0-9_]{1,80}$/.test(args.result.code))
    )
      return taskDenied();
    if (
      task.revision === args.expectedRevision + 1 &&
      task.result &&
      task.result.ok === args.result.ok &&
      (task.result.ok && args.result.ok
        ? task.result.output === args.result.output
        : !task.result.ok &&
          !args.result.ok &&
          task.result.code === args.result.code &&
          task.result.output === args.result.output)
    )
      return task;
    if (task.status !== "processing" || task.revision !== args.expectedRevision) {
      throw new ConvexError({ code: "WORKER_TASK_STALE_REVISION" });
    }
    const now = Date.now();
    const patch = {
      status: args.result.ok ? ("success" as const) : ("failed" as const),
      result: args.result,
      revision: task.revision + 1,
      updatedAt: now,
      terminalAt: now,
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
