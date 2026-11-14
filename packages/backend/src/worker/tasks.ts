import { ConvexError, v } from "convex/values";
import { components, internal } from "../../convex/_generated/api";
import {
  internalQuery,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { authComponent } from "../../convex/auth";
import {
  authorizeChatRecord,
  requireAccessibleChat,
  requireWorkspaceOwnedByUser,
} from "../../convex/workspaces";
import { requireDispatchableWorker } from "../e2ee/worker-keys";
import { workerMutation, workerQuery } from "./machine";
import { chatWorkerSessionId, validChatWorkerDirectory } from "./chat-config";
import {
  workerBashRequest,
  validWorkerBashRequest,
  workerBashRequestKey,
  WORKER_BASH_OUTPUT_BYTES,
  type WorkerBashRequest,
} from "./bash-contract";
import {
  validWorkerEditRequest,
  workerEditDispatchRequest,
  workerEditResult,
  workerEditRequestKey,
  WORKER_EDIT_OUTPUT_BYTES,
  type WorkerEditRequest,
  type WorkerEditResult,
} from "./edit-contract";
import {
  canTransitionWorkerTask,
  WORKER_CHAT_CALL_CLEANUP_BATCH,
  WORKER_SEALED_REQUEST_BYTES,
  WORKER_SEALED_RESULT_BYTES,
  WORKER_TASK_CLEANUP_BATCH,
  WORKER_TASK_ENCAPSULATED_BYTES,
  WORKER_TASK_RETENTION_MS,
  workerChatStage,
  workerChatStageMatchesTool,
  workerChatTaskRequestId,
  workerChatTool,
  workerSealedTask,
  type WorkerChatTool,
  type WorkerChatStage,
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
  if (!worker || worker.status !== "active") {
    return taskDenied();
  }
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
  args: {
    status: workerTaskStatus,
    operation: v.optional(v.union(v.literal("edit"), v.literal("bash"))),
  },
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
      task.bashRequest !== undefined ||
      task.sealed !== undefined ||
      task.workspace !== ctx.worker.workspaceId ||
      task.workerId !== ctx.worker.workerId ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    ) {
      return taskDenied();
    }

    if (task.revision === args.expectedRevision + 1 && task.status === args.status) {
      return task;
    }
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

/** Recheck chat visibility, owner-selected assignment, and active Worker before dispatch. */
async function authorizeChatWorkerDispatch(
  ctx: MutationCtx,
  args: {
    chatId: Id<"aisdk_chats">;
    userId: string;
    workerId: string;
    directory: string;
    tool: WorkerChatTool;
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

  // Tools may be chosen before a Worker; dispatch needs the stored Worker and derived directory.
  const selection = chat.worker;
  const directory = selection?.directory;
  const workerId = selection?.workerId;
  if (
    !selection ||
    workerId === undefined ||
    workerId !== args.workerId ||
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
      workerId,
    });
  } catch {
    return taskDenied();
  }
  if (
    !worker ||
    worker.workerId !== workerId ||
    worker.workspaceId !== workspace._id ||
    worker.status !== "active"
  )
    return taskDenied();

  return { workspace, directory, chat };
}

function previewIdFromResult(result: WorkerEditResult | undefined): string | null {
  if (!result?.ok || new TextEncoder().encode(result.output).length > WORKER_EDIT_OUTPUT_BYTES)
    return null;
  try {
    const value: unknown = JSON.parse(result.output);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const preview = value as { ok?: unknown; action?: unknown; previewId?: unknown };
    if (
      preview.ok !== true ||
      preview.action !== "preview" ||
      typeof preview.previewId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(preview.previewId)
    ) {
      return null;
    }
    return preview.previewId;
  } catch {
    return null;
  }
}

/**
 * A tool-call ID stays bound to its original assignment across all stages. Returns this stage's
 * existing receipt, if any, after checking every stage of the call against the assignment.
 */
async function boundChatCallStage(
  ctx: MutationCtx,
  args: {
    chatId: Id<"aisdk_chats">;
    userId: string;
    workerId: string;
    tool: WorkerChatTool;
    toolCallId: string;
    stage: WorkerChatStage;
  },
  assignment: { workspace: { _id: Id<"workspaces"> }; directory: string },
) {
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

  return {
    existing: callStages.find((call) => call.stage === args.stage) ?? null,
    preview: callStages.find((call) => call.stage === "preview") ?? null,
  };
}

