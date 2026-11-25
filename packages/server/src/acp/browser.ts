import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { acpAnswerStatement, toBase64Url } from "radium-crypto";
import { z } from "zod";
import {
  ACP_BUSY_STATUSES,
  ACP_SEALED_INTERACTION_BYTES,
  acpProfileValidator,
  validAcpAgentId,
} from "contracts/acp/contract";
import { acpGatewayProfileOffered } from "contracts/acp/gateway";
import { validChatWorkerDirectory } from "contracts/worker/chat-config";
import { base64urlBytes } from "contracts/wire";
import { visibleWorkspaceChats, type Chat } from "../chatroom/access";
import { createAcpChat, saveSealedTitle, touchChat } from "../chatroom/chats";
import { sealChatTitle, sealedBoxInput, validateChatBox, MAX_TITLE_BOX_BYTES } from "../chatroom/sealing";
import { titleModelFor } from "../chatroom/settings";
import { generateChatTitle } from "../chatroom/titles";
import type { Database } from "../drivers/types";
import { chatKeysSetupInput, chatKeyIsStale, currentChatPublicKey } from "../e2ee/chat-keys";
import { certifiedWorkerKeys } from "../e2ee/worker-keys";
import { createInternalGatewayProvider } from "../gateway/completions";
import type { Runtime } from "../runtime";
import { workerGatewayAccess } from "../worker/gateway";
import { workerPresence } from "../worker/presence";
import { activeWorkerIds, activeWorkspaceWorkers, workerNames } from "../worker/workers";
import type { WorkspaceAccess } from "../workspaces/access";
import { projectWorkerDirectory, requireWorkspaceProject, workspaceProjectFolders } from "../workspaces/projects";
import { isWorkerOnline } from "contracts/worker/presence";
import { enabledAgentIds, findAgentDefinition } from "./agents";
import {
  accessibleSession,
  acpError,
  chatAudience,
  existingCommand,
  findAgent,
  findSession,
  insertSignedCommand,
  requireSealedBox,
  requireSignedDispatch,
  sealedWire,
  signedBindingInput,
  signedCommandInput,
  storedBinding,
  verifyImportProof,
  verifyNextBinding,
  verifySignedCommand,
  verifyUserSignature,
  type AcpSession,
  type SignedCommand,
} from "./policy";
import { acpAgentSessions, acpCommands, acpInteractions, acpSessions } from "./schema";
import { admitWarm, isWarm } from "./warm";
import { workerAgents } from "../worker/schema";

/*
 * Browser-side ACP (Convex `src/acp/browser.ts`). Every chat-scoped call goes through the one
 * Chatroom access rule (`accessibleSession`), so a member's personal ACP chat stays private from
 * the workspace owner. After the encryption cutover only the signed path exists: commands are
 * sealed to the Worker and signed by their issuer, chats are created with keys, and the creator
 * signs the chat's binding before any command. Frame reads (`LiveFrames`), viewer heartbeats
 * (`Watch`) and epoch capsules (`StreamCapsule`) move to Durable Streams in Phase 4.
 */

const idInput = z.string().min(1).max(256);

/** Sessions one agent-session page holds at most. */
const MAX_SESSION_PAGE = 100;
/** An unopened-sessions page never scans more than this many index rows, whatever it skips. */
const SESSION_PAGE_MAX_ROWS_READ = 400;
/** Workers one sync request considers. */
const MAX_SYNC_WORKERS = 200;

export const sessionCursorInput = z.object({ at: z.number(), id: idInput });
type SessionCursor = z.output<typeof sessionCursorInput>;

export const createSessionInput = z.object({
  scope: z.enum(["personal", "shared", "workspace"]).optional(),
  members: z.array(idInput).max(200).optional(),
  project: idInput.optional(),
  worker: idInput,
  agentId: z.string().max(64),
  cwd: z.string().max(4096).optional(),
  profile: acpProfileValidator.optional(),
  e2ee: z.object({ keys: chatKeysSetupInput }),
});

export const publishBindingInput = z.object({
  chat: idInput,
  binding: signedBindingInput,
  importProof: z
    .object({ signerKeyId: z.string().max(64), signature: base64urlBytes(64) })
    .optional(),
});

export const promptInput = z.object({ chat: idInput, clientId: z.string().max(256), signed: signedCommandInput });
export const signedChatCommandInput = z.object({ chat: idInput, signed: signedCommandInput });
export const cancelInput = z.object({ chat: idInput, signed: signedCommandInput.optional() });

export const answerInput = z.object({
  interaction: idInput,
  sealed: z.object({
    answer: base64urlBytes(ACP_SEALED_INTERACTION_BYTES),
    signature: base64urlBytes(64),
    signerKeyId: z.string().max(64),
  }),
});

export const requestHistoryInput = z.object({
  chat: idInput,
  epoch: z.number().int(),
  before: z.number().int(),
  signed: signedCommandInput,
});

export const forkInput = z.object({
  chat: idInput,
  e2ee: z.object({ keys: chatKeysSetupInput, members: z.array(idInput).max(200).optional() }),
});

export const startForkInput = z.object({
  chat: idInput,
  target: idInput,
  binding: signedBindingInput,
  signed: signedCommandInput,
});

export const openAgentSessionInput = z.object({
  worker: idInput,
  agentId: z.string().max(64),
  sessionId: z.string().max(256),
  e2ee: z.object({ keys: chatKeysSetupInput, sealedTitle: sealedBoxInput.optional() }),
});

export const agentCommandInput = z.object({
  worker: idInput,
  agentId: z.string().max(64),
  clientId: z.string().max(256),
  signed: signedCommandInput,
});

