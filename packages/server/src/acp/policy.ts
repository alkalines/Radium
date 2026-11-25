import { and, eq } from "drizzle-orm";
import {
  acpBindingStatement,
  acpCommandStatement,
  CAPSULE_BYTES,
  toBase64Url,
  utf8,
  verify,
} from "radium-crypto";
import { z } from "zod";
import {
  ACP_SEALED_COMMAND_BYTES,
  ACP_SEALED_SHORT_BYTES,
  ACP_WORKER_ERROR_CODES,
  acpChatScopeValidator,
  validAcpToken,
  type AcpCommandKind,
  type AcpDeletedTarget,
  type AcpSignedBinding,
} from "contracts/acp/contract";
import { base64urlBytes } from "contracts/wire";
import { requireChatAccess, type Chat, type ChatAccess, type ChatLock } from "../chatroom/access";
import { chatMemberIds } from "../chatroom/members";
import type { Database } from "../drivers/types";
import { requireDispatchableWorker, type WorkerKeys } from "../e2ee/worker-keys";
import { activeIdentity } from "../e2ee/workspace-keys";
import { AppError } from "../errors";
import type { StoredJson } from "../db/columns";
import type { WorkerScope } from "../worker/auth";
import { workerAgents } from "../worker/schema";
import { acpCommands, acpSessions } from "./schema";

/*
 * Shared ACP policy (Convex `src/acp/policy.ts` and `sealed.ts`). Every workspace with ACP chats is
 * keyed after the encryption cutover, so only the signed path is ported: browsers send sealed,
 * user-signed commands; the backend checks bounds and the signer, stores bytes, and the paired
 * Worker verifies everything again before acting (`docs/E2EE/Data.md#acp`).
 */

export type AcpSession = typeof acpSessions.$inferSelect;

/** Refusal class of each code that is not `BAD_REQUEST`. */
const ERROR_STATUS: Record<string, "NOT_FOUND" | "FORBIDDEN" | "CONFLICT"> = {
  ACP_NOT_ACP: "NOT_FOUND",
  ACP_SESSION_NOT_FOUND: "NOT_FOUND",
  ACP_AGENT_NOT_FOUND: "NOT_FOUND",
  ACP_DENIED: "FORBIDDEN",
  ACP_SESSION_BUSY: "CONFLICT",
  ACP_SESSION_ENDED: "CONFLICT",
  ACP_SESSION_BOUND: "CONFLICT",
  ACP_SESSION_NOT_RUNNING: "CONFLICT",
  ACP_COMMAND_CLOSED: "CONFLICT",
  ACP_INTERACTION_CLOSED: "CONFLICT",
  ACP_WORKER_BUSY: "CONFLICT",
  ACP_STALE_EPOCH: "CONFLICT",
  ACP_AGENT_EXISTS: "CONFLICT",
  ACP_STALE_AGENT_AUTHORIZATION: "CONFLICT",
  ACP_AGENT_UNAVAILABLE: "CONFLICT",
  ACP_UNSUPPORTED: "CONFLICT",
  ACP_GATEWAY_UNAVAILABLE: "CONFLICT",
  ACP_GATEWAY_KEY_MISSING: "CONFLICT",
  ACP_BINDING_REQUIRED: "CONFLICT",
  ACP_E2EE_REQUIRED: "CONFLICT",
  ACP_SESSION_PROOF_REQUIRED: "CONFLICT",
};

/**
 * Caller-visible ACP refusal. The message is the code (Convex `ConvexError({ code })`), or the
 * human text for the few refusals that carried one; it never contains another Worker's binding,
 * sealed bytes or agent text.
 */
export function acpError(code: string, message?: string): never {
  throw new AppError(ERROR_STATUS[code] ?? "BAD_REQUEST", message ?? code);
}

// ---------------------------------------------------------------------------------------------
// Wire inputs (binary fields as base64url text)

const keyIdInput = z.string().min(1).max(64);

