import { ConvexError, v } from "convex/values";
import { components, internal } from "../../convex/_generated/api";
import {
  internalQuery,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { authComponent } from "../../convex/auth";
import {
  authorizeChatRecord,
  requireAccessibleChat,
  requireWorkspaceOwnedByUser,
} from "../../convex/workspaces";
import { workerMutation, workerQuery } from "./machine";
import { chatWorkerSessionId, validChatWorkerDirectory } from "./chat-config";
import {
  validWorkerEditRequest,
  workerEditDispatchRequest,
  workerEditResult,
  workerEditRequestKey,
  WORKER_EDIT_OUTPUT_BYTES,
  type WorkerEditResult,
} from "./edit-contract";
import {
  canTransitionWorkerTask,
  WORKER_CHAT_CALL_CLEANUP_BATCH,
  WORKER_TASK_CLEANUP_BATCH,
  WORKER_TASK_RETENTION_MS,
  workerChatStage,
  workerChatTool,
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

async function authorizeChatWorkerDispatch(
  ctx: MutationCtx,
  args: {
    chatId: Id<"aisdk_chats">;
    userId: string;
    workerId: string;
    directory: string;
    tool: "read" | "edit" | "create";
  },
) {
  const authorized = await authorizeChatRecord(ctx, args.chatId, args.userId);
  if (!authorized) return taskDenied();

  const { chat, workspace } = authorized;
  if (
    workspace.ownerType !== "user" ||
    workspace.archivedAt !== undefined ||
    workspace.ownerId !== args.userId
  )
    return taskDenied();

  const selection = chat.worker;
  const directory = selection?.directory;
  if (
    !selection ||
    selection.workerId !== args.workerId ||
    typeof directory !== "string" ||
    !validChatWorkerDirectory(directory) ||
    args.directory !== directory ||
    !selection.tools.includes(args.tool)
  )
    return taskDenied();

  let worker: { workerId: string; workspaceId: string; status: string } | null;
  try {
    worker = await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId: workspace._id,
      workerId: selection.workerId,
    });
  } catch {
    return taskDenied();
  }
  if (
    !worker ||
    worker.workerId !== selection.workerId ||
    worker.workspaceId !== workspace._id ||
    worker.status !== "active"
  )
    return taskDenied();

  return { workspace, directory };
}

function previewIdFromResult(result: WorkerEditResult | undefined): string | null {
  if (!result?.ok || new TextEncoder().encode(result.output).length > WORKER_EDIT_OUTPUT_BYTES)
    return null;
  try {
    const value: unknown = JSON.parse(result.output);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const preview = value as { ok?: unknown; action?: unknown; previewId?: unknown };
    return preview.ok === true &&
      preview.action === "preview" &&
      typeof preview.previewId === "string" &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(preview.previewId)
      ? preview.previewId
      : null;
  } catch {
    return null;
  }
}

