import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { equalBytes, toBase64Url } from "radium-crypto";
import { validChatWorkerDirectory } from "contracts/worker/chat-config";
import {
  WORKER_SEALED_REQUEST_BYTES,
  WORKER_SEALED_RESULT_BYTES,
  WORKER_TASK_ENCAPSULATED_BYTES,
  workerChatStageMatchesTool,
  workerChatTaskRequestId,
  type WorkerChatStage,
  type WorkerChatTool,
  type WorkerTaskStatus,
} from "contracts/worker/task-contract";
import { chatAccess } from "../chatroom/access";
import type { Database } from "../drivers/types";
import { chatKeyAt, chatEpochIsBound, chatKeyIsStale } from "../e2ee/chat-keys";
import { requireDispatchableWorker } from "../e2ee/worker-keys";
import { AppError } from "../errors";
import type { WorkerScope } from "./auth";
import { chatWorkerSelection } from "./chat-selection";
import { activeWorkspaceWorkers } from "./workers";
import { workerChatCalls, workerTasks } from "./schema";

/**
 * Sealed Worker tool tasks (Convex `src/worker/tasks.ts`, the paired-Worker path only): the chat
 * handler (Phase 4) dispatches a built-in tool stage sealed to the Worker's certified key; the
 * Worker claims it once, runs it and completes it with a result sealed under the request key and
 * a durable receipt sealed to the chat key. The backend checks metadata it still sees (owner,
 * chat, selected Worker, directory and tool, stage shape, byte bounds, the Worker's current
 * certified key) and stores bytes.
 *
 * Invariants (each with a concurrency test):
 * - dispatch dedupe: one task per `(worker, request_id)` (unique index), one receipt per call
 *   stage; a repeat is a `replay`, never a second task;
 * - claim once: `update … set status = 'processing' … where status = 'sent'`;
 * - fenced completion: `update … where status = 'processing' and claim_id = $c and revision = $r`.
 */

function taskDenied(): never {
  throw new AppError("FORBIDDEN", "WORKER_TASK_DENIED");
}

const CLAIM_ID = /^[a-zA-Z0-9_-]{1,128}$/;
/** Tasks one `assigned` read returns (Convex `take(4)`). */
const ASSIGNED_BATCH = 4;

type Task = typeof workerTasks.$inferSelect;

/** A sealed task as the Worker reads it (`worker.tasks.*`); bytes are base64url. */
export type WorkerTaskWire = {
  id: string;
  workerId: string;
  requestId: string;
  operation: string;
  chatId: string | null;
  toolCallId: string | null;
  status: WorkerTaskStatus;
  revision: number;
  attempt: number;
  updatedAt: number;
  terminalAt: number | null;
  sealed: { keyId: string; encapsulated: string; request: string };
  editOwnerId: string | null;
  claimId: string | null;
  sealedResult: string | null;
  createdAt: number;
};

function taskWire(task: Task): WorkerTaskWire {
  return {
    id: task.id,
    workerId: task.worker,
    requestId: task.requestId,
    operation: task.operation,
    chatId: task.chat,
    toolCallId: task.toolCallId,
    status: task.status,
    revision: task.revision,
    attempt: task.attempt,
    updatedAt: task.updatedAt.getTime(),
    terminalAt: task.terminalAt?.getTime() ?? null,
    sealed: {
      keyId: task.sealedKeyId!,
      encapsulated: toBase64Url(task.sealedEncapsulated!),
      request: toBase64Url(task.sealedRequest!),
    },
    editOwnerId: task.editOwnerId,
    claimId: task.claimId,
    sealedResult: task.sealedResult ? toBase64Url(task.sealedResult) : null,
    createdAt: task.createdAt.getTime(),
  };
}

/**
 * The owner of a live workspace acting in a chat they can see (Convex `authorizeChatOwner`);
 * anything else is denied.
 */
async function authorizeChatOwner(db: Database, chatId: string, userId: string) {
  const access = await chatAccess(db, userId, chatId);
  if (!access || access.workspace.ownerId !== userId) taskDenied();
  return access;
}

// ---------------------------------------------------------------------------------------------
// Chat handler side (Phase 4 wires these into `/api/chat`)

/**
 * How the chat handler reaches the selected Worker: the certified encryption key to seal
 * requests to, or `null` in a keyless workspace (where tool tasks are not available: the
 * plaintext path is not ported). Refuses with `WORKER_NOT_PAIRED` when the workspace has keys and
 * the newest roster does not certify the Worker.
 */
