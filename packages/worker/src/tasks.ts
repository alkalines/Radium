import type { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { FunctionReturnType } from "convex/server";
import { api } from "backend/convex/_generated/api";
import {
  buildAad,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  fromBase64Url,
  openRequestRecipient,
  sealBox,
  sealSym,
  toolApprovalStatement,
  toolGrantStatement,
  unpad,
  utf8,
  type ChatScopeName,
} from "radium-crypto";
import {
  WORKER_EDIT_OUTPUT_BYTES,
  type WorkerEditRequest,
  type WorkerEditResult,
} from "backend/src/worker/edit-contract";
import { WORKER_BASH_OUTPUT_BYTES, type WorkerBashRequest } from "backend/src/worker/bash-contract";
import { chatWorkerSessionId } from "backend/src/worker/chat-config";
import { toArrayBuffer } from "backend/src/e2ee/contract";
import {
  parseWorkerToolInput,
  WORKER_APPROVAL_CLOCK_SKEW_MS,
  WORKER_APPROVAL_WINDOW_MS,
  WORKER_SEALED_RESULT_PLAINTEXT_BYTES,
  workerChatStageMatchesTool,
  workerChatTaskRequestId,
  workerReceiptAad,
  workerSealedTaskRequestSchema,
  workerTaskAad,
  type WorkerSealedTaskRequest,
  type WorkerToolOperation,
} from "backend/src/worker/task-contract";
import { chatAudienceIncludes, verifyChatKey } from "./e2ee/chat-key.js";
import type { WorkerTrust } from "./e2ee/trust.js";

type Task = FunctionReturnType<typeof api.worker_tasks.assigned>[number];

/** Executes Worker filesystem edit requests on the local machine. */
export interface EditExecutor {
  /** Execute one claimed edit and return its result text for receipt handling. */
  execute(request: WorkerEditRequest): Promise<string>;

  /** Release any local resources owned by the executor. */
  close(): Promise<void>;
}

/** Executes Worker Bash requests on the local machine. */
export interface BashExecutor {
  /** Execute one claimed Bash request and return its serialized result. */
  execute(request: WorkerBashRequest): Promise<string>;

  /** Abort active commands and release local shell resources. */
  close(): Promise<void>;
}

/** What the task consumer needs from a paired Worker's trust anchor (`WorkerTrust`). */
export type TaskTrust = Pick<
  WorkerTrust,
  | "workspaceId"
  | "workerId"
  | "encryptionSeed"
  | "verifyUser"
  | "highWater"
  | "advanceHighWater"
  | "pin"
  | "claimOnce"
>;

/** A completion waiting for delivery; the sealed bytes are produced once and retried as they are. */
type Receipt =
  | { kind: "plain"; task: Task; result: WorkerEditResult }
  | {
      kind: "sealed";
      task: Task;
      ok: boolean;
      result?: ArrayBuffer;
      receipt?: ArrayBuffer;
    };

/** A preview this process staged for one signed Edit/Create call; only it can be applied. */
type StagedPreview = { previewId: string; sessionId: string; directory: string; input: string };

/**
 * Consume assigned edit tasks and, when supplied, Bash tasks on this Worker.
 *
 * The consumer claims each task before local execution. If receipt delivery fails,
 * it retains and retries the result without executing the task again. Shutdown
 * closes the Bash executor first, waits for local work, attempts a bounded receipt
 * flush, and then closes the edit executor. A process crash can leave an operation's
 * outcome unknown; receipts are in memory and are not replayed after restart.
 *
 * A paired Worker (`trust` set) runs only sealed tasks and refuses plaintext ones; it executes a
 * sealed task only under the workspace owner's signature (see {@link runSealedTask}). An unpaired
 * Worker runs plaintext tasks only.
 */
export function consumeEditTasks(
  client: ConvexClient,
  executor: EditExecutor,
  bashExecutor?: BashExecutor,
  trust?: TaskTrust | null,
) {
  const claimId = crypto.randomUUID();
  let available = false;
  let stopped = false;
  let assignments: Task[] = [];
  let editAssignments: Task[] = [];
  let bashAssignments: Task[] = [];
  const healthyOperations = new Set<string>();
  let running: Promise<void> | undefined;
  let changed = false;
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
  });
  const receipts = new Map<string, Receipt>();
  const previews = new Map<string, StagedPreview>();
  const network = <T>(promise: Promise<T>) => Promise.race([promise, cancelled]);

  async function completeReceipt(receipt: Receipt) {
    try {
      if (receipt.kind === "sealed") {
        return await client.mutation(api.worker_tasks.completeSealedTask, {
          taskId: receipt.task._id,
          claimId,
          expectedRevision: receipt.task.revision,
          ok: receipt.ok,
          result: receipt.result,
          receipt: receipt.receipt,
        });
      }
      return await client.mutation(api.worker_tasks.completeEdit, {
        taskId: receipt.task._id,
        claimId,
        expectedRevision: receipt.task.revision,
        result: receipt.result,
      });
    } catch (error) {
      if (isPermanentCompletionRejection(error)) return { receiptDiscarded: true as const };
      throw error;
    }
  }

  async function runPlaintext(task: Task): Promise<Receipt> {
    // Local native snapshots cannot cross a workspace, caller, or chat boundary.
    const sessionId = createHash("sha256")
      .update(
        JSON.stringify([
          task.workspace,
          task.editOwnerId,
          task.chatId ?? null,
          (task.bashRequest ?? task.editRequest)!.sessionId,
        ]),
      )
      .digest("hex");
    let result: WorkerEditResult;
    try {
      const output =
        task.operation === "bash" && task.bashRequest && bashExecutor
          ? await bashExecutor.execute({ ...task.bashRequest, sessionId })
          : await executor.execute({ ...task.editRequest!, sessionId });
      result = executionResult(output, task.operation);
    } catch {
      result = {
        ok: false,
        code: task.operation === "bash" ? "BASH_EXECUTION_FAILED" : "EDIT_EXECUTION_FAILED",
      };
    }
    return { kind: "plain", task, result };
  }

  async function pump() {
    if (running || stopped || !available) return;
    changed = false;
    running = (async () => {
      for (const receipt of receipts.values()) {
        if (stopped || !available) return;
        try {
          const delivered = await network(completeReceipt(receipt));
          if (delivered) receipts.delete(receipt.task._id);
        } catch {
          // Retain the receipt for reconnection; never call execute again.
          return;
        }
      }
      // Do not accumulate execution results during an output transport outage.
      if (receipts.size) return;
      for (const assignment of assignments) {
        if (stopped || !available) return;
        if (!healthyOperations.has(assignment.operation)) continue;
        if (!assignment.editOwnerId) continue;
        if (assignment.operation !== "edit" && assignment.operation !== "bash") continue;
        if (assignment.operation === "bash" && !bashExecutor) continue;
        // A paired Worker never runs plaintext tasks; an unpaired one cannot open sealed ones.
        if (trust ? !assignment.sealed : !(assignment.editRequest ?? assignment.bashRequest)) {
          continue;
        }
        let task: Task | null | undefined;
        try {
          task = await network(
            client.mutation(api.worker_tasks.claimEdit, { taskId: assignment._id, claimId }),
          );
        } catch {
          return;
        }
        if (!task) continue;
        // The relay may return a different record from the subscription after the claim.
        // Never let a paired Worker fall through to the legacy plaintext executor.
        if (trust ? !task.sealed : !(task.editRequest ?? task.bashRequest)) continue;
        if (stopped || !available) {
          receipts.set(task._id, notExecuted(task));
          return;
        }
        const receipt =
          trust && task.sealed
            ? await runSealedTask(task, trust, { executor, bashExecutor, previews })
            : await runPlaintext(task);
        receipts.set(task._id, receipt);
        if (stopped || !available) return;
        try {
          const delivered = await network(completeReceipt(receipt));
          if (delivered) receipts.delete(task._id);
          else return;
        } catch {
          return;
        }
      }
    })().finally(() => {
      running = undefined;
      if (changed) {
        changed = false;
        void pump();
      }
    });
    await running;
  }

  function subscribe(operation: "edit" | "bash") {
    return client.onUpdate(
      api.worker_tasks.assigned,
      { status: "sent", operation },
      (tasks) => {
        healthyOperations.add(operation);
        if (operation === "edit") editAssignments = tasks;
        else bashAssignments = tasks;
        assignments = [...editAssignments, ...bashAssignments];
        changed = true;
        void pump();
      },
      () => {
        healthyOperations.delete(operation);
        // Query health is independent of control authority and the other stream.
        // Drop stale assignments for this operation until its subscription recovers.
        if (operation === "edit") editAssignments = [];
        else bashAssignments = [];
        assignments = [...editAssignments, ...bashAssignments];
        changed = true;
        void pump();
      },
    );
  }
  // Keep both reads indexed: metadata-only legacy assignments must not starve execution.
  const unsubscribe = subscribe("edit");
  const unsubscribeBash = bashExecutor ? subscribe("bash") : undefined;
  const retry = setInterval(() => {
    void pump();
  }, 5_000);

  return {
    setAvailable(value: boolean) {
      available = value;
      changed = true;
      if (value) void pump();
    },
    async close() {
      if (stopped) return;
      stopped = true;
      cancel();
      clearInterval(retry);
      unsubscribe();
      unsubscribeBash?.();
      await bashExecutor?.close();
      await running;
      // Finish an already-running local edit before closing the transport. This is
      // a bounded best-effort flush; a crash/partition still has an unknown outcome.
      for (const receipt of receipts.values()) {
        let timer: Timer | undefined;
        try {
          const timeout = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 2_000);
          });
          const delivered = await Promise.race([completeReceipt(receipt), timeout]);
          if (delivered) receipts.delete(receipt.task._id);
        } catch {
          // No replay on a later process; the processing task must be inspected.
        } finally {
          clearTimeout(timer);
        }
      }
      previews.clear();
      await executor.close();
    },
  };
}