/** Owner of a live user workspace reading its own chat's Worker state from the chat action. */
async function authorizeChatOwner(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"aisdk_chats">,
  userId: string,
) {
  const authorized = await authorizeChatRecord(ctx, chatId, userId);
  if (
    !authorized ||
    authorized.workspace.ownerType !== "user" ||
    authorized.workspace.archivedAt !== undefined ||
    authorized.workspace.ownerId !== userId
  )
    return taskDenied();
  return authorized;
}

/**
 * Dispatch one approved Chatroom file or Bash stage under the chat's current owner-selected
 * Worker and directory. Durable receipts make each call/stage one-shot beyond task cleanup;
 * a new apply stage must match that call's persisted preview receipt. Task and receipt creation
 * share this mutation so a retry cannot leave an untracked assignment.
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
    request: v.union(workerEditDispatchRequest, workerBashRequest),
  },
  returns: v.object({ taskId: v.id("worker_tasks") }),
  handler: async (ctx, args) => {
    if (!args.userId || !args.toolCallId || args.toolCallId.length > 128) return taskDenied();

    const assignment = await authorizeChatWorkerDispatch(ctx, args);
    if (args.request.directory !== args.directory) return taskDenied();
    // Plaintext requests are only for keyless workspaces and chats without keys; a certified
    // Worker gets sealed requests, and an encrypted chat never stores plaintext tool content.
    if (assignment.chat.e2eeId) return taskDenied();
    if (await requireDispatchableWorker(ctx, assignment.workspace._id, args.workerId)) {
      return taskDenied();
    }

    const bash = args.tool === "bash";
    let expectedAction: "read" | "preview" | "apply" | null = null;
    if (args.tool === "read") {
      if (args.stage === "read") expectedAction = "read";
    } else if (args.stage === "preview") {
      expectedAction = "preview";
    } else if (args.stage === "apply") {
      expectedAction = "apply";
    }

    const sessionId = await chatWorkerSessionId(args.chatId, assignment.directory);
    let editRequest: WorkerEditRequest | undefined;
    let bashRequest: WorkerBashRequest | undefined;
    let requestKey: string;
    if (bash) {
      if (args.stage !== "execute" || !("command" in args.request)) return taskDenied();
      const request = { ...args.request, sessionId, directory: assignment.directory };
      if (!validWorkerBashRequest(request)) return taskDenied();
      bashRequest = request;
      requestKey = await workerBashRequestKey(request);
    } else {
      if (
        !("action" in args.request) ||
        !expectedAction ||
        args.request.action.kind !== expectedAction
      )
        return taskDenied();

      let writeMode: "edit" | "create" | undefined;
      if (args.tool === "edit") writeMode = "edit";
      if (args.tool === "create") writeMode = "create";

      const request = {
        ...args.request,
        sessionId,
        directory: assignment.directory,
        writeMode,
      };
      if (!validWorkerEditRequest(request)) return taskDenied();
      editRequest = request;
      requestKey = workerEditRequestKey(request);
    }

    const { existing: existingCall, preview: previewCall } = await boundChatCallStage(
      ctx,
      args,
      assignment,
    );
    if (existingCall) {
      if (existingCall.requestKey !== requestKey) return taskDenied();
      return { taskId: existingCall.taskId };
    }

    // A first-time apply must reference the successful preview receipt for this call.
    if (args.stage === "apply") {
      if (!("action" in args.request) || args.request.action.kind !== "apply") return taskDenied();
      if (!previewCall || previewIdFromResult(previewCall.result) !== args.request.action.previewId)
        return taskDenied();
    }

    const requestId = await workerChatTaskRequestId(args.chatId, args.toolCallId, args.stage);
    const existingTask = await existingDispatch(ctx, {
      workspace: assignment.workspace._id,
      workerId: args.workerId,
      requestId,
    });
    let taskId: Id<"worker_tasks">;
    if (existingTask) {
      if (
        existingTask.operation !== (bash ? "bash" : "edit") ||
        existingTask.editOwnerId !== args.userId ||
        existingTask.chatId !== args.chatId ||
        existingTask.toolCallId !== args.toolCallId
      )
        return taskDenied();

      let existingRequestKey: string | undefined;
      if (bash && existingTask.bashRequest) {
        existingRequestKey = await workerBashRequestKey(existingTask.bashRequest);
      } else if (!bash && existingTask.editRequest) {
        existingRequestKey = workerEditRequestKey(existingTask.editRequest);
      }
      if (existingRequestKey !== requestKey) return taskDenied();

      taskId = existingTask._id;
    } else {
      taskId = await ctx.db.insert("worker_tasks", {
        workspace: assignment.workspace._id,
        workerId: args.workerId,
        requestId,
        operation: bash ? "bash" : "edit",
        editRequest,
        bashRequest,
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
      completionClaimId: existingTask?.result ? existingTask.claimId : undefined,
      completionRevision: existingTask?.result ? existingTask.revision : undefined,
    });
    return { taskId };
  },
});

/**
 * Choose how the chat action reaches the selected Worker: `null` for the plaintext path (keyless
 * workspace), otherwise the certified encryption key to seal requests to. Throws
 * `WORKER_NOT_PAIRED` when the workspace has keys and the Worker is not in the latest roster.
 */