export async function chatWorkerTarget(
  db: Database,
  input: { chatId: string; userId: string; workerId: string },
) {
  const { workspace } = await authorizeChatOwner(db, input.chatId, input.userId);
  const keys = await requireDispatchableWorker(db, workspace.id, input.workerId);
  return keys ? { keyId: keys.keyId, encryptionPublicKey: keys.encryptionPublicKey } : null;
}

/**
 * The chat key epoch a Worker may seal a durable receipt to, with the proofs it verifies itself.
 * `null` (the call is blocked, never sealed to an unproven key) when the chat has no key, its
 * current epoch is stale, or the epoch is not bound to the chat's current audience
 * (`chatEpochIsBound`: an active signer with access, valid signature and binding over the current
 * raw members).
 */
export async function chatReceiptKey(db: Database, input: { chatId: string; userId: string }) {
  const { chat, workspace } = await authorizeChatOwner(db, input.chatId, input.userId);
  if (!chat.e2eeId || !chat.keyEpoch || (await chatKeyIsStale(db, chat, workspace))) return null;
  const key = await chatKeyAt(db, chat.id, chat.keyEpoch);
  if (
    !key?.signerKeyId ||
    !key.signature ||
    !key.bindingSignature ||
    !(await chatEpochIsBound(db, chat, workspace, key))
  ) {
    return null;
  }
  return {
    e2eeId: chat.e2eeId,
    epoch: key.epoch,
    keyId: key.keyId,
    suite: key.suite,
    publicKey: key.publicKey,
    signerKeyId: key.signerKeyId,
    signature: key.signature,
    bindingSignature: key.bindingSignature,
    scope: chat.scope,
    creatorId: chat.userId,
    members: chat.scope === "shared" ? [...(key.bindingMembers ?? [])].sort() : [],
  };
}

export type SealedChatTaskDispatch = {
  chatId: string;
  userId: string;
  workerId: string;
  directory: string;
  tool: WorkerChatTool;
  toolCallId: string;
  stage: WorkerChatStage;
  sealed: { keyId: string; encapsulated: Uint8Array; request: Uint8Array };
  receiptEpoch?: number;
};

/**
 * Dispatches one sealed built-in tool stage to the chat's selected Worker. A call stage
 * dispatched before is a `replay` and never queued again: its result was sealed to an earlier
 * request key the caller no longer holds. Task and receipt are written in one transaction; the
 * unique `(worker, request_id)` and `(chat, tool_call_id, stage)` indexes make concurrent
 * dispatches of one stage produce one task, the others replays.
 */
export async function dispatchSealedChatTask(
  db: Database,
  input: SealedChatTaskDispatch,
): Promise<{ taskId: string; replay: boolean }> {
  if (
    !input.userId ||
    !input.toolCallId ||
    input.toolCallId.length > 128 ||
    !workerChatStageMatchesTool(input.tool, input.stage) ||
    input.sealed.encapsulated.byteLength !== WORKER_TASK_ENCAPSULATED_BYTES ||
    input.sealed.request.byteLength === 0 ||
    input.sealed.request.byteLength > WORKER_SEALED_REQUEST_BYTES ||
    (input.receiptEpoch !== undefined &&
      (!Number.isSafeInteger(input.receiptEpoch) || input.receiptEpoch < 0))
  ) {
    taskDenied();
  }

  const { chat, workspace } = await authorizeChatOwner(db, input.chatId, input.userId);
  // Tools may be chosen before a Worker; dispatch needs the stored Worker and derived directory.
  const selection = chatWorkerSelection(chat);
  if (
    !selection ||
    selection.workerId !== input.workerId ||
    typeof selection.directory !== "string" ||
    !validChatWorkerDirectory(selection.directory) ||
    selection.directory !== input.directory ||
    !selection.tools.includes(input.tool) ||
    !(await activeWorkspaceWorkers(db, workspace.id, [input.workerId])).has(input.workerId)
  ) {
    taskDenied();
  }
  const directory = selection.directory;
  // The request is sealed to one key; a Worker re-paired since could not open it.
  const keys = await requireDispatchableWorker(db, workspace.id, input.workerId);
  if (!keys || keys.keyId !== input.sealed.keyId) taskDenied();

  const requestId = await workerChatTaskRequestId(input.chatId, input.toolCallId, input.stage);
  return await db.transaction(async (tx) => {
    const { existing, preview } = await boundChatCallStage(tx, input, directory);
    if (existing) return replayOf(existing);
    // The Worker applies only its own preview; this only refuses an apply nothing preceded.
    if (input.stage === "apply" && preview?.completionRevision == null) taskDenied();

    const [task] = await tx
      .insert(workerTasks)
      .values({
        worker: input.workerId,
        requestId,
        operation: input.tool === "bash" ? "bash" : "edit",
        chat: input.chatId,
        toolCallId: input.toolCallId,
        status: "sent",
        revision: 0,
        attempt: 0,
        updatedAt: new Date(),
        sealedKeyId: input.sealed.keyId,
        sealedEncapsulated: input.sealed.encapsulated,
        sealedRequest: input.sealed.request,
        editOwnerId: input.userId,
      })
      .onConflictDoNothing({ target: [workerTasks.worker, workerTasks.requestId] })
      .returning({ id: workerTasks.id });
    if (!task) {
      // A concurrent dispatch of this stage committed first; its receipt is visible now.
      const { existing: winner } = await boundChatCallStage(tx, input, directory);
      if (winner) return replayOf(winner);
      taskDenied();
    }
    const [call] = await tx
      .insert(workerChatCalls)
      .values({
        chat: input.chatId,
        userId: input.userId,
        worker: input.workerId,
        directory,
        tool: input.tool,
        toolCallId: input.toolCallId,
        stage: input.stage,
        requestKey: requestId,
        task: task.id,
        receiptEpoch: input.receiptEpoch ?? null,
      })
      .onConflictDoNothing({
        target: [workerChatCalls.chat, workerChatCalls.toolCallId, workerChatCalls.stage],
      })
      .returning({ id: workerChatCalls.id });
    // The stage has a receipt for another Worker: refuse (rolls the task back).
    if (!call) taskDenied();
    return { taskId: task.id, replay: false };
  });
}