/** A claimed task that was not run (transport lost or shutdown between claim and execution). */
function notExecuted(task: Task): Receipt {
  // A sealed task's result must be sealed under its request key; without opening it, report none.
  if (task.sealed) return { kind: "sealed", task, ok: false };
  return { kind: "plain", task, result: { ok: false, code: "NOT_EXECUTED" } };
}

/** Fixed refusal codes; none carries request content. */
type Refusal =
  | "REQUEST_INVALID"
  | "REQUEST_MISMATCH"
  | "AUTHORIZATION_MISSING"
  | "SIGNATURE_INVALID"
  | "SIGNER_NOT_OWNER"
  | "GRANT_SUPERSEDED"
  | "GRANT_MISSING_TOOL"
  | "APPROVAL_EXPIRED"
  | "INPUT_INVALID"
  | "PREVIEW_UNKNOWN"
  | "ALREADY_EXECUTED"
  | "RECEIPT_KEY_INVALID"
  | "TRUST_UNAVAILABLE";

const REFUSAL_MESSAGES: Record<Refusal, string> = {
  REQUEST_INVALID: "The Worker refused a malformed request.",
  REQUEST_MISMATCH: "The request does not match its task.",
  AUTHORIZATION_MISSING: "This call needs the workspace owner's approval signature.",
  SIGNATURE_INVALID: "The approval signature does not match this call.",
  SIGNER_NOT_OWNER: "Only the workspace owner can authorize Worker tools.",
  GRANT_SUPERSEDED:
    "This chat's Worker authorization was replaced. Open this chat unlocked to authorize the Worker.",
  GRANT_MISSING_TOOL: "Open this chat unlocked to authorize the Worker.",
  APPROVAL_EXPIRED: "This approval is too old (or from a clock far ahead); approve the call again.",
  INPUT_INVALID: "The approved input is not a valid tool call.",
  PREVIEW_UNKNOWN: "This Worker did not stage a preview for this approved call.",
  ALREADY_EXECUTED: "This approved call already ran on the Worker.",
  RECEIPT_KEY_INVALID: "The chat key for this call is not bound to this chat.",
  TRUST_UNAVAILABLE: "The Worker cannot verify the workspace roster.",
};