/** A sealed, user-signed command (`AcpSignedCommand`). */
export const signedCommandInput = z.object({
  clientId: z.string().min(1).max(256),
  payload: base64urlBytes(ACP_SEALED_COMMAND_BYTES),
  signature: base64urlBytes(64),
  signerKeyId: keyIdInput,
});
export type SignedCommand = z.output<typeof signedCommandInput>;

/** The creator's signed binding of a keyed ACP chat (`AcpSignedBinding`). */
export const signedBindingInput = z.object({
  version: z.number().int(),
  scope: acpChatScopeValidator,
  members: z.array(z.string().min(1).max(256)).max(200),
  signerKeyId: keyIdInput,
  signature: base64urlBytes(64),
});
export type SignedBinding = z.output<typeof signedBindingInput>;

/** A box sealed to a numbered chat key (or owner key) epoch. */
export const sealedShortInput = z.object({
  epoch: z.number().int(),
  box: base64urlBytes(ACP_SEALED_SHORT_BYTES),
});
export type SealedShort = z.output<typeof sealedShortInput>;

/** A stored binding (`StoredJson`, signature as base64url). */
export function storedBinding(binding: SignedBinding): StoredJson<AcpSignedBinding> {
  return { ...binding, signature: toBase64Url(binding.signature) };
}

// ---------------------------------------------------------------------------------------------
// Sessions and catalog

/** The ACP session of `chat`, optionally locked for the transaction. */
export async function findSession(
  db: Database,
  chat: string,
  lock = false,
): Promise<AcpSession | undefined> {
  const query = db.select().from(acpSessions).where(eq(acpSessions.chat, chat)).$dynamic();
  const [row] = await (lock ? query.for("update") : query);
  return row;
}

export type AcpAccess = ChatAccess & { session: AcpSession };

/**
 * The one Chatroom access rule, then the chat's ACP session: everyone who can see an ACP chat may
 * use it (`docs/ACP.md#who-can-use-it`), personal chats stay private to their creator. `lock`
 * locks the chat and session rows for the caller's transaction.
 */
export async function accessibleSession(
  db: Database,
  userId: string,
  chatId: string,
  lock?: ChatLock,
): Promise<AcpAccess> {
  const access = await requireChatAccess(db, userId, chatId, lock);
  const session = await findSession(db, chatId, lock !== undefined);
  if (!session) acpError("ACP_NOT_ACP");
  return { ...access, session };
}

/** Fences a machine-selected row by the verified workspace and Worker identity. */
export function checkWorker(scope: WorkerScope, row: { workspace: string; worker: string }) {
  if (row.workspace !== scope.workspaceId || row.worker !== scope.workerId) acpError("ACP_DENIED");
}

/** The session of `chat` bound to the calling Worker; anything else is `ACP_DENIED`. */
export async function machineSession(
  db: Database,
  scope: WorkerScope,
  chat: string,
  lock = false,
): Promise<AcpSession> {
  const session = await findSession(db, chat, lock);
  if (!session) acpError("ACP_DENIED");
  checkWorker(scope, session);
  return session;
}

/** The catalog entry of `agentId` on `worker`. */
export async function findAgent(db: Database, worker: string, agentId: string) {
  const [row] = await db
    .select()
    .from(workerAgents)
    .where(and(eq(workerAgents.worker, worker), eq(workerAgents.agentId, agentId)));
  return row;
}

// ---------------------------------------------------------------------------------------------
// Signed dispatch

/**
 * The certified keys of a Worker that may receive commands: the workspace must be keyed (plaintext
 * ACP is gone with the cutover) and the newest roster must list the Worker (`WORKER_NOT_PAIRED`).
 */
export async function requireSignedDispatch(
  db: Database,
  workspace: string,
  worker: string,
): Promise<WorkerKeys> {
  const keys = await requireDispatchableWorker(db, workspace, worker);
  if (!keys) acpError("ACP_E2EE_REQUIRED");
  return keys;
}

