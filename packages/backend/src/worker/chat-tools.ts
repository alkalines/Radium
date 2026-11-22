import { tool, type ToolSet, type ToolApprovalConfiguration } from "ai";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { buildAad, hkdf, openRequestSender, openSym, pad, toBase64Url, utf8 } from "radium-crypto";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ActionCtx } from "../../convex/_generated/server";
import type { WorkerApprovalSignature } from "contracts/worker/chat-tools";
import { toArrayBuffer } from "contracts/e2ee/contract";
import {
  chatWorkerSessionId,
  validChatWorkerDirectory,
  type ChatWorkerTarget,
} from "contracts/worker/chat-config";
import {
  workerCreatePatch,
  type WorkerEditRequest,
  type WorkerEditResult,
} from "contracts/worker/edit-contract";
import {
  parseWorkerToolInput,
  sameWorkerToolOperation,
  WORKER_SEALED_REQUEST_PLAINTEXT_BYTES,
  workerChatTaskRequestId,
  workerTaskAad,
  workerToolInputSchemas,
  type WorkerChatStage,
  type WorkerChatTool,
  type WorkerSealedTaskRequest,
  type WorkerToolAuthorization,
} from "contracts/worker/task-contract";

const WAIT_MS = 45_000;
const POLL_MS = 500;

/** HKDF label of the AI SDK approval replay-guard key; separates it from the issuer key's own use. */
const APPROVAL_REPLAY_GUARD_LABEL = "radium/v1/chat-tool-approval-replay-guard";

/** Returned by every Worker tool when the chat has no usable Worker directory; nothing is dispatched. */
const DIRECTORY_UNAVAILABLE = {
  ok: false,
  code: "WORKER_DIRECTORY_UNAVAILABLE",
  message: "Worker has not reported a working directory; update/restart the Worker.",
};

/** A Read without the owner's signed standing grant; nothing is dispatched. */
const GRANT_MISSING = {
  ok: false,
  code: "WORKER_GRANT_MISSING",
  message: "Open this chat unlocked to authorize the Worker.",
};

/** An approved Edit/Create/Bash call without the user's approval signature; nothing is dispatched. */
const APPROVAL_UNSIGNED = {
  ok: false,
  code: "WORKER_APPROVAL_UNSIGNED",
  message:
    "This call was approved without a signature from an unlocked device. Unlock this device and ask the agent to try again.",
};

/** A call/stage this chat dispatched before; its result was sealed to an earlier request key. */
const ALREADY_EXECUTED = {
  ok: false,
  code: "WORKER_ALREADY_EXECUTED",
  message:
    "This tool call was already sent to the Worker. Do not retry it; inspect its effect instead.",
};

/**
 * How this chat request reaches its Worker. `plaintext`: keyless workspace and a chat without keys
 * (legacy path). `sealed`: paired Worker; requests are sealed to its certified key, and encrypted
 * chats name the chat key epoch receipts are sealed to. `blocked`: nothing may be dispatched.
 */
export type WorkerChatTransport =
  | { kind: "plaintext" }
  | {
      kind: "sealed";
      keyId: string;
      encryptionPublicKey: Uint8Array;
      receipt?: {
        e2eeId: string;
        epoch: number;
        publicKey: Uint8Array;
        keyId: string;
        suite: number;
        signerKeyId: string;
        signature: Uint8Array;
        bindingSignature: Uint8Array;
        scope: "personal" | "shared" | "workspace";
        creatorId: string;
        members: string[];
      };
    }
  | { kind: "blocked"; code: string; message: string };

type WorkerChatScope = {
  chatId: Id<"aisdk_chats">;
  workspaceId: Id<"workspaces">;
  userId: string;
  selection: ChatWorkerTarget;
  transport: WorkerChatTransport;
  /**
   * Approval signatures by tool call ID: the request body's `approvals` for SDK approvals, plus
   * Code Mode approvals as the browser answers them during this request (shared, mutable).
   */
  approvals: Map<string, WorkerApprovalSignature>;
};

/**
 * Pick the transport for an owner's chat request: a paired Worker gets sealed requests; a keyless
 * workspace's Worker keeps the plaintext path only for chats without keys. A Worker the workspace
 * has not paired, or an encrypted chat whose key cannot be used, blocks dispatch with a clear code.
 */