export const syncAgentSessionsInput = z.object({
  agentId: z.string().max(64),
  signed: z.array(signedCommandInput.extend({ worker: idInput })).max(MAX_SYNC_WORKERS),
});

// ---------------------------------------------------------------------------------------------
// Folders

/** A directory without trailing separators; the root keeps its own. */
function bareDirectory(directory: string) {
  return directory.replace(/[\\/]+$/, "") || directory;
}

/**
 * Matches an agent session's `cwd` to a Project folder on the same Worker. Agents report a
 * directory without its trailing separator while a Project folder may keep one, so neither counts.
 */
function folderKey(worker: string, directory: string) {
  return `${worker}\0${bareDirectory(directory)}`;
}

/** The `cwd` spellings an agent may index a folder under: with and without a trailing separator. */
function directorySpellings(directory: string) {
  const bare = bareDirectory(directory);
  if (/[\\/]$/.test(bare)) return [bare];
  const separator = bare.includes("\\") && !bare.includes("/") ? "\\" : "/";
  return [bare, `${bare}${separator}`];
}

/** Project of each `folderKey`; a folder in several Projects belongs to the oldest. */
async function projectFolders(db: Database, workspace: string) {
  const folders = new Map<string, string>();
  for (const folder of await workspaceProjectFolders(db, workspace)) {
    const key = folderKey(folder.worker, folder.directory);
    if (!folders.has(key)) folders.set(key, folder.project);
  }
  return folders;
}

type IndexRow = typeof acpAgentSessions.$inferSelect;

/** One agent-session index row as Home and the Agents page list it. */
export type IndexedSession = {
  id: string;
  worker: string;
  agentId: string;
  sessionId: string;
  cwd: string;
  title: string | null;
  sealedTitle: { epoch: number; box: string } | null;
  legacyContent: IndexRow["legacyContent"];
  updatedAt: number;
  chat: string | null;
  project: string | null;
};

function indexedSessionRow(row: IndexRow, project: string | null): IndexedSession {
  return {
    id: row.id,
    worker: row.worker,
    agentId: row.agentId,
    sessionId: row.sessionId,
    cwd: row.cwd,
    title: row.title,
    sealedTitle: sealedWire(row.sealedTitleEpoch, row.sealedTitleBox),
    legacyContent: row.legacyContent,
    updatedAt: row.updatedAt.getTime(),
    chat: row.chat,
    project,
  };
}

function sessionsBefore(cursor: SessionCursor | null | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const at = new Date(cursor.at);
  return or(
    lt(acpAgentSessions.updatedAt, at),
    and(eq(acpAgentSessions.updatedAt, at), lt(acpAgentSessions.id, cursor.id)),
  );
}

// ---------------------------------------------------------------------------------------------
// Creation and binding

/** Where a new session runs when the caller names no folder: the Project folder, else temp. */
async function deriveSessionDirectory(
  runtime: Runtime,
  workspace: string,
  worker: string,
  project: string | null,
) {
  const db = runtime.drivers.db;
  const folder = project ? await projectWorkerDirectory(db, workspace, project, worker) : undefined;
  if (folder) return folder;
  const presence = (await workerPresence(runtime.drivers.kv, [worker])).get(worker);
  return presence?.tempDirectory;
}

/** Refuses a Worker that is not an active Worker of `workspace`. */
async function requireActiveWorker(db: Database, workspace: string, worker: string) {
  if (!(await activeWorkspaceWorkers(db, workspace, [worker])).has(worker)) {
    acpError("ACP_AGENT_UNAVAILABLE");
  }
}

/**
 * Owner-selected immutable binding; every creation starts a new agent session on a new keyed
 * chat. The Worker must be certified (keyed workspace); the creator then signs and publishes the
 * chat's binding (`publishBinding`) before any command. `shared` chats name their `members`.
 */
export async function createSession(
  runtime: Runtime,
  access: WorkspaceAccess,
  userId: string,
  input: z.output<typeof createSessionInput>,
): Promise<string> {
  const db = runtime.drivers.db;
  const workspace = access.workspace;
  const scope = input.scope ?? "personal";
  if (scope !== "shared" && input.members?.length) acpError("ACP_INVALID_SCOPE");
  await requireActiveWorker(db, workspace.id, input.worker);
  await requireSignedDispatch(db, workspace.id, input.worker);
  if (input.project) await requireWorkspaceProject(db, input.project, workspace.id);
  const profile = input.profile ?? "native";
  if (profile === "gateway") {
    const definition = await findAgentDefinition(db, workspace.id, input.agentId);
    if (
      !definition ||
      !acpGatewayProfileOffered({
        enabled: definition.enabled,
        gateway: definition.gateway ?? undefined,
      })
    ) {
      acpError("ACP_GATEWAY_UNAVAILABLE", "This agent does not offer a Gateway profile.");
    }
    if ((await workerGatewayAccess(db, input.worker)) !== "active") {
      acpError("ACP_GATEWAY_UNAVAILABLE", "Gateway access is not active on this Worker.");
    }
  }
  const agent = await findAgent(db, input.worker, input.agentId);
  if (!agent || (agent.status !== "ready" && agent.status !== "needs_auth")) {
    acpError("ACP_AGENT_UNAVAILABLE");
  }
  const cwd =
    input.cwd ??
    (await deriveSessionDirectory(runtime, workspace.id, input.worker, input.project ?? null));
  if (!cwd || !validChatWorkerDirectory(cwd)) acpError("ACP_INVALID_CWD");
  return await db.transaction(async (tx) => {
    const chat = await createAcpChat(tx, workspace, userId, {
      scope,
      members: input.members ?? [],
      keys: input.e2ee.keys,
      project: input.project ?? null,
    });
    await tx.insert(acpSessions).values({
      chat: chat.id,
      workspace: workspace.id,
      worker: input.worker,
      agentId: input.agentId,
      agentVersion: agent.version,
      profile,
      cwd,
      status: "idle",
      history: "none",
      updatedAt: new Date(),
    });
    return chat.id;
  });
}