/** A signature by `userId`'s active identity, which must be `signerKeyId`. */
export async function verifyUserSignature(
  db: Database,
  input: { userId: string; signerKeyId: string; message: Uint8Array; signature: Uint8Array },
): Promise<void> {
  const identity = await activeIdentity(db, input.userId);
  if (
    !identity ||
    identity.keyId !== input.signerKeyId ||
    input.signature.byteLength !== 64 ||
    !(await verify(identity.signingPublicKey, input.message, input.signature))
  )
    acpError("ACP_INVALID_SIGNATURE");
}

/**
 * A signed command's bounds and its issuer's signature, so `issued_by` names the signer. `chat`
 * is the statement's chat id: the target chat, the deleted chat for `close`/`delete`, or `""`.
 */
export async function verifySignedCommand(
  db: Database,
  input: {
    workspace: string;
    worker: string;
    chat: string;
    kind: AcpCommandKind;
    userId: string;
    signed: SignedCommand;
  },
): Promise<void> {
  const { signed } = input;
  if (
    !validAcpToken(signed.clientId, 128) ||
    signed.payload.byteLength <= CAPSULE_BYTES ||
    signed.payload.byteLength > ACP_SEALED_COMMAND_BYTES
  )
    acpError("ACP_INVALID_COMMAND");
  await verifyUserSignature(db, {
    userId: input.userId,
    signerKeyId: signed.signerKeyId,
    signature: signed.signature,
    message: acpCommandStatement({
      workspaceId: input.workspace,
      workerId: input.worker,
      chatId: input.chat,
      kind: input.kind,
      clientId: signed.clientId,
      payload: signed.payload,
    }),
  });
}

/**
 * The command a Worker already holds under `clientId`, or null. Idempotency keys are scoped to a
 * Worker but never grant access to another issuer's command (`ACP_DENIED`).
 */
export async function existingCommand(
  db: Database,
  worker: string,
  clientId: string,
  userId: string,
): Promise<typeof acpCommands.$inferSelect | null> {
  if (!validAcpToken(clientId, 128)) acpError("ACP_INVALID_CLIENT_ID");
  const [row] = await db
    .select()
    .from(acpCommands)
    .where(and(eq(acpCommands.worker, worker), eq(acpCommands.clientId, clientId)));
  if (row && row.issuedBy !== userId) acpError("ACP_DENIED");
  return row ?? null;
}

/**
 * Inserts a verified signed command (callers ran {@link verifySignedCommand}). The signed
 * `clientId` dedupes per Worker through the unique `(worker, client_id)`: a concurrent or retried
 * insert returns the existing command, unless another user issued it.
 */
export async function insertSignedCommand(
  tx: Database,
  input: {
    workspace: string;
    worker: string;
    issuedBy: string;
    kind: AcpCommandKind;
    signed: SignedCommand;
    chat?: string;
    agentId?: string;
    target?: StoredJson<AcpDeletedTarget>;
    result?: string;
  },
): Promise<string> {
  const [row] = await tx
    .insert(acpCommands)
    .values({
      workspace: input.workspace,
      worker: input.worker,
      chat: input.chat ?? null,
      kind: input.kind,
      agentId: input.agentId ?? null,
      signedPayload: input.signed.payload,
      signedSignature: input.signed.signature,
      signedSignerKeyId: input.signed.signerKeyId,
      target: input.target ?? null,
      clientId: input.signed.clientId,
      issuedBy: input.issuedBy,
      result: input.result ?? null,
    })
    .onConflictDoNothing({ target: [acpCommands.worker, acpCommands.clientId] })
    .returning({ id: acpCommands.id });
  if (row) return row.id;
  const existing = await existingCommand(tx, input.worker, input.signed.clientId, input.issuedBy);
  if (!existing) acpError("ACP_DENIED");
  return existing.id;
}