export async function resolveWorkerChatTransport(
  ctx: ActionCtx,
  scope: { chatId: Id<"aisdk_chats">; userId: string; workerId: string; encrypted: boolean },
): Promise<WorkerChatTransport> {
  let target: { keyId: string; encryptionPublicKey: ArrayBuffer } | null;
  try {
    target = await ctx.runQuery(internal.worker_tasks.chatWorkerTarget, {
      chatId: scope.chatId,
      userId: scope.userId,
      workerId: scope.workerId,
    });
  } catch (error) {
    if (
      error instanceof ConvexError &&
      typeof error.data === "object" &&
      error.data !== null &&
      "code" in error.data &&
      error.data.code === "WORKER_NOT_PAIRED"
    ) {
      return {
        kind: "blocked",
        code: "WORKER_NOT_PAIRED",
        message: "Pair this Worker before using it in this workspace.",
      };
    }
    throw error;
  }

  if (!target) {
    if (!scope.encrypted) return { kind: "plaintext" };
    return {
      kind: "blocked",
      code: "WORKER_NOT_PAIRED",
      message: "Encrypted chats need a paired Worker. Set up workspace keys and pair this Worker.",
    };
  }

  const transport: WorkerChatTransport = {
    kind: "sealed",
    keyId: target.keyId,
    encryptionPublicKey: new Uint8Array(target.encryptionPublicKey),
  };
  if (!scope.encrypted) return transport;

  const chatKey = await ctx.runQuery(internal.worker_tasks.chatReceiptKey, {
    chatId: scope.chatId,
    userId: scope.userId,
  });
  if (!chatKey) {
    return {
      kind: "blocked",
      code: "CHAT_KEY_UNAVAILABLE",
      message: "This chat's key must be rotated before the Worker can be used.",
    };
  }
  return {
    ...transport,
    receipt: {
      e2eeId: chatKey.e2eeId,
      epoch: chatKey.epoch,
      publicKey: new Uint8Array(chatKey.publicKey),
      keyId: chatKey.keyId,
      suite: chatKey.suite,
      signerKeyId: chatKey.signerKeyId,
      signature: new Uint8Array(chatKey.signature),
      bindingSignature: new Uint8Array(chatKey.bindingSignature),
      scope: chatKey.scope,
      creatorId: chatKey.creatorId,
      members: chatKey.members,
    },
  };
}

/**
 * AI SDK approval replay guard (`experimental_toolApprovalSecret`), bound to this owner, chat,
 * Worker, directory and tool selection. It only lets the SDK reject forged approval responses; the
 * Worker authorizes execution from the user's signature. The key is derived with a dedicated HKDF
 * label from the Worker issuer key, never the issuer key itself.
 */
export async function workerChatApprovalSecret(
  issuerSecret: string,
  scope: Pick<WorkerChatScope, "chatId" | "workspaceId" | "userId" | "selection">,
) {
  const guardKey = await hkdf(utf8(issuerSecret), APPROVAL_REPLAY_GUARD_LABEL);
  const raw = toArrayBuffer(guardKey);
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  guardKey.fill(0);
  new Uint8Array(raw).fill(0);
  const context = JSON.stringify([
    "radium-worker-chat-approval-v1",
    scope.userId,
    scope.workspaceId,
    scope.chatId,
    scope.selection.workerId,
    scope.selection.directory,
    [...scope.selection.tools].sort(),
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(context)));
}

const sealedResultSchema = z.union([
  z.object({ ok: z.literal(true), output: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    output: z.string().optional(),
  }),
]);

/** Model-facing form of a Worker result: its JSON output object, with failure codes preserved. */
function toolOutput(result: WorkerEditResult): Record<string, unknown> {
  if (result.output) {
    try {
      const output: unknown = JSON.parse(result.output);
      if (output && typeof output === "object" && !Array.isArray(output)) {
        return result.ok
          ? (output as Record<string, unknown>)
          : { ...output, ok: false, code: result.code };
      }
    } catch {
      /* A malformed receipt must never advance to apply. */
    }
  }
  return result.ok
    ? { ok: false, code: "INVALID_WORKER_OUTPUT" }
    : { ok: false, code: result.code };
}

