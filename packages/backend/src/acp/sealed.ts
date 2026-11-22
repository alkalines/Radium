import {
  acpBindingStatement,
  acpCommandStatement,
  CAPSULE_BYTES,
  equalBytes,
  utf8,
  verify,
} from "radium-crypto";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { chatMemberIds } from "../chatroom/members";
import { activeIdentityFor } from "../e2ee/workspace-contract";
import { requireDispatchableWorker } from "../e2ee/worker-keys";
import {
  ACP_SEALED_COMMAND_BYTES,
  ACP_WORKER_ERROR_CODES,
  validAcpToken,
  type AcpCommandKind,
  type AcpSignedBinding,
  type AcpSignedCommand,
} from "contracts/acp/contract";
import { acpError } from "./policy";

/**
 * Keyed-workspace (end-to-end) ACP policy. Convex only stores and relays what browsers and the
 * Worker seal and sign; the checks here reject malformed or mis-attributed input early, while the
 * paired Worker verifies every signature itself before acting (`docs/E2EE/Data.md#acp`).
 */

type ReadCtx = QueryCtx | MutationCtx;

/** Whether a workspace has keys: then ACP content may only be stored sealed. */
export async function workspaceHasKeys(ctx: ReadCtx, workspace: Id<"workspaces">) {
  return !!(await ctx.db.get(workspace))?.keyEpoch;
}

/**
 * The dispatch mode of a Worker: `true` (signed) in a keyed workspace, where the Worker must be
 * listed in the latest roster (`WORKER_NOT_PAIRED` otherwise), `false` for the keyless plaintext path.
 */
export async function signedDispatch(
  ctx: ReadCtx,
  workspace: Id<"workspaces">,
  worker: string,
): Promise<boolean> {
  return (await requireDispatchableWorker(ctx, workspace, worker)) !== null;
}

/** Refuse a plaintext/sealed argument that does not match the dispatch mode. */
export function requireMode(signed: boolean, hasSigned: boolean, hasPlain: boolean) {
  if (signed ? !hasSigned || hasPlain : hasSigned || !hasPlain) acpError("ACP_E2EE_MODE");
}

/** A signature by `userId`'s active identity, which must be `signerKeyId`. */
export async function verifyUserSignature(
  ctx: ReadCtx,
  input: { userId: string; signerKeyId: string; message: Uint8Array; signature: ArrayBuffer },
): Promise<void> {
  const identity = await activeIdentityFor(ctx, input.userId);
  if (
    !identity ||
    identity.keyId !== input.signerKeyId ||
    !(await verify(
      new Uint8Array(identity.signingPublicKey),
      input.message,
      new Uint8Array(input.signature),
    ))
  )
    acpError("ACP_INVALID_SIGNATURE");
}

/**
 * Check a signed command's bounds and that its issuer signed it, so `by` names the signer. `chat`
 * is the statement's chat ID: the target chat, the deleted chat for `close`/`delete`, or `""`.
 */
export async function verifySignedCommand(
  ctx: ReadCtx,
  input: {
    workspace: Id<"workspaces">;
    worker: string;
    chat: string;
    kind: AcpCommandKind;
    userId: string;
    signed: AcpSignedCommand;
  },
): Promise<void> {
  const { signed } = input;
  if (
    !validAcpToken(signed.clientId, 128) ||
    signed.payload.byteLength <= CAPSULE_BYTES ||
    signed.payload.byteLength > ACP_SEALED_COMMAND_BYTES
  )
    acpError("ACP_INVALID_COMMAND");
  await verifyUserSignature(ctx, {
    userId: input.userId,
    signerKeyId: signed.signerKeyId,
    signature: signed.signature,
    message: acpCommandStatement({
      workspaceId: input.workspace,
      workerId: input.worker,
      chatId: input.chat,
      kind: input.kind,
      clientId: signed.clientId,
      payload: new Uint8Array(signed.payload),
    }),
  });
}

