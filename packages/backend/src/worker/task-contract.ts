import { v, type Infer } from "convex/values";
import { z } from "zod";
import type { AadParts } from "radium-crypto";
import { workerCreatePatch, workerEditRequest, workerEditResult } from "./edit-contract";
import { chatWorkerToolValidator } from "./chat-config";
import { WORKER_BASH_TIMEOUT_SECONDS, workerBashRequest } from "./bash-contract";
import { legacyBoxValidator } from "../e2ee/legacy-contract";

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

/** Byte length of the X-Wing HPKE encapsulation that opens a sealed task request. */
export const WORKER_TASK_ENCAPSULATED_BYTES = 1120;

/** Bound on a sealed request's JSON before padding; the action refuses larger requests. */
export const WORKER_SEALED_REQUEST_PLAINTEXT_BYTES = 192 * 1024;

/** Stored bound on a sealed request: the padded plaintext (4 KiB pages) plus the AEAD tag. */
export const WORKER_SEALED_REQUEST_BYTES = 200 * 1024;

/** Bound on a result's JSON before padding; a Worker replaces larger results with a fixed failure. */
export const WORKER_SEALED_RESULT_PLAINTEXT_BYTES = 192 * 1024;

/** Stored bound on a sealed result or receipt: padded plaintext, envelope header, receipt capsule. */
export const WORKER_SEALED_RESULT_BYTES = 200 * 1024;

/**
 * A built-in tool task for a paired Worker: the request sealed with `openRequestSender` to the
 * Worker encryption key `keyId` (AAD {@link workerTaskAad} field `request`). The backend stores and
 * relays bytes only; every plaintext check happens in the action before sealing or in the Worker.
 */
export const workerSealedTask = v.object({
  keyId: v.string(),
  encapsulated: v.bytes(),
  request: v.bytes(),
});

/**
 * Legacy tasks persist coordination metadata. File/Bash tasks additionally carry bounded,
 * short-lived tool requests/results; chat-call receipts persist chat dispatch outcomes.
 * Keyless workspaces with unpaired Workers use plaintext `editRequest`/`bashRequest`/`result`;
 * paired Workers get only `sealed` and answer with `sealedResult` (`sealSym` under the request's
 * response key, AAD {@link workerTaskAad} field `result`).
 * `requestId` deduplicates dispatch to one Worker; `revision` fences stale status
 * updates and `attempt` counts starts, including explicitly requested retries.
 */
export const workerTaskFields = {
  workspace: v.id("workspaces"),
  legacyContent: v.optional(legacyBoxValidator),
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
  sealed: v.optional(workerSealedTask),
  editOwnerId: v.optional(v.string()),
  claimId: v.optional(v.string()),
  result: v.optional(workerEditResult),
  sealedResult: v.optional(v.bytes()),
};

export const workerTaskRecord = v.object({
  _id: v.id("worker_tasks"),
  _creationTime: v.number(),
  ...workerTaskFields,
});

/**
 * Durable per-call/stage receipts outlive short-lived tasks. `requestKey` binds a receipt to
 * its canonical request (the request ID for sealed tasks); the completion claim and revision
 * fence acknowledgments after task pruning. Sealed tasks never store a plaintext `result`: the
 * Worker seals `sealedResult` to the chat key epoch `receiptEpoch` (AAD {@link workerReceiptAad}).
 */
