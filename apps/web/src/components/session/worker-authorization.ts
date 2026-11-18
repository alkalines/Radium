import type { Id } from "backend/convex/_generated/dataModel";
import {
  grantedChatWorkerTools,
  type ChatWorkerGrant,
  type ChatWorkerSelection,
} from "backend/src/worker/chat-config";
import type { WorkerApprovalSignature } from "backend/src/worker/chat-tools";
import { WORKER_GRANT_TTL_MS, workerChatToolFromToolName } from "backend/src/worker/task-contract";
import {
  CryptoError,
  toBase64Url,
  toolApprovalStatement,
  toolGrantStatement,
  utf8,
  type ToolReceiptRecipient,
} from "radium-crypto";
import { writableChatKey } from "@/lib/crypto/chat-keys";
import { buffer } from "@/lib/crypto/runtime";
import { signAsUser } from "@/lib/crypto/workers";

/**
 * Browser side of Worker tool authorization (docs/E2EE/Data.md "Worker Tasks From The Built-In
 * Agent"). A paired Worker runs an Edit/Create/Bash call only with the owner's signature over the
 * exact input shown in the approval prompt, and a Read only under the owner's standing grant for a
 * Worker selection the owner approved on this device. Signing throws `KeysLockedError` while the
 * device is locked.
 */

/** The chat's Worker target as the browser read it from `aisdk.GetChat`. */
export type WorkerAuthorizationTarget = {
  workspaceId: Id<"workspaces">;
  chatId: Id<"aisdk_chats">;
  workerId: string;
  directory: string;
  /** The chat's key identity (`chat.e2eeId`); `null` for a chat without keys (no receipt content). */
  e2eeId: string | null;
};

/**
 * The chat key epoch the Worker must seal the call's durable receipt to, as this browser verified
 * it (`writableChatKey`: the current epoch and the audience its binding proves). The backend sends
 * the same epoch as `WorkerSealedTaskRequest.receipt`; the Worker rebuilds the statement from it.
 */
async function receiptRecipient(
  target: WorkerAuthorizationTarget,
): Promise<(NonNullable<ToolReceiptRecipient> & { keyId: string }) | null> {
  if (!target.e2eeId) return null;
  const key = await writableChatKey(target.chatId);
  if (key.e2eeId !== target.e2eeId || key.workspaceId !== target.workspaceId)
    throw new CryptoError("DECRYPT_FAILED", "Chat key identity changed");
  return { chatE2eeId: key.e2eeId, scope: key.scope, creatorId: key.creatorId, keyId: key.keyId };
}

/**
 * Sign the approval of one Worker tool call over `JSON.stringify(input)`, the input the user saw,
 * the current time (Workers accept it for a bounded window) and the chat key epoch its receipt is
 * sealed to. Returns `null` for tools that are not approval-gated Worker tools (nothing to sign).
 */
export async function signToolApproval(
  target: WorkerAuthorizationTarget,
  call: { toolName: string; toolCallId: string; input: unknown },
): Promise<WorkerApprovalSignature | null> {
  const tool = workerChatToolFromToolName(call.toolName);
  if (!tool || tool === "read") return null;
  const input = JSON.stringify(call.input);
  const receipt = await receiptRecipient(target);
  const approvedAt = Date.now();
  const { signature, signerKeyId } = await signAsUser(
    toolApprovalStatement({
      workspaceId: target.workspaceId,
      chatId: target.chatId,
      workerId: target.workerId,
      directory: target.directory,
      tool,
      toolCallId: call.toolCallId,
      input: utf8(input),
      approvedAt,
      receipt,
    }),
  );
  return { signature: toBase64Url(signature), signerKeyId, input, approvedAt };
}

/**
 * Sign the standing grant (`toolGrantStatement`, `issuedAt` = now) for the selection's tools that
 * need no per-call approval, bound to the chat's receipt audience (not its epoch, so rotation keeps
 * it valid). Only for a selection the user approved (`workerGrantAction`). Store it with
 * `aisdk.SetChatWorkerGrant`.
 */