function replayOf(call: typeof workerChatCalls.$inferSelect) {
  // A receipt whose task was pruned names no task: nothing can be re-delivered.
  if (!call.task) taskDenied();
  return { taskId: call.task, replay: true };
}

/**
 * A tool call id stays bound to its original assignment across all stages. Returns this stage's
 * receipt, if any, after checking every stage of the call against the assignment.
 */
async function boundChatCallStage(
  db: Database,
  input: SealedChatTaskDispatch,
  directory: string,
) {
  const stages = await db
    .select()
    .from(workerChatCalls)
    .where(
      and(eq(workerChatCalls.chat, input.chatId), eq(workerChatCalls.toolCallId, input.toolCallId)),
    )
    .limit(4);
  if (
    stages.length > 3 ||
    stages.some(
      (call) =>
        call.legacyContent !== null ||
        call.userId !== input.userId ||
        call.worker !== input.workerId ||
        call.directory !== directory ||
        call.tool !== input.tool,
    )
  ) {
    taskDenied();
  }
  return {
    existing: stages.find((call) => call.stage === input.stage),
    preview: stages.find((call) => call.stage === "preview"),
  };
}

/**
 * A sealed task's terminal state for the chat handler that dispatched it: `result` is the
 * Worker's result sealed under the request key, `null` when the Worker could not open the request.
 * `null` while the task runs or after it was pruned.
 */
export async function sealedChatTaskOutcome(
  db: Database,
  input: { chatId: string; userId: string; taskId: string },
): Promise<{ ok: boolean; result: Uint8Array | null } | null> {
  await authorizeChatOwner(db, input.chatId, input.userId);
  const [task] = await db.select().from(workerTasks).where(eq(workerTasks.id, input.taskId));
  if (!task) return null;
  if (!task.sealedRequest || task.chat !== input.chatId || task.editOwnerId !== input.userId) {
    taskDenied();
  }
  if (task.status !== "success" && task.status !== "failed") return null;
  return { ok: task.status === "success", result: task.sealedResult };
}

// ---------------------------------------------------------------------------------------------
// Worker side

/** The calling Worker's sealed tasks of one status (and operation), oldest first, a few at once. */
export async function assignedTasks(
  db: Database,
  scope: WorkerScope,
  input: { status: WorkerTaskStatus; operation?: "edit" | "bash" },
): Promise<WorkerTaskWire[]> {
  const rows = await db
    .select()
    .from(workerTasks)
    .where(
      and(
        eq(workerTasks.worker, scope.workerId),
        eq(workerTasks.status, input.status),
        input.operation ? eq(workerTasks.operation, input.operation) : undefined,
        isNotNull(workerTasks.sealedRequest),
      ),
    )
    .orderBy(asc(workerTasks.createdAt), asc(workerTasks.id))
    .limit(ASSIGNED_BATCH);
  return rows.map(taskWire);
}

/** One sealed task of the calling Worker; another Worker's or a non-sealed task is denied. */
async function assignedTask(db: Database, scope: WorkerScope, taskId: string) {
  const [task] = await db.select().from(workerTasks).where(eq(workerTasks.id, taskId));
  if (task && (task.worker !== scope.workerId || !task.sealedRequest)) taskDenied();
  return task;
}