class TaskRefusal extends Error {
  constructor(readonly code: Refusal) {
    super(REFUSAL_MESSAGES[code]);
  }
}

/** Persistent mark of the newest standing grant (`issuedAt`) this Worker accepted for a chat. */
function grantMark(chatId: string): string {
  return `tool-grant:${chatId}`;
}

/**
 * Check that the owner authorized exactly this request and derive the operation from signed data.
 * Edit/Create/Bash need a per-call approval over the input; Read needs the chat's standing grant
 * that is not older than the newest grant this Worker has seen for the chat. Directory, chat,
 * Worker, tool and call ID come from the signed statement, never from unsigned task fields.
 */
async function authorize(
  request: WorkerSealedTaskRequest,
  trust: TaskTrust,
): Promise<{
  operation: WorkerToolOperation;
  input: string;
  signerUserId: string;
  approvedAt?: number;
}> {
  const { authorization } = request;
  let message: Uint8Array;
  let input: string;
  if (request.tool === "read") {
    if (authorization.kind !== "grant" || request.input === undefined) {
      throw new TaskRefusal("GRANT_MISSING_TOOL");
    }
    if (!authorization.tools.includes("read")) throw new TaskRefusal("GRANT_MISSING_TOOL");
    if (authorization.issuedAt < trust.highWater(grantMark(request.chatId))) {
      throw new TaskRefusal("GRANT_SUPERSEDED");
    }
    message = toolGrantStatement({
      workspaceId: request.workspaceId,
      chatId: request.chatId,
      workerId: request.workerId,
      directory: request.directory,
      tools: authorization.tools,
      issuedAt: authorization.issuedAt,
    });
    input = request.input;
  } else {
    if (authorization.kind !== "approval") throw new TaskRefusal("AUTHORIZATION_MISSING");
    message = toolApprovalStatement({
      workspaceId: request.workspaceId,
      chatId: request.chatId,
      workerId: request.workerId,
      directory: request.directory,
      tool: request.tool,
      toolCallId: request.toolCallId,
      input: utf8(authorization.input),
      approvedAt: authorization.approvedAt,
    });
    input = authorization.input;
  }

  let signature: Uint8Array;
  try {
    signature = fromBase64Url(authorization.signature);
  } catch {
    throw new TaskRefusal("SIGNATURE_INVALID");
  }
  const signer = await trust
    .verifyUser({ signerKeyId: authorization.signerKeyId, message, signature })
    .catch(() => {
      throw new TaskRefusal("TRUST_UNAVAILABLE");
    });
  if (!signer) throw new TaskRefusal("SIGNATURE_INVALID");
  // Only owners get Worker tools; a member's valid signature authorizes nothing here.
  if (signer.role !== "owner") throw new TaskRefusal("SIGNER_NOT_OWNER");

  const operation = parseWorkerToolInput(request.tool, input);
  if (!operation) throw new TaskRefusal("INPUT_INVALID");

  if (authorization.kind === "grant") {
    // Equal timestamps must not let different owner-signed grants equivocate.
    const grantDigest = createHash("sha256").update(message).digest("hex");
    if (!(await trust.pin(`${grantMark(request.chatId)}:${authorization.issuedAt}`, grantDigest))) {
      throw new TaskRefusal("GRANT_SUPERSEDED");
    }
    await trust.advanceHighWater(grantMark(request.chatId), authorization.issuedAt);
    if (authorization.issuedAt < trust.highWater(grantMark(request.chatId))) {
      throw new TaskRefusal("GRANT_SUPERSEDED");
    }
    return { operation, input, signerUserId: signer.userId };
  }
  // The window bounds how long executed approvals must be remembered to refuse replays.
  const now = Date.now();
  if (
    authorization.approvedAt > now + WORKER_APPROVAL_CLOCK_SKEW_MS ||
    now - authorization.approvedAt > WORKER_APPROVAL_WINDOW_MS
  ) {
    throw new TaskRefusal("APPROVAL_EXPIRED");
  }
  return { operation, input, signerUserId: signer.userId, approvedAt: authorization.approvedAt };
}