function outcomeUnknown(taskId: Id<"worker_tasks">) {
  return {
    ok: false,
    code: "WORKER_OUTCOME_UNKNOWN",
    taskId,
    message:
      "The Worker did not return a result. It may be disconnected or the task may still run. Do not retry this operation; inspect its outcome first.",
  };
}

/** Sleep one poll interval, waking early on abort. */
function pollDelay(signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, POLL_MS);
  signal?.addEventListener("abort", done, { once: true });
  return promise;
}

/**
 * AI SDK tools execute only through authorized Convex task coordination, never local filesystem
 * APIs. Without a valid stored directory (the Worker never reported a temp directory and the
 * Project has no folder for it) or with a `blocked` transport, the enabled tools are still exposed
 * but return a fixed failure without approval prompts or dispatch.
 *
 * Sealed transport: each stage is sealed to the Worker with the user's authorization (approval
 * signature over the exact input JSON for Edit/Create/Bash, the chat's standing grant for Read);
 * the result is opened in memory with the request key. A stage dispatched before returns a fixed
 * "already executed" outcome. Plaintext transport keeps the keyless-workspace path.
 */
export function buildWorkerChatTools(
  ctx: ActionCtx,
  scope: WorkerChatScope,
): {
  tools: ToolSet;
  toolApproval: ToolApprovalConfiguration<ToolSet, unknown>;
} {
  const { selection, chatId, userId, workspaceId, transport, approvals } = scope;
  const directory =
    selection.directory && validChatWorkerDirectory(selection.directory)
      ? selection.directory
      : undefined;
  const usable = directory !== undefined && transport.kind !== "blocked";
  const tools: ToolSet = {};
  const toolApproval: ToolApprovalConfiguration<ToolSet, unknown> = {};
  let writesQueue: Promise<unknown> = Promise.resolve();

  function unavailable() {
    if (transport.kind === "blocked") {
      return { ok: false, code: transport.code, message: transport.message };
    }
    return DIRECTORY_UNAVAILABLE;
  }

  /** Authorization for one call: the grant for Read, else the user's approval signature. */
  function authorization(
    kind: WorkerChatTool,
    toolCallId: string,
    input: string,
  ): WorkerToolAuthorization | null {
    if (kind === "read") {
      const grant = selection.grant;
      if (!grant?.tools.includes("read")) return null;
      return {
        kind: "grant",
        tools: grant.tools,
        issuedAt: grant.issuedAt,
        signature: toBase64Url(new Uint8Array(grant.signature)),
        signerKeyId: grant.signerKeyId,
      };
    }
    const approval = approvals.get(toolCallId);
    if (!approval) return null;
    // The user signed the input they saw; it must describe the same operation as this call
    // (key order or schema defaults may differ). The Worker derives the operation from it again.
    const signed = parseWorkerToolInput(kind, approval.input);
    const called = parseWorkerToolInput(kind, input);
    if (!signed || !called || !sameWorkerToolOperation(signed, called)) return null;
    return { kind: "approval", ...approval };
  }

  /** Seal one stage to the paired Worker, dispatch it and open its request-key result. */
  async function executeSealed(
    kind: WorkerChatTool,
    toolCallId: string,
    stage: WorkerChatStage,
    input: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (transport.kind !== "sealed" || !directory) return unavailable();
    const auth = authorization(kind, toolCallId, input);
    if (!auth) return kind === "read" ? GRANT_MISSING : APPROVAL_UNSIGNED;

    const request: WorkerSealedTaskRequest = {
      v: 1,
      workspaceId,
      chatId,
      workerId: selection.workerId,
      directory,
      tool: kind,
      toolCallId,
      stage,
      authorization: auth,
      ...(auth.kind === "grant" ? { input } : {}),
      ...(transport.receipt
        ? {
            receipt: {
              e2eeId: transport.receipt.e2eeId,
              epoch: transport.receipt.epoch,
              publicKey: toBase64Url(transport.receipt.publicKey),
              keyId: transport.receipt.keyId,
              suite: transport.receipt.suite,
              signerKeyId: transport.receipt.signerKeyId,
              signature: toBase64Url(transport.receipt.signature),
              bindingSignature: toBase64Url(transport.receipt.bindingSignature),
              scope: transport.receipt.scope,
              creatorId: transport.receipt.creatorId,
              members: transport.receipt.members,
            },
          }
        : {}),
    };
    const plaintext = utf8(JSON.stringify(request));
    if (plaintext.length > WORKER_SEALED_REQUEST_PLAINTEXT_BYTES) {
      return { ok: false, code: "WORKER_INPUT_TOO_LARGE" };
    }

    const requestId = await workerChatTaskRequestId(chatId, toolCallId, stage);
    const sender = await openRequestSender(transport.encryptionPublicKey);
    try {
      const sealedRequest = await sender.seal(
        pad(plaintext, "content"),
        buildAad(workerTaskAad({ workspaceId, chatId, requestId, field: "request" })),
      );
      const { taskId, replay } = await ctx.runMutation(
        internal.worker_tasks.dispatchSealedChatTask,
        {
          chatId,
          userId,
          workerId: selection.workerId,
          directory,
          tool: kind,
          toolCallId,
          stage,
          sealed: {
            keyId: transport.keyId,
            encapsulated: toArrayBuffer(sender.encapsulated),
            request: toArrayBuffer(sealedRequest),
          },
          ...(transport.receipt ? { receiptEpoch: transport.receipt.epoch } : {}),
        },
      );
      if (replay) return ALREADY_EXECUTED;
      return await waitForSealedOutcome(taskId, requestId, sender.responseKey, signal);
    } finally {
      sender.responseKey.fill(0);
    }
  }

  /**
   * Poll the task until the Worker answers, then open its result with the request key. Abort or
   * timeout only stops waiting; the task may still run, so it is never treated as a retry signal.
   */
  async function waitForSealedOutcome(
    taskId: Id<"worker_tasks">,
    requestId: string,
    responseKey: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + WAIT_MS;
    while (!signal?.aborted && Date.now() < deadline) {
      const outcome = await ctx.runQuery(internal.worker_tasks.sealedChatTaskOutcome, {
        chatId,
        userId,
        taskId,
      });
      if (outcome) {
        if (!outcome.result) {
          return {
            ok: false,
            code: "WORKER_REQUEST_REFUSED",
            message: "The Worker did not run this request.",
          };
        }
        try {
          const opened = await openSym({
            key: responseKey,
            envelope: new Uint8Array(outcome.result),
            aad: workerTaskAad({ workspaceId, chatId, requestId, field: "result" }),
          });
          const result = sealedResultSchema.parse(JSON.parse(new TextDecoder().decode(opened)));
          return toolOutput(result);
        } catch {
          return { ok: false, code: "INVALID_WORKER_OUTPUT" };
        }
      }
      if (signal?.aborted) break;
      await pollDelay(signal);
    }
    return outcomeUnknown(taskId);
  }

  async function executePlaintext(
    kind: "read" | "edit" | "create",
    toolCallId: string,
    stage: "read" | "preview" | "apply",
    action: WorkerEditRequest["action"],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!directory) return DIRECTORY_UNAVAILABLE;
    const { taskId } = await ctx.runMutation(internal.worker_tasks.dispatchChatEdit, {
      chatId,
      userId,
      workerId: selection.workerId,
      directory,
      tool: kind,
      toolCallId,
      stage,
      request: {
        directory,
        sessionId: await chatWorkerSessionId(chatId, directory),
        action,
      },
    });
    return waitForPlaintextOutcome(taskId, signal);
  }

  /**
   * Poll the durable receipt. Abort or timeout only stops waiting; the Worker task may
   * still be running, so an unknown result is never treated as permission to retry.
   */
  async function waitForPlaintextOutcome(
    taskId: Id<"worker_tasks">,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + WAIT_MS;
    while (!signal?.aborted && Date.now() < deadline) {
      const result: WorkerEditResult | null = await ctx.runQuery(
        internal.worker_tasks.chatEditOutcome,
        { chatId, userId, taskId },
      );
      if (result) return toolOutput(result);
      if (signal?.aborted) break;
      await pollDelay(signal);
    }
    return outcomeUnknown(taskId);
  }

  async function write(
    kind: "edit" | "create",
    input: string,
    patch: string,
    callId: string,
    signal?: AbortSignal,
  ) {
    // The native session permits one pending preview. Serialize approved writes
    // within this model turn, including concurrent SDK tool execution.
    const result = writesQueue.then(async () => {
      if (signal?.aborted) return { ok: false, code: "REQUEST_ABORTED" };
      if (transport.kind === "sealed") {
        const preview = await executeSealed(kind, callId, "preview", input, signal);
        if (preview.ok !== true || typeof preview.previewId !== "string") return preview;
        // The Worker applies only the preview it staged for this signed call.
        return executeSealed(kind, callId, "apply", input, signal);
      }
      const preview = await executePlaintext(
        kind,
        callId,
        "preview",
        { kind: "preview", patch },
        signal,
      );
      if (preview.ok !== true || typeof preview.previewId !== "string") return preview;
      return executePlaintext(
        kind,
        callId,
        "apply",
        { kind: "apply", previewId: preview.previewId },
        signal,
      );
    });
    // A failed write must not leave the queue rejected and block later approved writes.
    writesQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  if (selection.tools.includes("read")) {
    tools.worker_read = tool({
      description:
        "Read a text file relative to the selected Worker directory. Returns hashline snapshots and the exact edit grammar. Read before editing; use nextLine to continue truncated reads.",
      inputSchema: workerToolInputSchemas.read,
      execute: async (input, { toolCallId, abortSignal }) => {
        if (abortSignal?.aborted) return { ok: false, code: "REQUEST_ABORTED" };
        if (!usable) return unavailable();
        if (transport.kind === "sealed") {
          return executeSealed("read", toolCallId, "read", JSON.stringify(input), abortSignal);
        }
        const { path, startLine, maxLines } = input;
        return executePlaintext(
          "read",
          toolCallId,
          "read",
          { kind: "read", path, startLine, maxLines },
          abortSignal,
        );
      },
    });
  }
  if (selection.tools.includes("edit")) {
    tools.worker_edit = tool({
      description:
        "Edit existing text files using a hashline patch built from worker_read's snapshots and grammar (or an apply_patch Update File envelope). Requires user approval before staging and applying. Cannot create, delete or move files. Only paths inside the selected Worker directory are allowed. Never automatically retry an unknown or partial write outcome.",
      inputSchema: workerToolInputSchemas.edit,
      execute: (input, { toolCallId, abortSignal }) => {
        if (!usable) return unavailable();
        return write("edit", JSON.stringify(input), input.patch, toolCallId, abortSignal);
      },
    });
    if (usable) toolApproval.worker_edit = "user-approval";
  }
  if (selection.tools.includes("create")) {
    tools.worker_create = tool({
      description:
        "Create a new UTF-8 text file relative to the selected Worker directory. Requires user approval before staging and applying. Refuses existing files; cannot modify existing files. Never automatically retry an unknown write outcome.",
      inputSchema: workerToolInputSchemas.create,
      execute: (input, { toolCallId, abortSignal }) => {
        if (!usable) return unavailable();
        const patch = workerCreatePatch(input.path, input.content);
        return write("create", JSON.stringify(input), patch, toolCallId, abortSignal);
      },
    });
    if (usable) toolApproval.worker_create = "user-approval";
  }
  if (selection.tools.includes("bash")) {
    tools.worker_bash = tool({
      description:
        "Run a foreground shell command on the selected Worker, starting in its configured directory. Requires user approval. Supports pipelines, redirection, builtins and installed executables. Runs with the Worker's OS permissions and environment; the directory is not a sandbox. Returns bounded combined output, exit status and timeout metadata. No managed background jobs, PTY or services. Never automatically retry an unknown outcome.",
      inputSchema: workerToolInputSchemas.bash,
      execute: async (input, { toolCallId, abortSignal }) => {
        if (abortSignal?.aborted) return { ok: false, code: "REQUEST_ABORTED" };
        if (!usable || !directory) return unavailable();
        if (transport.kind === "sealed") {
          return executeSealed("bash", toolCallId, "execute", JSON.stringify(input), abortSignal);
        }
        const { taskId } = await ctx.runMutation(internal.worker_tasks.dispatchChatEdit, {
          chatId,
          userId,
          workerId: selection.workerId,
          directory,
          tool: "bash",
          toolCallId,
          stage: "execute",
          request: {
            directory,
            sessionId: await chatWorkerSessionId(chatId, directory),
            command: input.command,
            timeoutSeconds: input.timeout,
          },
        });
        return waitForPlaintextOutcome(taskId, abortSignal);
      },
    });
    if (usable) toolApproval.worker_bash = "user-approval";
  }
  return { tools, toolApproval };
}