async function chatTaskRequestId(
  chatId: Id<"aisdk_chats">,
  toolCallId: string,
  stage: "read" | "preview" | "apply",
): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([chatId, toolCallId, stage]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `chat-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Dispatch one approved Chatroom Worker stage under the chat's current owner-selected
 * Worker and directory. Durable receipts make each call/stage one-shot beyond task cleanup.
 */
export const dispatchChatEdit = internalMutation({
  args: {
    chatId: v.id("aisdk_chats"),
    userId: v.string(),
    workerId: v.string(),
    directory: v.string(),
    tool: workerChatTool,
    toolCallId: v.string(),
    stage: workerChatStage,
    request: workerEditDispatchRequest,
  },
  returns: v.object({ taskId: v.id("worker_tasks") }),
  handler: async (ctx, args) => {
    if (!args.userId || !args.toolCallId || args.toolCallId.length > 128) return taskDenied();

    const assignment = await authorizeChatWorkerDispatch(ctx, args);
    if (args.request.directory !== args.directory) return taskDenied();

    const expectedAction =
      args.tool === "read"
        ? args.stage === "read"
          ? "read"
          : null
        : args.stage === "preview"
          ? "preview"
          : args.stage === "apply"
            ? "apply"
            : null;
    if (!expectedAction || args.request.action.kind !== expectedAction) return taskDenied();

    const sessionId = await chatWorkerSessionId(args.chatId, assignment.directory);
    const request = {
      ...args.request,
      sessionId,
      directory: assignment.directory,
      writeMode: args.tool === "read" ? undefined : args.tool,
    };
    if (!validWorkerEditRequest(request)) return taskDenied();
    const requestKey = workerEditRequestKey(request);

    const callStages = await ctx.db
      .query("worker_chat_calls")
      .withIndex("by_chat_call_stage", (q) =>
        q.eq("chatId", args.chatId).eq("toolCallId", args.toolCallId),
      )
      .take(4);
    if (
      callStages.length > 3 ||
      callStages.some(
        (call) =>
          call.workspace !== assignment.workspace._id ||
          call.userId !== args.userId ||
          call.workerId !== args.workerId ||
          call.directory !== assignment.directory ||
          call.tool !== args.tool,
      )
    )
      return taskDenied();

    const existingCall = await ctx.db
      .query("worker_chat_calls")
      .withIndex("by_chat_call_stage", (q) =>
        q.eq("chatId", args.chatId).eq("toolCallId", args.toolCallId).eq("stage", args.stage),
      )
      .unique();
    if (existingCall) {
      if (
        existingCall.workspace !== assignment.workspace._id ||
        existingCall.userId !== args.userId ||
        existingCall.workerId !== args.workerId ||
        existingCall.directory !== assignment.directory ||
        existingCall.tool !== args.tool ||
        existingCall.requestKey !== requestKey
      )
        return taskDenied();
      return { taskId: existingCall.taskId };
    }

    if (args.stage === "apply") {
      if (args.request.action.kind !== "apply") return taskDenied();
      const previewCall = await ctx.db
        .query("worker_chat_calls")
        .withIndex("by_chat_call_stage", (q) =>
          q.eq("chatId", args.chatId).eq("toolCallId", args.toolCallId).eq("stage", "preview"),
        )
        .unique();
      if (
        !previewCall ||
        previewCall.workspace !== assignment.workspace._id ||
        previewCall.userId !== args.userId ||
        previewCall.workerId !== args.workerId ||
        previewCall.directory !== assignment.directory ||
        previewCall.tool !== args.tool ||
        previewIdFromResult(previewCall.result) !== args.request.action.previewId
      )
        return taskDenied();
    }

    const requestId = await chatTaskRequestId(args.chatId, args.toolCallId, args.stage);
    const existingTask = await existingDispatch(ctx, {
      workspace: assignment.workspace._id,
      workerId: args.workerId,
      requestId,
    });
    let taskId: Id<"worker_tasks">;
    if (existingTask) {
      if (
        existingTask.operation !== "edit" ||
        existingTask.editOwnerId !== args.userId ||
        existingTask.chatId !== args.chatId ||
        existingTask.toolCallId !== args.toolCallId ||
        !existingTask.editRequest ||
        workerEditRequestKey(existingTask.editRequest) !== requestKey
      )
        return taskDenied();
      taskId = existingTask._id;
    } else {
      taskId = await ctx.db.insert("worker_tasks", {
        workspace: assignment.workspace._id,
        workerId: args.workerId,
        requestId,
        operation: "edit",
        editRequest: request,
        editOwnerId: args.userId,
        chatId: args.chatId,
        toolCallId: args.toolCallId,
        status: "sent",
        revision: 0,
        attempt: 0,
        updatedAt: Date.now(),
      });
    }

    await ctx.db.insert("worker_chat_calls", {
      workspace: assignment.workspace._id,
      chatId: args.chatId,
      userId: args.userId,
      workerId: args.workerId,
      directory: assignment.directory,
      tool: args.tool,
      toolCallId: args.toolCallId,
      stage: args.stage,
      requestKey,
      taskId,
      result: existingTask?.result,
    });
    return { taskId };
  },
});

/** Read one chat call's persisted result after rechecking exact chat visibility. */
export const chatEditOutcome = internalQuery({
  args: {
    chatId: v.id("aisdk_chats"),
    userId: v.string(),
    taskId: v.id("worker_tasks"),
  },
  returns: v.union(v.null(), workerEditResult),
  handler: async (ctx, args) => {
    const authorized = await authorizeChatRecord(ctx, args.chatId, args.userId);
    if (
      !authorized ||
      authorized.workspace.ownerType !== "user" ||
      authorized.workspace.archivedAt !== undefined ||
      authorized.workspace.ownerId !== args.userId
    )
      return taskDenied();

    const call = await ctx.db
      .query("worker_chat_calls")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (
      !call ||
      call.chatId !== args.chatId ||
      call.workspace !== authorized.workspace._id ||
      call.userId !== args.userId
    )
      return null;
    return call.result ?? null;
  },
});

/** Delete durable call receipts only after their parent chat has been removed. */
export const cleanupChatCalls = internalMutation({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args) => {
    if (await ctx.db.get("aisdk_chats", args.chatId)) return null;

    const calls = await ctx.db
      .query("worker_chat_calls")
      .withIndex("by_chat_call_stage", (q) => q.eq("chatId", args.chatId))
      .take(WORKER_CHAT_CALL_CLEANUP_BATCH);
    for (const call of calls) await ctx.db.delete(call._id);

    if (calls.length === WORKER_CHAT_CALL_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.worker_tasks.cleanupChatCalls, args);
    }
    return calls.length;
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
    const chatCall = await ctx.db
      .query("worker_chat_calls")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .unique();
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
    ) {
      if (chatCall && !chatCall.result) await ctx.db.patch(chatCall._id, { result: args.result });
      return task;
    }
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
    if (chatCall) await ctx.db.patch(chatCall._id, { result: args.result });
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
