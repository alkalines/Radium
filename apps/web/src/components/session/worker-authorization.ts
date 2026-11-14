import type { Id } from "backend/convex/_generated/dataModel";
import {
  grantedChatWorkerTools,
  type ChatWorkerGrant,
  type ChatWorkerSelection,
} from "backend/src/worker/chat-config";
import type { WorkerApprovalSignature } from "backend/src/worker/chat-tools";
import { workerChatToolFromToolName } from "backend/src/worker/task-contract";
import { toBase64Url, toolApprovalStatement, toolGrantStatement, utf8 } from "radium-crypto";
import { buffer } from "@/lib/crypto/runtime";
import { signAsUser } from "@/lib/crypto/workers";

/**
 * Browser side of Worker tool authorization (docs/E2EE/Data.md "Worker Tasks From The Built-In
 * Agent"). A paired Worker runs an Edit/Create/Bash call only with the owner's signature over the
 * exact input shown in the approval prompt, and a Read only under the owner's standing grant for the
 * chat's Worker selection. Both throw `KeysLockedError` while the device is locked.
 */

/** The chat's Worker target as the browser read it from `aisdk.GetChat`. */
export type WorkerAuthorizationTarget = {
  workspaceId: Id<"workspaces">;
  chatId: Id<"aisdk_chats">;
  workerId: string;
  directory: string;
};

/**
 * Sign the approval of one Worker tool call over `JSON.stringify(input)`, the input the user saw,
 * and the current time (Workers accept it for a bounded window). Returns `null` for tools that are
 * not approval-gated Worker tools (nothing to sign).
 */
export async function signToolApproval(
  target: WorkerAuthorizationTarget,
  call: { toolName: string; toolCallId: string; input: unknown },
): Promise<WorkerApprovalSignature | null> {
  const tool = workerChatToolFromToolName(call.toolName);
  if (!tool || tool === "read") return null;
  const input = JSON.stringify(call.input);
  const approvedAt = Date.now();
  const { signature, signerKeyId } = await signAsUser(
    toolApprovalStatement({
      ...target,
      tool,
      toolCallId: call.toolCallId,
      input: utf8(input),
      approvedAt,
    }),
  );
  return { signature: toBase64Url(signature), signerKeyId, input, approvedAt };
}

/**
 * Sign the standing grant (`toolGrantStatement`, `issuedAt` = now) for the selection's tools that
 * need no per-call approval. Store it with `aisdk.SetChatWorkerGrant`.
 */
export async function signToolGrant(
  target: WorkerAuthorizationTarget,
  selection: ChatWorkerSelection,
): Promise<ChatWorkerGrant> {
  const tools = grantedChatWorkerTools(selection.tools);
  const issuedAt = Date.now();
  const { signature, signerKeyId } = await signAsUser(
    toolGrantStatement({ ...target, tools, issuedAt }),
  );
  return { tools, issuedAt, signature: buffer(signature), signerKeyId };
}