/** The exact bytes a binding signature covers, from the stored session and chat. */
export function bindingStatement(
  session: Pick<
    Doc<"acp_sessions">,
    "workspace" | "chat" | "worker" | "agentId" | "profile" | "cwd"
  >,
  chat: Pick<Doc<"aisdk_chats">, "e2eeId" | "userId">,
  binding: Pick<AcpSignedBinding, "scope" | "members" | "version">,
) {
  return acpBindingStatement({
    workspaceId: session.workspace,
    chatId: session.chat,
    chatE2eeId: chat.e2eeId ?? "",
    creatorUserId: chat.userId,
    workerId: session.worker,
    agentId: session.agentId,
    profile: session.profile ?? "native",
    cwd: session.cwd,
    scope: binding.scope,
    members: binding.members,
    version: binding.version,
  });
}

/**
 * Validate the next binding version of a keyed ACP chat: signed by its creator over the stored
 * session fields and exactly the audience the chat has (`scope`, shared members) after the change.
 */
export async function verifyNextBinding(
  ctx: ReadCtx,
  input: {
    session: Doc<"acp_sessions">;
    chat: Doc<"aisdk_chats">;
    scope: "personal" | "shared" | "workspace";
    members: string[];
    binding: AcpSignedBinding;
  },
): Promise<void> {
  const { session, chat, binding } = input;
  const expected = [...input.members].sort();
  const signed = [...binding.members].sort();
  if (
    !chat.e2eeId ||
    binding.version !== (session.binding?.version ?? 0) + 1 ||
    binding.scope !== input.scope ||
    signed.length !== expected.length ||
    signed.some((member, index) => member !== expected[index])
  )
    acpError("ACP_INVALID_BINDING");
  await verifyUserSignature(ctx, {
    userId: chat.userId,
    signerKeyId: binding.signerKeyId,
    signature: binding.signature,
    message: bindingStatement(session, chat, binding),
  });
}

/** Current audience of a chat as a binding must sign it. */
export async function chatAudience(ctx: ReadCtx, chat: Doc<"aisdk_chats">) {
  const scope = chat.scope ?? "personal";
  return { scope, members: scope === "shared" ? await chatMemberIds(ctx, chat._id) : [] };
}

/**
 * Check an owner's import proof for an indexed agent session: their signature over
 * `acpCommandStatement` with kind `import`, clientId sessionId and payload UTF-8 agentId.
 */
export async function verifyImportProof(
  ctx: ReadCtx,
  input: {
    session: Doc<"acp_sessions">;
    ownerId: string;
    proof: { signerKeyId: string; signature: ArrayBuffer };
  },
): Promise<void> {
  const { session } = input;
  if (!session.sessionId) acpError("ACP_INVALID_BINDING");
  await verifyUserSignature(ctx, {
    userId: input.ownerId,
    signerKeyId: input.proof.signerKeyId,
    signature: input.proof.signature,
    message: acpCommandStatement({
      workspaceId: session.workspace,
      workerId: session.worker,
      chatId: session.chat,
      kind: "import",
      clientId: session.sessionId,
      payload: utf8(session.agentId),
    }),
  });
}

/** Bounds of a sealed box, never echoing its bytes. */
export function requireSealedBox(box: ArrayBuffer, maxBytes: number) {
  if (box.byteLength <= CAPSULE_BYTES || box.byteLength > maxBytes) acpError("ACP_INVALID_SEALED");
}

/** Byte equality of two stored byte fields. */
export function sameBytes(a: ArrayBuffer, b: ArrayBuffer) {
  return equalBytes(new Uint8Array(a), new Uint8Array(b));
}

/** Equality of frame payloads in either form (exact-retry detection in `appendFrames`). */
export function samePayload(a: string | ArrayBuffer, b: string | ArrayBuffer) {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return sameBytes(a, b);
}

/** Whether `value` is one of the fixed codes a paired Worker may report instead of free text. */
export function isWorkerErrorCode(value: string) {
  return (ACP_WORKER_ERROR_CODES as readonly string[]).includes(value);
}