export const workerChatCallFields = {
  workspace: v.id("workspaces"),
  legacyContent: v.optional(legacyBoxValidator),
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
  sealedResult: v.optional(v.bytes()),
  receiptEpoch: v.optional(v.number()),
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

/** Each tool runs only its own stages: Read reads, Edit/Create preview then apply, Bash executes. */
export function workerChatStageMatchesTool(tool: WorkerChatTool, stage: WorkerChatStage): boolean {
  switch (tool) {
    case "read":
      return stage === "read";
    case "edit":
    case "create":
      return stage === "preview" || stage === "apply";
    case "bash":
      return stage === "execute";
  }
}

/** Deterministic task request ID of one chat call stage; the action seals to it before dispatch. */
export async function workerChatTaskRequestId(
  chatId: string,
  toolCallId: string,
  stage: WorkerChatStage,
): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([chatId, toolCallId, stage]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `chat-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** AAD of a sealed task request (`request`) or its request-key result (`result`). */
export function workerTaskAad(input: {
  workspaceId: string;
  chatId: string;
  requestId: string;
  field: "request" | "result";
}): AadParts {
  return {
    table: "worker_tasks",
    workspace: input.workspaceId,
    parent: input.chatId,
    record: input.requestId,
    field: input.field,
  };
}

/** AAD of a durable receipt the Worker seals to the chat key (`sealBox`, pad `content`). */
export function workerReceiptAad(input: {
  workspaceId: string;
  chatE2eeId: string;
  toolCallId: string;
  stage: WorkerChatStage;
}): AadParts {
  return {
    table: "worker_chat_calls",
    workspace: input.workspaceId,
    parent: input.chatE2eeId,
    record: `${input.toolCallId}:${input.stage}`,
    field: "result",
  };
}

/**
 * Model-facing input schemas of the built-in Worker tools. The chat action exposes them to the
 * model; Workers parse the signed (or grant-covered) input JSON with the same schemas, so bounds
 * and defaults cannot drift. Unknown keys are stripped and never reach an operation.
 */
export const workerToolInputSchemas = {
  read: z.object({
    path: z.string().min(1).max(4096),
    startLine: z.number().int().positive().optional(),
    maxLines: z.number().int().min(1).max(5000).optional(),
  }),
  edit: z.object({ patch: z.string().min(1).max(30_000) }),
  create: z.object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !/[\r\n\0]/.test(path), "Path must be one line"),
    content: z
      .string()
      .max(24_000)
      .refine((content) => !content.includes("\0"), "Text only"),
  }),
  bash: z.object({
    command: z
      .string()
      .min(1)
      .max(16 * 1024)
      .refine(
        (value) => value.trim().length > 0 && !value.includes("\0"),
        "Command must be nonempty and contain no NUL",
      ),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(WORKER_BASH_TIMEOUT_SECONDS)
      .default(WORKER_BASH_TIMEOUT_SECONDS),
  }),
};

const signedFields = {
  signature: z.string().min(1).max(128),
  signerKeyId: z.string().min(1).max(128),
};

/**
 * How long after `approvedAt` a Worker accepts an approval; executed approvals are remembered for
 * this long (plus clock skew) only. Approval and execution normally happen within one or two turns.
 */
export const WORKER_APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

/** Tolerated lead of the approving client's clock over the Worker's. */
export const WORKER_APPROVAL_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Who authorized a sealed task, signed by the workspace owner's identity key (base64url
 * `signature`, identity key ID `signerKeyId`):
 * - `approval`: Edit/Create/Bash; over `toolApprovalStatement` with `input` = the exact UTF-8 JSON
 *   the user approved (`JSON.stringify` of the tool part input) and `approvedAt` (ms). Workers derive
 *   the operation from this `input` only and accept it within {@link WORKER_APPROVAL_WINDOW_MS}.
 * - `grant`: Read; over `toolGrantStatement` for the chat's Worker selection (tools, `issuedAt` ms).
 */
const workerToolAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    input: z.string().max(192 * 1024),
    approvedAt: z.number().int().positive(),
    ...signedFields,
  }),
  z.object({
    kind: z.literal("grant"),
    tools: z.array(z.enum(["read", "edit", "create", "bash"])).max(4),
    issuedAt: z.number().int().positive(),
    ...signedFields,
  }),
]);

export type WorkerToolAuthorization = z.infer<typeof workerToolAuthorizationSchema>;

/**
 * Plaintext of a sealed built-in task request (UTF-8 JSON, padded `content`, sealed with
 * `openRequestSender(...).seal` under {@link workerTaskAad} field `request`). `input` is the unsigned
 * Read input a grant covers. `receipt` names the chat key epoch (base64url public key) the Worker
 * seals the durable receipt to, with the proof the Worker verifies before running anything: the
 * epoch signature and the binding signature over this chat ID, scope, creator and raw picked
 * members. Chats without keys omit it and keep no receipt content.
 */
export const workerSealedTaskRequestSchema = z.object({
  v: z.literal(1),
  workspaceId: z.string().min(1).max(128),
  chatId: z.string().min(1).max(128),
  workerId: z.string().min(1).max(128),
  directory: z.string().min(1).max(4096),
  tool: z.enum(["read", "edit", "create", "bash"]),
  toolCallId: z.string().min(1).max(128),
  stage: z.enum(["read", "preview", "apply", "execute"]),
  authorization: workerToolAuthorizationSchema,
  input: z
    .string()
    .max(192 * 1024)
    .optional(),
  receipt: z
    .object({
      e2eeId: z.string().min(1).max(128),
      epoch: z.number().int().nonnegative(),
      publicKey: z.string().min(1).max(4096),
      keyId: z.string().min(1).max(128),
      suite: z.number().int().nonnegative(),
      signerKeyId: z.string().min(1).max(128),
      signature: z.string().min(1).max(128),
      bindingSignature: z.string().min(1).max(128),
      scope: z.enum(["personal", "shared", "workspace"]),
      creatorId: z.string().min(1).max(128),
      members: z.array(z.string().min(1).max(128)).max(200),
    })
    .optional(),
});

export type WorkerSealedTaskRequest = z.infer<typeof workerSealedTaskRequestSchema>;

/** The one operation a tool input describes; Create inputs become their Add File patch. */
export type WorkerToolOperation =
  | { tool: "read"; path: string; startLine?: number; maxLines?: number }
  | { tool: "edit" | "create"; patch: string }
  | { tool: "bash"; command: string; timeoutSeconds: number };

/** Whether two derived operations run exactly the same thing (field order is irrelevant). */
export function sameWorkerToolOperation(left: WorkerToolOperation, right: WorkerToolOperation) {
  switch (left.tool) {
    case "read":
      return (
        right.tool === "read" &&
        left.path === right.path &&
        left.startLine === right.startLine &&
        left.maxLines === right.maxLines
      );
    case "edit":
    case "create":
      return right.tool === left.tool && left.patch === right.patch;
    case "bash":
      return (
        right.tool === "bash" &&
        left.command === right.command &&
        left.timeoutSeconds === right.timeoutSeconds
      );
  }
}

const workerToolNames: Record<string, WorkerChatTool> = {
  worker_read: "read",
  worker_edit: "edit",
  worker_create: "create",
  worker_bash: "bash",
};

/** The Worker tool behind a Chatroom tool name (`worker_bash` → `bash`), or `undefined`. */
export function workerChatToolFromToolName(name: string): WorkerChatTool | undefined {
  return Object.hasOwn(workerToolNames, name) ? workerToolNames[name] : undefined;
}

/**
 * Derive the operation from a tool input's JSON with {@link workerToolInputSchemas}. Malformed JSON
 * or input is `null`. Workers run only the operation derived here from signed or grant-covered input.
 */
export function parseWorkerToolInput(
  tool: WorkerChatTool,
  input: string,
): WorkerToolOperation | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }

  switch (tool) {
    case "read": {
      const parsed = workerToolInputSchemas.read.safeParse(value);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "edit": {
      const parsed = workerToolInputSchemas.edit.safeParse(value);
      return parsed.success ? { tool, patch: parsed.data.patch } : null;
    }
    case "create": {
      const parsed = workerToolInputSchemas.create.safeParse(value);
      if (!parsed.success) return null;
      return { tool, patch: workerCreatePatch(parsed.data.path, parsed.data.content) };
    }
    case "bash": {
      const parsed = workerToolInputSchemas.bash.safeParse(value);
      if (!parsed.success) return null;
      return { tool, command: parsed.data.command, timeoutSeconds: parsed.data.timeout };
    }
  }
}