export async function signToolGrant(
  target: WorkerAuthorizationTarget,
  selection: ChatWorkerSelection,
): Promise<ChatWorkerGrant> {
  const tools = grantedChatWorkerTools(selection.tools);
  const recipient = await receiptRecipient(target);
  const receipt = recipient
    ? { chatE2eeId: recipient.chatE2eeId, scope: recipient.scope, creatorId: recipient.creatorId }
    : null;
  const issuedAt = Date.now();
  const { signature, signerKeyId } = await signAsUser(
    toolGrantStatement({
      workspaceId: target.workspaceId,
      chatId: target.chatId,
      workerId: target.workerId,
      directory: target.directory,
      tools,
      issuedAt,
      receipt,
    }),
  );
  return { tools, issuedAt, signature: buffer(signature), signerKeyId };
}

/**
 * The Worker selection a user approved for a chat on this device (after seeing its directory),
 * stored in `localStorage` per user, workspace and chat.
 */
type WorkerApproval = {
  workspaceId: string;
  chatId: string;
  workerId: string;
  directory: string;
  tools: string[];
};

const approvalStorageKey = (userId: string, workspaceId: string, chatId: string) =>
  `radium.worker-approval.v1:${userId}:${workspaceId}:${chatId}`;

/**
 * Drops the chat's approval when the user picks a Worker selection (the Worker picker, or sending
 * a draft): the server derives the new directory, which the user must confirm before any grant is
 * signed, and a server reverting to the older selection is never re-signed.
 */
export function forgetWorkerApproval(userId: string, workspaceId: string, chatId: string): void {
  try {
    localStorage.removeItem(approvalStorageKey(userId, workspaceId, chatId));
  } catch {
    /* Storage disabled: nothing is stored either. */
  }
}

/** Records the user's approval of exactly this Worker, directory and tools for the chat. */
export function recordWorkerApproval(
  userId: string,
  target: WorkerAuthorizationTarget,
  tools: string[],
): void {
  const { workspaceId, chatId, workerId, directory } = target;
  const approval: WorkerApproval = {
    workspaceId,
    chatId,
    workerId,
    directory,
    tools: [...tools].sort(),
  };
  try {
    localStorage.setItem(approvalStorageKey(userId, workspaceId, chatId), JSON.stringify(approval));
  } catch {
    /* Without storage the user is asked again on the next refresh. */
  }
}

function storedApproval(userId: string, target: WorkerAuthorizationTarget): WorkerApproval | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(approvalStorageKey(userId, target.workspaceId, target.chatId)) ?? "null",
    );
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      record.workspaceId !== target.workspaceId ||
      record.chatId !== target.chatId ||
      typeof record.workerId !== "string" ||
      typeof record.directory !== "string" ||
      !Array.isArray(record.tools) ||
      !record.tools.every((tool) => typeof tool === "string")
    )
      return null;
    return record as WorkerApproval;
  } catch {
    return null;
  }
}

const sortedTools = (tools: readonly string[]) => JSON.stringify([...tools].sort());

/**
 * What this browser may do about the standing grant of a chat's server-reported selection (which
 * includes Read). Never signs from server data alone:
 * - `sign`: exactly the selection approved here (Worker, directory, tools) whose grant is missing,
 *   not signed by `signerKeyId`, for other tools, or past half of `WORKER_GRANT_TTL_MS`; re-sign.
 * - `confirm`: not approved here and without a fresh grant; only the user confirming this exact
 *   selection (directory shown) records the approval and signs.
 * - `none`: the grant is fresh.
 * The served grant only decides when to refresh; Workers verify it themselves.
 */
export function workerGrantAction(input: {
  userId: string;
  signerKeyId: string;
  target: WorkerAuthorizationTarget;
  selection: ChatWorkerSelection;
  now: number;
}): "sign" | "confirm" | "none" {
  const { target, selection, now } = input;
  const grant = selection.grant;
  const fresh =
    grant !== undefined &&
    grant.signerKeyId === input.signerKeyId &&
    sortedTools(grant.tools) === sortedTools(grantedChatWorkerTools(selection.tools)) &&
    now - grant.issuedAt < WORKER_GRANT_TTL_MS / 2;
  if (fresh) return "none";
  const approval = storedApproval(input.userId, target);
  return approval?.workerId === target.workerId &&
    approval.directory === target.directory &&
    sortedTools(approval.tools) === sortedTools(selection.tools)
    ? "sign"
    : "confirm";
}