// ---------------------------------------------------------------------------------------------
// Bindings

/** The exact bytes a binding signature covers, from the stored session and chat. */
export function bindingStatement(
  session: Pick<AcpSession, "workspace" | "chat" | "worker" | "agentId" | "profile" | "cwd">,
  chat: Pick<Chat, "e2eeId" | "userId">,
  binding: { scope: Chat["scope"]; members: string[]; version: number },
) {
  return acpBindingStatement({
    workspaceId: session.workspace,
    chatId: session.chat,
    chatE2eeId: chat.e2eeId ?? "",
    creatorUserId: chat.userId,
    workerId: session.worker,
    agentId: session.agentId,
    profile: session.profile,
    cwd: session.cwd,
    scope: binding.scope,
    members: binding.members,
    version: binding.version,
  });
}

/**
 * The next binding version of a keyed ACP chat: signed by its creator over the stored session
 * fields and exactly the audience the chat has (`scope`, shared members) after the change.
 */
export async function verifyNextBinding(
  db: Database,
  input: {
    session: AcpSession;
    chat: Chat;
    scope: Chat["scope"];
    members: string[];
    binding: SignedBinding;
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
  await verifyUserSignature(db, {
    userId: chat.userId,
    signerKeyId: binding.signerKeyId,
    signature: binding.signature,
    message: bindingStatement(session, chat, binding),
  });
}

/** The current audience of a chat as a binding must sign it. */
export async function chatAudience(db: Database, chat: Chat) {
  return {
    scope: chat.scope,
    members: chat.scope === "shared" ? await chatMemberIds(db, chat.id) : [],
  };
}

/**
 * An owner's import proof for an indexed agent session: their signature over `acpCommandStatement`
 * with kind `import`, clientId the session id and payload the UTF-8 agent id.
 */
export async function verifyImportProof(
  db: Database,
  input: {
    session: AcpSession;
    ownerId: string;
    proof: { signerKeyId: string; signature: Uint8Array };
  },
): Promise<void> {
  const { session } = input;
  if (!session.sessionId) acpError("ACP_INVALID_BINDING");
  await verifyUserSignature(db, {
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

/**
 * Chat-scope hook (`e2ee/chat-scope.ts`): an ACP chat whose binding was published changes its
 * audience only with the creator's next binding version for exactly the new audience, stored in
 * the same transaction, so its Worker authorizes the new members (or stops authorizing removed
 * ones). Built-in chats take no binding. Runs under the chat row lock.
 */
export async function rebindAcpChat(
  tx: Database,
  chat: Chat,
  next: { scope: Chat["scope"]; members: string[] },
  binding: SignedBinding | undefined,
): Promise<void> {
  const session = await findSession(tx, chat.id, true);
  if (!session?.binding) {
    if (binding) acpError("ACP_INVALID_BINDING");
    return;
  }
  if (!binding) acpError("ACP_BINDING_REQUIRED");
  await verifyNextBinding(tx, { session, chat: { ...chat, ...next }, ...next, binding });
  await tx
    .update(acpSessions)
    .set({ binding: storedBinding(binding), updatedAt: new Date() })
    .where(eq(acpSessions.id, session.id));
}

/** Bounds of a sealed box, never echoing its bytes. */
export function requireSealedBox(box: Uint8Array, maxBytes: number) {
  if (box.byteLength <= CAPSULE_BYTES || box.byteLength > maxBytes) acpError("ACP_INVALID_SEALED");
}

/** Whether `value` is one of the fixed codes a paired Worker may report instead of free text. */
export function isWorkerErrorCode(value: string) {
  return (ACP_WORKER_ERROR_CODES as readonly string[]).includes(value);
}

/** A stored sealed box (`epoch` + bytes) on the wire, or null. */
export function sealedWire(epoch: number | null, box: Uint8Array | null) {
  return epoch !== null && box !== null ? { epoch, box: toBase64Url(box) } : null;
}