/**
 * Open, authorize and run one sealed built-in tool task, then seal the outcome: the result under the
 * request's response key (`workerTaskAad` field `result`) for the dispatching action, and, when the
 * request names a chat key epoch, a durable receipt to that chat key. A request that cannot be
 * opened gets no result. Every refusal is a fixed code; nothing about the request is logged.
 */
async function runSealedTask(
  task: Task,
  trust: TaskTrust,
  local: {
    executor: EditExecutor;
    bashExecutor?: BashExecutor;
    previews: Map<string, StagedPreview>;
  },
): Promise<Receipt> {
  const sealed = task.sealed!;
  const failed: Receipt = { kind: "sealed", task, ok: false };
  if (
    !task.chatId ||
    !task.toolCallId ||
    task.workspace !== trust.workspaceId ||
    task.workerId !== trust.workerId
  ) {
    return failed;
  }

  // The AAD binds the request to this workspace, chat and request ID, so a relocated request fails.
  const aad = { workspaceId: task.workspace, chatId: task.chatId, requestId: task.requestId };
  const seed = trust.encryptionSeed();
  let responseKey: Uint8Array | undefined;
  let plaintext: Uint8Array;
  try {
    const recipient = await openRequestRecipient(seed, new Uint8Array(sealed.encapsulated));
    responseKey = recipient.responseKey;
    plaintext = unpad(
      await recipient.open(
        new Uint8Array(sealed.request),
        buildAad(workerTaskAad({ ...aad, field: "request" })),
      ),
    );
  } catch {
    responseKey?.fill(0);
    return failed;
  } finally {
    seed.fill(0);
  }

  try {
    // A request that does not parse or does not describe this task gets no result at all.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      return failed;
    }
    const parsed = workerSealedTaskRequestSchema.safeParse(parsedJson);
    if (!parsed.success) return failed;
    const request = parsed.data;
    // The recipient of the durable receipt is authenticated before anything runs.
    const receiptKey = request.receipt
      ? await verifyReceipt(request.receipt, request.chatId, trust)
      : undefined;
    if (
      request.workspaceId !== trust.workspaceId ||
      request.workerId !== trust.workerId ||
      request.chatId !== task.chatId ||
      request.toolCallId !== task.toolCallId ||
      !workerChatStageMatchesTool(request.tool, request.stage) ||
      task.operation !== (request.tool === "bash" ? "bash" : "edit") ||
      task.requestId !==
        (await workerChatTaskRequestId(request.chatId, request.toolCallId, request.stage)) ||
      !isAbsolute(request.directory) ||
      request.directory.includes("\0") ||
      receiptKey === null
    ) {
      return failed;
    }

    let result: WorkerEditResult;
    try {
      result = await execute(request, trust, local, receiptKey ?? undefined);
    } catch (error) {
      if (!(error instanceof TaskRefusal)) throw error;
      // An unauthorized recipient gets no receipt, and the dispatching action no result.
      if (error.code === "RECEIPT_KEY_INVALID") return failed;
      result = {
        ok: false,
        code: error.code,
        output: JSON.stringify({ ok: false, code: error.code, message: error.message }),
      };
    }

    let resultJson = utf8(JSON.stringify(result));
    if (resultJson.length > WORKER_SEALED_RESULT_PLAINTEXT_BYTES) {
      result = { ok: false, code: "OUTPUT_TOO_LARGE" };
      resultJson = utf8(JSON.stringify(result));
    }
    const keyRef = createHash("sha256")
      .update(new Uint8Array(sealed.encapsulated))
      .digest()
      .subarray(0, 16);
    const sealedResult = await sealSym({
      key: responseKey,
      keyRef: new Uint8Array(keyRef),
      plaintext: resultJson,
      aad: workerTaskAad({ ...aad, field: "result" }),
    });

    let receipt: Uint8Array | undefined;
    if (request.receipt && receiptKey) {
      receipt = await sealBox({
        recipientPublicKey: receiptKey.publicKey,
        plaintext: resultJson,
        aad: workerReceiptAad({
          workspaceId: request.workspaceId,
          chatE2eeId: request.receipt.e2eeId,
          toolCallId: request.toolCallId,
          stage: request.stage,
        }),
        pad: "content",
      });
    }
    return {
      kind: "sealed",
      task,
      ok: result.ok,
      result: toArrayBuffer(sealedResult),
      receipt: receipt && toArrayBuffer(receipt),
    };
  } catch {
    return failed;
  } finally {
    responseKey!.fill(0);
  }
}