export const chatWorkerTarget = internalQuery({
  args: { chatId: v.id("aisdk_chats"), userId: v.string(), workerId: v.string() },
  returns: v.union(v.null(), v.object({ keyId: v.string(), encryptionPublicKey: v.bytes() })),
  handler: async (ctx, args) => {
    const { workspace } = await authorizeChatOwner(ctx, args.chatId, args.userId);
    const keys = await requireDispatchableWorker(ctx, workspace._id, args.workerId);
    return keys ? { keyId: keys.keyId, encryptionPublicKey: keys.encryptionPublicKey } : null;
  },
});

/**
 * Dispatch one sealed built-in tool stage to a paired Worker. The backend checks only metadata it
 * still sees (owner, chat, selected Worker/directory/tool, stage shape, byte bounds, the Worker's
 * current certified key) and stores bytes; the Worker opens the request and checks the user's
 * signature. A call/stage dispatched before is reported as `replay` and never queued again: its
 * result was sealed to an earlier request key the caller no longer holds.
 */
export const dispatchSealedChatTask = internalMutation({
  args: {
    chatId: v.id("aisdk_chats"),
    userId: v.string(),
    workerId: v.string(),
    directory: v.string(),
    tool: workerChatTool,
    toolCallId: v.string(),
    stage: workerChatStage,
    sealed: workerSealedTask,
    receiptEpoch: v.optional(v.number()),
  },
  returns: v.object({ taskId: v.id("worker_tasks"), replay: v.boolean() }),
  handler: async (ctx, args) => {
    if (
      !args.userId ||
      !args.toolCallId ||
      args.toolCallId.length > 128 ||
      !workerChatStageMatchesTool(args.tool, args.stage) ||
      args.sealed.encapsulated.byteLength !== WORKER_TASK_ENCAPSULATED_BYTES ||
      args.sealed.request.byteLength === 0 ||
      args.sealed.request.byteLength > WORKER_SEALED_REQUEST_BYTES ||
      (args.receiptEpoch !== undefined &&
        (!Number.isSafeInteger(args.receiptEpoch) || args.receiptEpoch < 0))
    )
      return taskDenied();

    const assignment = await authorizeChatWorkerDispatch(ctx, args);
    // The request is sealed to one key; a Worker re-paired since could not open it.
    const keys = await requireDispatchableWorker(ctx, assignment.workspace._id, args.workerId);
    if (!keys || keys.keyId !== args.sealed.keyId) return taskDenied();

    const { existing, preview } = await boundChatCallStage(ctx, args, assignment);
    if (existing) return { taskId: existing.taskId, replay: true };
    // The Worker applies only its own preview; this only refuses an apply nothing preceded.
    if (args.stage === "apply" && preview?.completionRevision === undefined) return taskDenied();

    const requestId = await workerChatTaskRequestId(args.chatId, args.toolCallId, args.stage);
    if (
      await existingDispatch(ctx, {
        workspace: assignment.workspace._id,
        workerId: args.workerId,
        requestId,
      })
    )
      return taskDenied();

    const taskId = await ctx.db.insert("worker_tasks", {
      workspace: assignment.workspace._id,
      workerId: args.workerId,
      requestId,
      operation: args.tool === "bash" ? "bash" : "edit",
      sealed: args.sealed,
      editOwnerId: args.userId,
      chatId: args.chatId,
      toolCallId: args.toolCallId,
      status: "sent",
      revision: 0,
      attempt: 0,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("worker_chat_calls", {
      workspace: assignment.workspace._id,
      chatId: args.chatId,
      userId: args.userId,
      workerId: args.workerId,
      directory: assignment.directory,
      tool: args.tool,
      toolCallId: args.toolCallId,
      stage: args.stage,
      requestKey: requestId,
      taskId,
      receiptEpoch: args.receiptEpoch,
    });
    return { taskId, replay: false };
  },
});

/**
 * A sealed task's terminal state for the chat action that dispatched it: `result` is the Worker's
 * `sealSym` result under the request key; it is absent when the Worker could not open the request.
 * `null` while the task runs or after it was pruned.
 */
export const sealedChatTaskOutcome = internalQuery({
  args: { chatId: v.id("aisdk_chats"), userId: v.string(), taskId: v.id("worker_tasks") },
  returns: v.union(v.null(), v.object({ ok: v.boolean(), result: v.optional(v.bytes()) })),
  handler: async (ctx, args) => {
    await authorizeChatOwner(ctx, args.chatId, args.userId);
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    if (!task.sealed || task.chatId !== args.chatId || task.editOwnerId !== args.userId)
      return taskDenied();
    if (task.status !== "success" && task.status !== "failed") return null;
    return { ok: task.status === "success", result: task.sealedResult };
  },
});

/** Read one plaintext chat call's persisted result after rechecking exact chat visibility. */
export const chatEditOutcome = internalQuery({
  args: {
    chatId: v.id("aisdk_chats"),
    userId: v.string(),
    taskId: v.id("worker_tasks"),
  },
  returns: v.union(v.null(), workerEditResult),
  handler: async (ctx, args) => {
    const authorized = await authorizeChatOwner(ctx, args.chatId, args.userId);
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

/** Load an executable task and require that it belongs to the calling Worker. */
async function assignedToolTask(
  ctx: MutationCtx & { worker: { workspaceId: string; workerId: string } },
  taskId: Id<"worker_tasks">,
) {
  const task = await ctx.db.get(taskId);
  if (!task) return null;
  if (
    (!task.editRequest && !task.bashRequest && !task.sealed) ||
    task.workspace !== ctx.worker.workspaceId ||
    task.workerId !== ctx.worker.workerId
  )
    return taskDenied();
  return task;
}

/** Shared file/Bash claim: a per-process token prevents duplicate execution. */
export const claimEdit = workerMutation({
  args: { taskId: v.id("worker_tasks"), claimId: v.string() },
  returns: v.union(v.null(), workerTaskRecord),
  handler: async (ctx, args) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.claimId)) return taskDenied();
    const task = await assignedToolTask(ctx, args.taskId);
    if (!task) return taskDenied();
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

/**
 * Complete once; repeating an identical receipt is safe, execution itself is never retried.
 * A fenced durable chat receipt can acknowledge delivery after transient task pruning.
 */
export const completeEdit = workerMutation({
  args: {
    taskId: v.id("worker_tasks"),
    claimId: v.string(),
    expectedRevision: v.number(),
    result: workerEditResult,
  },
  returns: v.union(
    workerTaskRecord,
    v.object({ receiptAcknowledged: v.literal(true) }),
    v.object({ receiptDiscarded: v.literal(true) }),
  ),
  handler: async (ctx, args) => {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(args.claimId) ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      return taskDenied();
    const task = await assignedToolTask(ctx, args.taskId);
    if (!task) {
      const call = await ctx.db
        .query("worker_chat_calls")
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
        .unique();
      // No coordination or conversation record remains to accept this payload.
      // This releases delivery bookkeeping only; it makes no execution/outcome claim.
      if (!call) return { receiptDiscarded: true as const };
      if (
        call.workspace !== ctx.worker.workspaceId ||
        call.workerId !== ctx.worker.workerId ||
        call.completionClaimId !== args.claimId ||
        call.completionRevision !== args.expectedRevision + 1 ||
        !call.result ||
        !sameExecutionResult(call.result, args.result)
      )
        return taskDenied();
      return { receiptAcknowledged: true as const };
    }
    if (task.sealed || task.claimId !== args.claimId) return taskDenied();
    if (
      (args.result.output !== undefined &&
        new TextEncoder().encode(args.result.output).length >
          (task.bashRequest ? WORKER_BASH_OUTPUT_BYTES : WORKER_EDIT_OUTPUT_BYTES)) ||
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
      sameExecutionResult(task.result, args.result)
    ) {
      if (chatCall)
        await ctx.db.patch(chatCall._id, {
          result: args.result,
          completionClaimId: args.claimId,
          completionRevision: task.revision,
        });
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
    if (chatCall)
      await ctx.db.patch(chatCall._id, {
        result: args.result,
        completionClaimId: args.claimId,
        completionRevision: patch.revision,
      });
    return { ...task, ...patch };
  },
});

function sameExecutionResult(left: WorkerEditResult, right: WorkerEditResult): boolean {
  return (
    left.ok === right.ok &&
    left.output === right.output &&
    (left.ok || (!right.ok && left.code === right.code))
  );
}

function sameBytes(left: ArrayBuffer | undefined, right: ArrayBuffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((byte, index) => byte === b[index]);
}

/**
 * Complete a sealed task once. `result` is the Worker's `sealSym` result under the request key
 * (absent only when the Worker could not open the request); `receipt` is the durable receipt sealed
 * to the chat key epoch named at dispatch (required exactly when the call recorded one and a result
 * exists). `ok` is the Worker's own status claim. The Worker seals once and retries the same bytes,
 * so an identical repeat (or an acknowledgment after the task was pruned) is idempotent.
 */
export const completeSealedTask = workerMutation({
  args: {
    taskId: v.id("worker_tasks"),
    claimId: v.string(),
    expectedRevision: v.number(),
    ok: v.boolean(),
    result: v.optional(v.bytes()),
    receipt: v.optional(v.bytes()),
  },
  returns: v.union(
    v.object({ completed: v.literal(true) }),
    v.object({ receiptAcknowledged: v.literal(true) }),
    v.object({ receiptDiscarded: v.literal(true) }),
  ),
  handler: async (ctx, args) => {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(args.claimId) ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0 ||
      (args.result !== undefined &&
        (args.result.byteLength === 0 || args.result.byteLength > WORKER_SEALED_RESULT_BYTES)) ||
      (args.receipt !== undefined &&
        (args.receipt.byteLength === 0 || args.receipt.byteLength > WORKER_SEALED_RESULT_BYTES)) ||
      (args.receipt !== undefined && args.result === undefined) ||
      (args.ok && args.result === undefined)
    )
      return taskDenied();

    const task = await assignedToolTask(ctx, args.taskId);
    const chatCall = await ctx.db
      .query("worker_chat_calls")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (!task) {
      // No coordination or conversation record remains to accept this payload.
      if (!chatCall) return { receiptDiscarded: true as const };
      if (
        chatCall.workspace !== ctx.worker.workspaceId ||
        chatCall.workerId !== ctx.worker.workerId ||
        chatCall.completionClaimId !== args.claimId ||
        chatCall.completionRevision !== args.expectedRevision + 1 ||
        !sameBytes(chatCall.sealedResult, args.receipt)
      )
        return taskDenied();
      return { receiptAcknowledged: true as const };
    }
    if (!task.sealed || task.claimId !== args.claimId) return taskDenied();
    // A receipt goes only where dispatch named a chat key epoch, and always accompanies a result.
    if (
      chatCall &&
      (chatCall.receiptEpoch === undefined
        ? args.receipt !== undefined
        : args.result !== undefined && args.receipt === undefined)
    )
      return taskDenied();

    const status = args.ok ? ("success" as const) : ("failed" as const);
    if (
      task.revision === args.expectedRevision + 1 &&
      task.status === status &&
      sameBytes(task.sealedResult, args.result)
    )
      return { completed: true as const };
    if (task.status !== "processing" || task.revision !== args.expectedRevision) {
      throw new ConvexError({ code: "WORKER_TASK_STALE_REVISION" });
    }

    const now = Date.now();
    const revision = task.revision + 1;
    await ctx.db.patch(task._id, {
      status,
      sealedResult: args.result,
      revision,
      updatedAt: now,
      terminalAt: now,
    });
    if (chatCall)
      await ctx.db.patch(chatCall._id, {
        sealedResult: args.receipt,
        completionClaimId: args.claimId,
        completionRevision: revision,
      });
    return { completed: true as const };
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