/**
 * Claims a sent task for one Worker process with ONE conditional update, so of concurrent claims
 * exactly one wins. Retrying with the same claim id returns the task; any other claim gets
 * `null`. Unknown tasks are denied.
 */
export async function claimTask(
  db: Database,
  scope: WorkerScope,
  input: { taskId: string; claimId: string },
): Promise<WorkerTaskWire | null> {
  if (!CLAIM_ID.test(input.claimId)) taskDenied();
  const [claimed] = await db
    .update(workerTasks)
    .set({
      status: "processing",
      claimId: input.claimId,
      revision: sql`${workerTasks.revision} + 1`,
      attempt: sql`${workerTasks.attempt} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workerTasks.id, input.taskId),
        eq(workerTasks.worker, scope.workerId),
        eq(workerTasks.status, "sent"),
        isNotNull(workerTasks.sealedRequest),
      ),
    )
    .returning();
  if (claimed) return taskWire(claimed);
  const task = await assignedTask(db, scope, input.taskId);
  if (!task) taskDenied();
  return task.status === "processing" && task.claimId === input.claimId ? taskWire(task) : null;
}

export type SealedCompletion = {
  taskId: string;
  claimId: string;
  expectedRevision: number;
  ok: boolean;
  result?: Uint8Array;
  receipt?: Uint8Array;
};

/**
 * Completes a claimed sealed task once. `result` is the Worker's result sealed under the request
 * key (absent only when it could not open the request); `receipt` the durable receipt sealed to
 * the chat key epoch named at dispatch (required exactly when the call named one and a result
 * exists). The update is conditional on `(status = 'processing', claim_id, revision)`, so a stale
 * attempt never finishes a later one; an identical repeat is idempotent. A task already pruned
 * has nothing left to accept the payload: `receiptDiscarded`.
 */
export async function completeSealedTask(
  db: Database,
  scope: WorkerScope,
  input: SealedCompletion,
): Promise<{ completed: true } | { receiptDiscarded: true }> {
  if (
    !CLAIM_ID.test(input.claimId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    (input.result !== undefined &&
      (input.result.byteLength === 0 || input.result.byteLength > WORKER_SEALED_RESULT_BYTES)) ||
    (input.receipt !== undefined &&
      (input.receipt.byteLength === 0 || input.receipt.byteLength > WORKER_SEALED_RESULT_BYTES)) ||
    (input.receipt !== undefined && input.result === undefined) ||
    (input.ok && input.result === undefined)
  ) {
    taskDenied();
  }
  const status = input.ok ? ("success" as const) : ("failed" as const);
  const result = input.result ?? null;
  const isRepeat = (task: Task) =>
    task.revision === input.expectedRevision + 1 &&
    task.status === status &&
    task.claimId === input.claimId &&
    sameBytes(task.sealedResult, result);

  return await db.transaction(async (tx) => {
    const task = await assignedTask(tx, scope, input.taskId);
    if (!task) return { receiptDiscarded: true as const };
    if (task.claimId !== input.claimId) taskDenied();
    const [call] = await tx
      .select()
      .from(workerChatCalls)
      .where(eq(workerChatCalls.task, task.id));
    // A receipt goes only where dispatch named a chat key epoch, and always with a result.
    if (
      call &&
      (call.receiptEpoch === null
        ? input.receipt !== undefined
        : input.result !== undefined && input.receipt === undefined)
    ) {
      taskDenied();
    }
    if (isRepeat(task)) return { completed: true as const };

    const now = new Date();
    const [done] = await tx
      .update(workerTasks)
      .set({
        status,
        sealedResult: result,
        revision: input.expectedRevision + 1,
        updatedAt: now,
        terminalAt: now,
      })
      .where(
        and(
          eq(workerTasks.id, task.id),
          eq(workerTasks.status, "processing"),
          eq(workerTasks.claimId, input.claimId),
          eq(workerTasks.revision, input.expectedRevision),
        ),
      )
      .returning({ revision: workerTasks.revision });
    if (!done) {
      // A concurrent identical completion may have landed since the read above.
      const current = await assignedTask(tx, scope, task.id);
      if (current && isRepeat(current)) return { completed: true as const };
      throw new AppError("CONFLICT", "WORKER_TASK_STALE_REVISION");
    }
    if (call) {
      await tx
        .update(workerChatCalls)
        .set({
          sealedResult: input.receipt ?? null,
          completionClaimId: input.claimId,
          completionRevision: done.revision,
        })
        .where(eq(workerChatCalls.id, call.id));
    }
    return { completed: true as const };
  });
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null) {
  return left === null || right === null ? left === right : equalBytes(left, right);
}