/** Run an authorized request once; persistent marks refuse a replay of the same call stage. */
async function execute(
  request: WorkerSealedTaskRequest,
  trust: TaskTrust,
  local: {
    executor: EditExecutor;
    bashExecutor?: BashExecutor;
    previews: Map<string, StagedPreview>;
  },
  receipt?: VerifiedReceipt,
): Promise<WorkerEditResult> {
  const { operation, input, signerUserId, approvedAt } = await authorize(request, trust);
  if (receipt) {
    // The approving owner must belong to the chat's audience and nothing older than an epoch
    // already seen may receive new content; the creator is pinned for the chat's lifetime.
    const mark = `chat-receipt-epoch:${request.chatId}`;
    if (
      !chatAudienceIncludes(receipt, signerUserId) ||
      !(await trust.pin(`chat-creator:${request.chatId}`, receipt.creatorId)) ||
      receipt.epoch < trust.highWater(mark)
    )
      throw new TaskRefusal("RECEIPT_KEY_INVALID");
    await trust.advanceHighWater(mark, receipt.epoch);
    if (receipt.epoch < trust.highWater(mark)) throw new TaskRefusal("RECEIPT_KEY_INVALID");
  }
  if (approvedAt !== undefined) {
    // Claimed before execution: an interrupted run has an unknown outcome and never reruns. The
    // claim outlives the approval window, after which the approval itself is refused.
    const digest = createHash("sha256")
      .update(
        JSON.stringify([request.workspaceId, request.chatId, request.toolCallId, request.stage]),
      )
      .digest("hex");
    const expiresAt = approvedAt + WORKER_APPROVAL_WINDOW_MS + WORKER_APPROVAL_CLOCK_SKEW_MS;
    if (!(await trust.claimOnce(`tool-call:${digest}`, expiresAt))) {
      throw new TaskRefusal("ALREADY_EXECUTED");
    }
  }

  // Local native snapshots cannot cross a workspace, signer, or chat boundary.
  const sessionId = createHash("sha256")
    .update(
      JSON.stringify([
        request.workspaceId,
        signerUserId,
        request.chatId,
        await chatWorkerSessionId(request.chatId, request.directory),
      ]),
    )
    .digest("hex");
  const directory = request.directory;
  const previewKey = `${request.chatId}:${request.toolCallId}`;

  try {
    switch (operation.tool) {
      case "read": {
        const { path, startLine, maxLines } = operation;
        const output = await local.executor.execute({
          sessionId,
          directory,
          action: { kind: "read", path, startLine, maxLines },
        });
        return executionResult(output, "edit");
      }
      case "edit":
      case "create": {
        if (request.stage === "preview") {
          const output = await local.executor.execute({
            sessionId,
            directory,
            writeMode: operation.tool,
            action: { kind: "preview", patch: operation.patch },
          });
          const result = executionResult(output, "edit");
          const previewId = result.ok ? stagedPreviewId(result.output) : null;
          if (previewId) {
            // Native sessions expire previews anyway; keep this index as small as their limit.
            if (local.previews.size >= 64) {
              local.previews.delete(local.previews.keys().next().value!);
            }
            local.previews.set(previewKey, { previewId, sessionId, directory, input });
          }
          return result;
        }
        // Apply only the preview this process staged for the same signed call and input.
        const staged = local.previews.get(previewKey);
        local.previews.delete(previewKey);
        if (
          !staged ||
          staged.input !== input ||
          staged.sessionId !== sessionId ||
          staged.directory !== directory
        ) {
          throw new TaskRefusal("PREVIEW_UNKNOWN");
        }
        const output = await local.executor.execute({
          sessionId,
          directory,
          writeMode: operation.tool,
          action: { kind: "apply", previewId: staged.previewId },
        });
        return executionResult(output, "edit");
      }
      case "bash": {
        if (!local.bashExecutor) return { ok: false, code: "BASH_UNAVAILABLE" };
        const output = await local.bashExecutor.execute({
          directory,
          sessionId,
          command: operation.command,
          timeoutSeconds: operation.timeoutSeconds,
        });
        return executionResult(output, "bash");
      }
    }
  } catch (error) {
    if (error instanceof TaskRefusal) throw error;
    return {
      ok: false,
      code: request.tool === "bash" ? "BASH_EXECUTION_FAILED" : "EDIT_EXECUTION_FAILED",
    };
  }
}