/**
 * The creator signs the chat's binding (`acpBindingStatement`): at creation and again with a
 * higher version on every audience change (`chats.setScope`). A session id bound without a Worker
 * proof (an imported session) needs the workspace owner's `importProof`. Serialized by the session
 * row lock, so two publishes of one version cannot both land.
 */
export async function publishBinding(
  db: Database,
  userId: string,
  input: z.output<typeof publishBindingInput>,
) {
  await db.transaction(async (tx) => {
    const { chat, session, workspace } = await accessibleSession(tx, userId, input.chat, "update");
    if (chat.userId !== userId) acpError("ACP_DENIED");
    await verifyNextBinding(tx, {
      session,
      chat,
      ...(await chatAudience(tx, chat)),
      binding: input.binding,
    });
    const patch: Partial<typeof acpSessions.$inferInsert> = {
      binding: storedBinding(input.binding),
      updatedAt: new Date(),
    };
    if (session.sessionId && !session.sessionProof) {
      if (!input.importProof) acpError("ACP_SESSION_PROOF_REQUIRED");
      await verifyImportProof(tx, { session, ownerId: workspace.ownerId, proof: input.importProof });
      patch.sessionProof = {
        kind: "import",
        signerKeyId: input.importProof.signerKeyId,
        signature: toBase64Url(input.importProof.signature),
      };
    }
    await tx.update(acpSessions).set(patch).where(eq(acpSessions.id, session.id));
  });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Commands

/** Checks a signed session-level command: the chat is bound, the issuer signed exactly this. */
async function verifySessionCommand(
  db: Database,
  input: { session: AcpSession; chat: Chat; userId: string; kind: "prompt" | "cancel" | "set_config" | "set_mode" | "history" | "fork"; signed: SignedCommand },
) {
  const { session } = input;
  await requireSignedDispatch(db, session.workspace, session.worker);
  // A paired Worker executes nothing for a chat its creator has not bound and signed.
  if (!input.chat.e2eeId || !session.binding) acpError("ACP_BINDING_REQUIRED");
  await verifySignedCommand(db, {
    workspace: session.workspace,
    worker: session.worker,
    chat: session.chat,
    kind: input.kind,
    userId: input.userId,
    signed: input.signed,
  });
}

/** A Gateway-profile session needs the Worker's Gateway key. */
async function requireGatewayKey(db: Database, session: AcpSession) {
  if (session.profile !== "gateway") return;
  const access = await workerGatewayAccess(db, session.worker);
  if (access === "active") return;
  acpError(
    "ACP_GATEWAY_KEY_MISSING",
    access === "off"
      ? "Gateway access is off on this Worker."
      : "This Worker's Gateway key was deleted. The workspace owner must issue a new key in Settings → Workers.",
  );
}

/**
 * Admits exactly one prompt at a time: `update acp_sessions set status = 'starting' … where status
 * in ('idle', 'failed') returning`, with the sealed command inserted in the same transaction. A
 * retry with the same `clientId` returns the queued command. Prompting warms the session, refused
 * once the Worker holds `ACP_WARM_SESSIONS_MAX` warm sessions.
 */
export async function prompt(
  runtime: Runtime,
  userId: string,
  input: z.output<typeof promptInput>,
): Promise<string> {
  const { db, kv } = runtime.drivers;
  if (input.signed.clientId !== input.clientId) acpError("ACP_SIGNATURE_REQUIRED");
  const { session, chat } = await accessibleSession(db, userId, input.chat);
  await requireGatewayKey(db, session);
  const existing = await existingCommand(db, session.worker, input.clientId, userId);
  if (existing) return existing.id;
  if (session.status === "ended") acpError("ACP_SESSION_ENDED");
  if (ACP_BUSY_STATUSES.includes(session.status)) acpError("ACP_SESSION_BUSY");
  await verifySessionCommand(db, { session, chat, userId, kind: "prompt", signed: input.signed });
  if (!(await admitWarm(kv, session.worker, session.chat))) {
    acpError(
      "ACP_WORKER_BUSY",
      "This Worker already has 64 open agent Sessions. Close some tabs and try again in a few minutes.",
    );
  }
  return await db.transaction(async (tx) => {
    const admitted = await tx
      .update(acpSessions)
      .set({
        status: "starting",
        turnBy: userId,
        stopReason: null,
        error: null,
        sealedErrorEpoch: null,
        sealedErrorBox: null,
        updatedAt: new Date(),
      })
      .where(and(eq(acpSessions.id, session.id), inArray(acpSessions.status, ["idle", "failed"])))
      .returning({ status: acpSessions.status });
    if (admitted.length === 0) {
      // A concurrent retry of this very prompt admitted it first.
      const retried = await existingCommand(tx, session.worker, input.clientId, userId);
      if (retried) return retried.id;
      const current = await findSession(tx, session.chat);
      acpError(current?.status === "ended" ? "ACP_SESSION_ENDED" : "ACP_SESSION_BUSY");
    }
    const command = await insertSignedCommand(tx, {
      workspace: session.workspace,
      worker: session.worker,
      issuedBy: userId,
      kind: "prompt",
      signed: input.signed,
      chat: session.chat,
    });
    await touchChat(tx, chat.id, { interruption: null });
    return command;
  });
}

/**
 * Cancels an unclaimed prompt locally (it fails with the fixed code `ACP_CANCELLED`, its payload
 * erased); otherwise queues one signed cancellation for a busy session. Under the session lock, so
 * a concurrent claim either finds the prompt failed or this sees it claimed.
 */
export async function cancel(db: Database, userId: string, input: z.output<typeof cancelInput>) {
  await db.transaction(async (tx) => {
    const { session, chat } = await accessibleSession(tx, userId, input.chat, "update");
    const [pendingPrompt] = await tx
      .update(acpCommands)
      .set({
        status: "failed",
        error: "ACP_CANCELLED",
        payload: null,
        signedPayload: null,
        signedSignature: null,
        signedSignerKeyId: null,
        finishedAt: new Date(),
      })
      .where(
        sql`${acpCommands.id} = (select ${acpCommands.id} from ${acpCommands} where ${acpCommands.chat} = ${session.chat} and ${acpCommands.status} = 'pending' and ${acpCommands.kind} = 'prompt' limit 1)`,
      )
      .returning({ id: acpCommands.id });
    if (pendingPrompt) {
      await tx
        .update(acpSessions)
        .set({ status: "idle", stopReason: "cancelled", updatedAt: new Date() })
        .where(eq(acpSessions.id, session.id));
      await touchChat(tx, chat.id, { interruption: { kind: "interrupted" } });
      return;
    }
    if (!ACP_BUSY_STATUSES.includes(session.status)) return;
    const [queued] = await tx
      .select({ id: acpCommands.id })
      .from(acpCommands)
      .where(
        and(
          eq(acpCommands.chat, session.chat),
          eq(acpCommands.status, "pending"),
          eq(acpCommands.kind, "cancel"),
        ),
      )
      .limit(1);
    if (queued) return;
    if (!input.signed) acpError("ACP_SIGNATURE_REQUIRED");
    await verifySessionCommand(tx, { session, chat, userId, kind: "cancel", signed: input.signed });
    await insertSignedCommand(tx, {
      workspace: session.workspace,
      worker: session.worker,
      issuedBy: userId,
      kind: "cancel",
      signed: input.signed,
      chat: session.chat,
    });
  });
  return null;
}

/**
 * A config or mode choice for the live agent: the choice travels only in the sealed command, so
 * the backend cannot inspect or validate it.
 */
export async function sendSessionChoice(
  db: Database,
  userId: string,
  kind: "set_config" | "set_mode",
  input: z.output<typeof signedChatCommandInput>,
) {
  const { session, chat } = await accessibleSession(db, userId, input.chat);
  if (session.status === "ended") acpError("ACP_SESSION_ENDED");
  await verifySessionCommand(db, { session, chat, userId, kind, signed: input.signed });
  await db.transaction((tx) =>
    insertSignedCommand(tx, {
      workspace: session.workspace,
      worker: session.worker,
      issuedBy: userId,
      kind,
      signed: input.signed,
      chat: session.chat,
    }),
  );
  return null;
}

/**
 * The first visible user's decision wins: `update … set status = 'answered' where status =
 * 'pending' returning`. The answer is sealed to the Worker; the backend checks only that the caller
 * signed it, and the Worker re-opens the interaction when the answer is not valid.
 */
export async function answer(db: Database, userId: string, input: z.output<typeof answerInput>) {
  const [row] = await db
    .select()
    .from(acpInteractions)
    .where(eq(acpInteractions.id, input.interaction));
  if (!row) acpError("ACP_INTERACTION_CLOSED");
  await accessibleSession(db, userId, row.chat);
  if (row.status !== "pending") acpError("ACP_INTERACTION_CLOSED");
  if (!row.sealedRequestBox) acpError("ACP_E2EE_MODE");
  requireSealedBox(input.sealed.answer, ACP_SEALED_INTERACTION_BYTES);
  await verifyUserSignature(db, {
    userId,
    signerKeyId: input.sealed.signerKeyId,
    signature: input.sealed.signature,
    message: acpAnswerStatement({
      workspaceId: row.workspace,
      workerId: row.worker,
      chatId: row.chat,
      requestKey: row.requestKey,
      answer: input.sealed.answer,
    }),
  });
  const answered = await db
    .update(acpInteractions)
    .set({
      status: "answered",
      sealedAnswer: input.sealed.answer,
      sealedAnswerSignature: input.sealed.signature,
      sealedAnswerSignerKeyId: input.sealed.signerKeyId,
      answeredBy: userId,
      answeredAt: new Date(),
    })
    .where(and(eq(acpInteractions.id, row.id), eq(acpInteractions.status, "pending")))
    .returning({ id: acpInteractions.id });
  if (answered.length === 0) acpError("ACP_INTERACTION_CLOSED");
  return null;
}

/**
 * Asks the Worker for one history page of the warm epoch. Duplicate requests share an unfinished
 * command (checked under the session lock); a retry after it finished asks again. The signed
 * clientId must start with the page key `history:${chat}:${epoch}:${before}:`.
 */
export async function requestHistory(
  runtime: Runtime,
  userId: string,
  input: z.output<typeof requestHistoryInput>,
) {
  const { db, kv } = runtime.drivers;
  const page = `history:${input.chat}:${input.epoch}:${input.before}`;
  await db.transaction(async (tx) => {
    const { session, chat } = await accessibleSession(tx, userId, input.chat, "update");
    if (!input.signed.clientId.startsWith(`${page}:`)) acpError("ACP_INVALID_CLIENT_ID");
    if (input.epoch !== session.epoch || !(await isWarm(kv, session.worker, session.chat))) return;
    const [active] = await tx
      .select({ id: acpCommands.id })
      .from(acpCommands)
      .where(
        and(
          eq(acpCommands.chat, session.chat),
          inArray(acpCommands.status, ["pending", "claimed"]),
          eq(acpCommands.kind, "history"),
          sql`starts_with(${acpCommands.clientId}, ${`${page}:`})`,
        ),
      )
      .limit(1);
    if (active) return;
    await verifySessionCommand(tx, { session, chat, userId, kind: "history", signed: input.signed });
    await insertSignedCommand(tx, {
      workspace: session.workspace,
      worker: session.worker,
      issuedBy: userId,
      kind: "history",
      signed: input.signed,
      chat: session.chat,
    });
  });
  return null;
}

/**
 * First step of a fork: creates the target chat (owned by the caller, same scope, Project and
 * binding as the source) with its keys and a `starting` session. `startFork` then publishes the
 * target's binding and queues the signed command, whose statement names the source chat.
 */
export async function fork(runtime: Runtime, userId: string, input: z.output<typeof forkInput>) {
  const db = runtime.drivers.db;
  const { session, chat, workspace } = await accessibleSession(db, userId, input.chat);
  await requireSignedDispatch(db, session.workspace, session.worker);
  const report = await findAgent(db, session.worker, session.agentId);
  if (!report?.capabilities.fork || !session.sessionId) acpError("ACP_UNSUPPORTED");
  if (ACP_BUSY_STATUSES.includes(session.status)) acpError("ACP_SESSION_BUSY");
  if (!session.binding) acpError("ACP_BINDING_REQUIRED");
  if (chat.scope !== "shared" && input.e2ee.members?.length) acpError("ACP_INVALID_SCOPE");
  return await db.transaction(async (tx) => {
    const target = await createAcpChat(tx, workspace, userId, {
      scope: chat.scope,
      members: input.e2ee.members ?? [],
      keys: input.e2ee.keys,
      project: chat.project,
    });
    await tx.insert(acpSessions).values({
      chat: target.id,
      workspace: session.workspace,
      worker: session.worker,
      agentId: session.agentId,
      agentVersion: session.agentVersion,
      profile: session.profile,
      cwd: session.cwd,
      status: "starting",
      history: "none",
      updatedAt: new Date(),
    });
    return target.id;
  });
}

/**
 * Second step of a fork: the target's creator publishes its binding (version 1) and queues the
 * signed `fork` command on the source chat; its receipt (`result`) names the target, so Worker
 * recovery finds it once the payload is gone. Retrying with the same command is a no-op.
 */
export async function startFork(
  db: Database,
  userId: string,
  input: z.output<typeof startForkInput>,
) {
  await db.transaction(async (tx) => {
    const source = await accessibleSession(tx, userId, input.chat);
    if (await existingCommand(tx, source.session.worker, input.signed.clientId, userId)) return;
    const target = await accessibleSession(tx, userId, input.target, "update");
    if (
      target.chat.userId !== userId ||
      target.session.sessionId ||
      target.session.binding ||
      target.session.worker !== source.session.worker ||
      target.session.workspace !== source.session.workspace ||
      !source.session.sessionId ||
      !source.session.binding
    )
      acpError("ACP_INVALID_BINDING");
    await verifyNextBinding(tx, {
      session: target.session,
      chat: target.chat,
      ...(await chatAudience(tx, target.chat)),
      binding: input.binding,
    });
    await tx
      .update(acpSessions)
      .set({ binding: storedBinding(input.binding), updatedAt: new Date() })
      .where(eq(acpSessions.id, target.session.id));
    await verifySessionCommand(tx, {
      session: source.session,
      chat: source.chat,
      userId,
      kind: "fork",
      signed: input.signed,
    });
    await insertSignedCommand(tx, {
      workspace: source.session.workspace,
      worker: source.session.worker,
      issuedBy: userId,
      kind: "fork",
      signed: input.signed,
      chat: source.session.chat,
      result: target.chat.id,
    });
  });
  return null;
}

/**
 * Fallback title of an ACP chat, derived and sealed by the browser from the first prompt (the
 * server never sees the prompt). Ignored once the chat has any title or the user renamed it.
 */
export async function setFallbackTitle(
  db: Database,
  userId: string,
  input: { chat: string; sealedTitle: z.output<typeof sealedBoxInput> },
) {
  await db.transaction(async (tx) => {
    const { chat, session, workspace } = await accessibleSession(tx, userId, input.chat, "update");
    // A stale epoch (revoked reader or rotated workspace key) must be replaced before new sealing.
    if (!chat.e2eeId || !chat.keyEpoch || (await chatKeyIsStale(tx, chat, workspace)))
      acpError("ACP_E2EE_MODE");
    if (chat.sealedTitleBox || chat.title || chat.legacyContent || session.userTitled) return;
    validateChatBox(input.sealedTitle, chat.keyEpoch, MAX_TITLE_BOX_BYTES);
    await saveSealedTitle(tx, chat, input.sealedTitle);
  });
  return null;
}

/**
 * Generates a fallback title from the first prompt in this call only and stores it sealed to the
 * chat's current key; the prompt is never stored or logged. Skipped for titled or user-titled
 * chats; a title that arrives meanwhile (agent or rename) wins.
 */
export async function generateTitle(
  runtime: Runtime,
  userId: string,
  input: { chat: string; text: string },
) {
  const db = runtime.drivers.db;
  const text = input.text.trim().slice(0, 4000);
  const { chat, session, workspace } = await accessibleSession(db, userId, input.chat);
  if (!text || chat.title || chat.sealedTitleBox || session.userTitled || !chat.e2eeId) return null;
  const target = await currentChatPublicKey(db, chat, workspace);
  const model = await titleModelFor(db, workspace.id);
  if (!target || !model) return null;
  try {
    const provider = createInternalGatewayProvider(runtime, workspace.id, {}, {
      actor: userId,
      chatId: chat.id,
    });
    const title = await generateChatTitle({ model: provider(model), initialUserMessage: text });
    const sealedTitle = await sealChatTitle(
      { workspace: workspace.id, e2eeId: chat.e2eeId, ...target },
      title,
    );
    await db.transaction(async (tx) => {
      const current = await accessibleSession(tx, userId, chat.id, "update");
      if (
        current.chat.title ||
        current.chat.sealedTitleBox ||
        current.session.userTitled ||
        current.chat.keyEpoch !== sealedTitle.epoch
      )
        return;
      await saveSealedTitle(tx, current.chat, sealedTitle);
    });
  } catch {
    // Provider errors can contain request or response bodies, so never log the error itself.
    console.error("Failed to generate ACP chat title.");
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Agent sessions index

/**
 * One page of an agent's indexed sessions, newest first, without contacting the Worker. Index
 * rows linked to a chat the caller cannot see (another member's personal chat) are hidden.
 */
export async function listAgentSessionIndex(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  input: { agentId: string; cursor?: SessionCursor | null; limit: number },
) {
  const workspace = access.workspace.id;
  const limit = Math.min(input.limit, MAX_SESSION_PAGE);
  const rows = await db
    .select()
    .from(acpAgentSessions)
    .where(
      and(
        eq(acpAgentSessions.workspace, workspace),
        eq(acpAgentSessions.agentId, input.agentId),
        sessionsBefore(input.cursor),
      ),
    )
    .orderBy(desc(acpAgentSessions.updatedAt), desc(acpAgentSessions.id))
    .limit(limit);
  const linked = rows.flatMap((row) => (row.chat ? [row.chat] : []));
  const visible = await visibleWorkspaceChats(db, userId, workspace, linked);
  const folders = await projectFolders(db, workspace);
  const last = rows.at(-1);
  return {
    page: rows
      .filter((row) => !row.chat || visible.has(row.chat))
      .map((row) => indexedSessionRow(row, folders.get(folderKey(row.worker, row.cwd)) ?? null)),
    nextCursor:
      rows.length === limit && last ? { at: last.updatedAt.getTime(), id: last.id } : null,
  };
}

/**
 * One page of the agent sessions Radium has not opened yet, newest first, for Home. `project`
 * narrows to sessions in that Project's folders (a folder shared by several Projects belongs to
 * the oldest), `null` to sessions outside every Project folder. Only enabled agents' sessions are
 * listed. A page reads at most 400 index rows; `nextCursor` continues after the last row read.
 */
export async function listUnopenedAgentSessions(
  db: Database,
  access: WorkspaceAccess,
  input: { project?: string | null; cursor?: SessionCursor | null; limit: number },
) {
  const workspace = access.workspace.id;
  const none = { page: [], nextCursor: null };
  let projectId: string | null = null;
  if (input.project) {
    try {
      projectId = (await requireWorkspaceProject(db, input.project, workspace)).id;
    } catch {
      // A Project deleted while a list is open has no sessions left.
      return none;
    }
  }
  const enabled = await enabledAgentIds(db, workspace);
  if (enabled.length === 0) return none;
  const folders = await projectFolders(db, workspace);
  let scopeFilter: SQL | undefined;
  if (projectId) {
    const owned = (await workspaceProjectFolders(db, workspace)).filter(
      (folder) => folders.get(folderKey(folder.worker, folder.directory)) === projectId,
    );
    const pairs = owned.flatMap((folder) =>
      directorySpellings(folder.directory).map((cwd) =>
        and(eq(acpAgentSessions.worker, folder.worker), eq(acpAgentSessions.cwd, cwd)),
      ),
    );
    if (pairs.length === 0) return none;
    scopeFilter = or(...pairs);
  }
  const limit = Math.min(input.limit, MAX_SESSION_PAGE);
  const page: IndexedSession[] = [];
  let cursor = input.cursor ?? null;
  let read = 0;
  for (;;) {
    const want = Math.min(limit, SESSION_PAGE_MAX_ROWS_READ - read);
    const batch = await db
      .select()
      .from(acpAgentSessions)
      .where(
        and(
          eq(acpAgentSessions.workspace, workspace),
          isNull(acpAgentSessions.chat),
          inArray(acpAgentSessions.agentId, enabled),
          scopeFilter,
          sessionsBefore(cursor),
        ),
      )
      .orderBy(desc(acpAgentSessions.updatedAt), desc(acpAgentSessions.id))
      .limit(want);
    for (const row of batch) {
      read += 1;
      cursor = { at: row.updatedAt.getTime(), id: row.id };
      const project = folders.get(folderKey(row.worker, row.cwd)) ?? null;
      if (input.project === null && project !== null) continue;
      page.push(indexedSessionRow(row, project));
      if (page.length === limit) return { page, nextCursor: cursor };
    }
    // Fewer rows than asked for: the index has no more.
    if (batch.length < want) return { page, nextCursor: null };
    if (read >= SESSION_PAGE_MAX_ROWS_READ) return { page, nextCursor: cursor };
  }
}

/**
 * Asks each online, certified Worker with a ready, list-capable `agentId` to refresh its session
 * index, at most once a minute and never twice while one is queued or running (checked under a
 * per-Worker-and-agent lock). Each Worker needs its own owner-signed `sync_sessions` command.
 */
export async function syncAgentSessions(
  runtime: Runtime,
  access: WorkspaceAccess,
  userId: string,
  input: z.output<typeof syncAgentSessionsInput>,
) {
  const { db, kv } = runtime.drivers;
  const workspace = access.workspace.id;
  if (!validAcpAgentId(input.agentId)) acpError("ACP_INVALID_AGENT");
  const workers = await activeWorkerIds(db, workspace, MAX_SYNC_WORKERS);
  if (workers.length === 0) return null;
  const agents = await db
    .select()
    .from(workerAgents)
    .where(and(inArray(workerAgents.worker, workers), eq(workerAgents.agentId, input.agentId)));
  const presence = await workerPresence(kv, agents.map((agent) => agent.worker));
  const now = Date.now();
  for (const agent of agents) {
    if (agent.status !== "ready" || !agent.capabilities.list) continue;
    const sync = agent.sessionsSync;
    if (sync && sync.status !== "failed" && now - sync.at < 60_000) continue;
    if (!isWorkerOnline(presence.get(agent.worker)?.lastSeenAt, now)) continue;
    const entry = input.signed.find((signed) => signed.worker === agent.worker);
    if (!entry) continue;
    if (!(await certifiedWorkerKeys(db, workspace, agent.worker))) continue;
    const { worker: _, ...signed } = entry;
    await verifySignedCommand(db, {
      workspace,
      worker: agent.worker,
      chat: "",
      kind: "sync_sessions",
      userId,
      signed,
    });
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`acp_sync:${agent.worker}:${input.agentId}`}, 0))`,
      );
      const [queued] = await tx
        .select({ id: acpCommands.id })
        .from(acpCommands)
        .where(
          and(
            eq(acpCommands.worker, agent.worker),
            inArray(acpCommands.status, ["pending", "claimed"]),
            eq(acpCommands.kind, "sync_sessions"),
            eq(acpCommands.agentId, input.agentId),
          ),
        )
        .limit(1);
      if (queued) return;
      await insertSignedCommand(tx, {
        workspace,
        worker: agent.worker,
        issuedBy: userId,
        kind: "sync_sessions",
        signed,
        agentId: input.agentId,
      });
    });
  }
  return null;
}

/**
 * Opens an indexed agent session as a personal keyed chat, even while the Worker is offline; the
 * binding reopens when it reconnects. The owner's browser creates the chat keys and seals the
 * decrypted index title to them, then publishes the binding with its import proof. Under the index
 * row lock, so concurrent opens return one chat.
 */
export async function openAgentSession(
  runtime: Runtime,
  access: WorkspaceAccess,
  userId: string,
  input: z.output<typeof openAgentSessionInput>,
): Promise<string> {
  const db = runtime.drivers.db;
  const workspace = access.workspace;
  await requireActiveWorker(db, workspace.id, input.worker);
  await requireSignedDispatch(db, workspace.id, input.worker);
  const agent = await findAgent(db, input.worker, input.agentId);
  // No report: the Worker has not launched the agent (for a paired Worker, often an unreviewed
  // definition), which is not the same as an agent that cannot reopen sessions.
  if (!agent) acpError("ACP_AGENT_UNAVAILABLE");
  if (!(agent.capabilities.loadSession || agent.capabilities.resume)) acpError("ACP_UNSUPPORTED");
  const folders = await projectFolders(db, workspace.id);
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(acpAgentSessions)
      .where(
        and(
          eq(acpAgentSessions.workspace, workspace.id),
          eq(acpAgentSessions.worker, input.worker),
          eq(acpAgentSessions.agentId, input.agentId),
          eq(acpAgentSessions.sessionId, input.sessionId),
        ),
      )
      .for("update");
    if (!row) acpError("ACP_SESSION_NOT_FOUND");
    if (row.chat) return row.chat;
    const [bound] = await tx
      .select({ id: acpSessions.id })
      .from(acpSessions)
      .where(
        and(
          eq(acpSessions.worker, input.worker),
          eq(acpSessions.agentId, input.agentId),
          eq(acpSessions.sessionId, input.sessionId),
        ),
      );
    if (bound) acpError("ACP_SESSION_BOUND");
    const chat = await createAcpChat(tx, workspace, userId, {
      scope: "personal",
      members: [],
      keys: input.e2ee.keys,
      project: folders.get(folderKey(row.worker, row.cwd)) ?? null,
      sealedTitle: input.e2ee.sealedTitle,
      lastInteractionAt: row.updatedAt,
    });
    await tx.insert(acpSessions).values({
      chat: chat.id,
      workspace: workspace.id,
      worker: input.worker,
      agentId: input.agentId,
      agentVersion: agent.version,
      profile: "native",
      cwd: row.cwd,
      sessionId: input.sessionId,
      status: "idle",
      history: "none",
      updatedAt: new Date(),
    });
    await tx.update(acpAgentSessions).set({ chat: chat.id }).where(eq(acpAgentSessions.id, row.id));
    return chat.id;
  });
}

/**
 * Queues an owner-only agent-level command (`authenticate` with an agent-managed method, or
 * `logout` when the agent supports it), signed with statement chat `""`.
 */
export async function agentCommand(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  kind: "authenticate" | "logout",
  input: z.output<typeof agentCommandInput> & { methodId?: string },
): Promise<string> {
  const workspace = access.workspace.id;
  if (input.signed.clientId !== input.clientId) acpError("ACP_SIGNATURE_REQUIRED");
  await requireActiveWorker(db, workspace, input.worker);
  const agent = await findAgent(db, input.worker, input.agentId);
  const supported =
    kind === "authenticate"
      ? agent?.authMethods.some((method) => method.id === input.methodId && method.type === "agent")
      : agent?.capabilities.logout;
  if (!supported) acpError("ACP_UNSUPPORTED");
  await requireSignedDispatch(db, workspace, input.worker);
  await verifySignedCommand(db, {
    workspace,
    worker: input.worker,
    chat: "",
    kind,
    userId,
    signed: input.signed,
  });
  return await db.transaction((tx) =>
    insertSignedCommand(tx, {
      workspace,
      worker: input.worker,
      issuedBy: userId,
      kind,
      signed: input.signed,
      agentId: input.agentId,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Reads

/** A transient command result, visible only to its issuer while they can still see the workspace. */
export async function getCommand(db: Database, userId: string, commandId: string) {
  const [command] = await db.select().from(acpCommands).where(eq(acpCommands.id, commandId));
  if (!command || command.issuedBy !== userId) return null;
  return {
    id: command.id,
    kind: command.kind,
    status: command.status,
    error: command.error,
    result: command.result,
    workspace: command.workspace,
    chat: command.chat,
  };
}

/**
 * Quiet session metadata for a Session Tab. Before the agent session exists, `defaultConfig` and
 * `commands` come from the agent's last advertised defaults. `binding` is the published audience
 * (null: the creator must publish one first); `sealedError` replaces the generic `error` text.
 */
export async function getSession(runtime: Runtime, userId: string, chatId: string) {
  const { db, kv } = runtime.drivers;
  const { session, chat } = await accessibleSession(db, userId, chatId);
  const [report, warm, gateway] = await Promise.all([
    findAgent(db, session.worker, session.agentId),
    isWarm(kv, session.worker, session.chat),
    session.profile === "gateway" ? workerGatewayAccess(db, session.worker) : null,
  ]);
  return {
    agent: {
      worker: session.worker,
      agentId: session.agentId,
      agentVersion: session.agentVersion,
      profile: session.profile,
      cwd: session.cwd,
      sessionId: session.sessionId,
    },
    id: session.id,
    legacyContent: session.legacyContent,
    workspace: session.workspace,
    profile: session.profile,
    gateway: gateway === null ? null : { access: gateway },
    agentName: report?.name ?? null,
    agentIcon: report?.icon ?? null,
    capabilities: report?.capabilities ?? null,
    status: session.status,
    epoch: session.epoch,
    warm,
    stopReason: session.stopReason,
    error: session.error,
    sealedError: sealedWire(session.sealedErrorEpoch, session.sealedErrorBox),
    signed: true,
    e2eeId: chat.e2eeId,
    binding: session.binding
      ? {
          version: session.binding.version,
          scope: session.binding.scope,
          members: session.binding.members,
        }
      : null,
    config: session.config,
    // Native process defaults cannot describe the Gateway process's model choices.
    defaultConfig: session.profile !== "gateway" ? (report?.defaults?.config ?? null) : null,
    commands: session.commands ?? (session.sessionId ? null : (report?.defaults?.commands ?? null)),
    usage: session.usage,
    turnUsage: session.turnUsage,
    history: session.history,
    draft: session.draft,
  };
}

/** The bound Worker's name (while active) and last heartbeat, for a visible Session. */
export async function workerStatus(runtime: Runtime, userId: string, chatId: string) {
  const { db, kv } = runtime.drivers;
  const { session } = await accessibleSession(db, userId, chatId);
  const [active, names, presence] = await Promise.all([
    activeWorkspaceWorkers(db, session.workspace, [session.worker]),
    workerNames(db, session.workspace, [session.worker]),
    workerPresence(kv, [session.worker]),
  ]);
  return {
    name: active.has(session.worker) ? (names.get(session.worker) ?? null) : null,
    lastSeenAt: presence.get(session.worker)?.lastSeenAt ?? null,
  };
}

/**
 * Pending requests and durable, not-yet-relayed answers of a chat, oldest first: the
 * Worker-sealed, Worker-signed request, which clients verify against the roster first.
 */
export async function openInteractions(db: Database, userId: string, chatId: string) {
  await accessibleSession(db, userId, chatId);
  const rows = await db
    .select()
    .from(acpInteractions)
    .where(and(eq(acpInteractions.chat, chatId), inArray(acpInteractions.status, ["pending", "answered"])))
    .orderBy(acpInteractions.createdAt, acpInteractions.id)
    .limit(64);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    requestKey: row.requestKey,
    request: row.request,
    sealed:
      row.sealedRequestEpoch !== null && row.sealedRequestBox && row.sealedRequestSignature
        ? {
            epoch: row.sealedRequestEpoch,
            box: toBase64Url(row.sealedRequestBox),
            signature: toBase64Url(row.sealedRequestSignature),
          }
        : null,
    status: row.status,
    createdAt: row.createdAt.getTime(),
  }));
}

/** The agent catalog of the workspace's Workers (or one of them), for the Run target picker. */
export async function listAgents(
  db: Database,
  access: WorkspaceAccess,
  input: { worker?: string },
) {
  const workspace = access.workspace.id;
  const workers =
    input.worker === undefined
      ? await activeWorkerIds(db, workspace, MAX_SYNC_WORKERS)
      : [...(await activeWorkspaceWorkers(db, workspace, [input.worker]))];
  if (workers.length === 0) return [];
  const rows = await db
    .select()
    .from(workerAgents)
    .where(inArray(workerAgents.worker, workers))
    .orderBy(workerAgents.worker, workerAgents.agentId)
    .limit(256);
  return rows.map((row) => ({
    id: row.id,
    worker: row.worker,
    agentId: row.agentId,
    name: row.name,
    version: row.version,
    icon: row.icon,
    source: row.source,
    status: row.status,
    error: row.error,
    capabilities: row.capabilities,
    authMethods: row.authMethods,
    defaults: row.defaults,
    sessionsSync: row.sessionsSync,
    checkedAt: row.checkedAt.getTime(),
  }));
}