function stagedPreviewId(output: string): string | null {
  try {
    const value: unknown = JSON.parse(output);
    if (
      typeof value === "object" &&
      value !== null &&
      "ok" in value &&
      value.ok === true &&
      "previewId" in value &&
      typeof value.previewId === "string" &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(value.previewId)
    ) {
      return value.previewId;
    }
  } catch {
    /* Not a preview result. */
  }
  return null;
}

/** The receipt's chat public key, or `null` when it is not a well-formed encryption public key. */
function decodeReceiptKey(text: string): Uint8Array | null {
  try {
    const key = fromBase64Url(text);
    return key.length === ENCRYPTION_PUBLIC_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** A receipt recipient whose epoch signature, binding signature and signer authority verified. */
type VerifiedReceipt = {
  publicKey: Uint8Array;
  scope: ChatScopeName;
  creatorId: string;
  members: string[];
  epoch: number;
};

/**
 * Authenticate the chat key a request names for its durable receipt. The request is only as
 * trustworthy as the server that assembled it, so the key must carry the roster-verified epoch
 * signature and a binding signature over this exact chat; any substituted key (another chat's,
 * another scope's, an unbound epoch) yields `null` and the task is not run.
 */
async function verifyReceipt(
  receipt: NonNullable<WorkerSealedTaskRequest["receipt"]>,
  chatId: string,
  trust: TaskTrust,
): Promise<VerifiedReceipt | null> {
  const publicKey = decodeReceiptKey(receipt.publicKey);
  if (!publicKey) return null;
  try {
    const signer = await verifyChatKey(trust, {
      chatId,
      e2eeId: receipt.e2eeId,
      epoch: receipt.epoch,
      keyId: receipt.keyId,
      suite: receipt.suite,
      publicKey,
      signerKeyId: receipt.signerKeyId,
      signature: fromBase64Url(receipt.signature),
      bindingSignature: fromBase64Url(receipt.bindingSignature),
      scope: receipt.scope,
      creatorId: receipt.creatorId,
      members: receipt.members,
    });
    if (!signer) return null;
  } catch {
    return null;
  }
  return {
    publicKey,
    scope: receipt.scope,
    creatorId: receipt.creatorId,
    members: receipt.members,
    epoch: receipt.epoch,
  };
}

/** Identify completion rejections that cannot be fixed by retrying the receipt. */
function isPermanentCompletionRejection(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    (data.code === "WORKER_TASK_DENIED" || data.code === "WORKER_TASK_STALE_REVISION")
  );
}

function executionResult(output: string, operation: string): WorkerEditResult {
  const bash = operation === "bash";
  if (
    new TextEncoder().encode(output).length >
    (bash ? WORKER_BASH_OUTPUT_BYTES : WORKER_EDIT_OUTPUT_BYTES)
  )
    return { ok: false, code: bash ? "BASH_OUTPUT_TOO_LARGE" : "EDIT_OUTPUT_TOO_LARGE" };
  try {
    const response: unknown = JSON.parse(output);
    if (response && typeof response === "object" && "ok" in response && response.ok === false) {
      const fallbackCode = bash ? "BASH_EXECUTION_FAILED" : "EDIT_EXECUTION_FAILED";
      const code =
        "code" in response &&
        typeof response.code === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(response.code)
          ? response.code
          : fallbackCode;
      return { ok: false, code, output };
    }
  } catch {
    /* Non-JSON executor output is still a bounded tool result. */
  }
  return { ok: true, output };
}
