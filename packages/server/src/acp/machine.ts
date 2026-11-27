import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { CAPSULE_BYTES, toBase64Url } from "radium-crypto";
import { z } from "zod";
import {
  ACP_AGENT_DEFINITIONS_MAX,
  ACP_SUPERSEDED_EPOCH_MS,
  ACP_AGENT_SESSIONS_MAX,
  ACP_AGENT_SESSIONS_SYNC_CHUNK,
  ACP_SEALED_INTERACTION_BYTES,
  ACP_SEALED_SHORT_BYTES,
  acpAgentReportValidator,
  acpHistoryValidator,
  acpSessionStatusValidator,
  acpStopReasonValidator,
  acpTurnReportValidator,
  acpTurnUsageValidator,
  acpUsageValidator,
  validAcpAgentId,
  validAcpToken,
  type AcpAgentReport,
} from "contracts/acp/contract";
import { validChatWorkerDirectory } from "contracts/worker/chat-config";
import { base64urlBytes } from "contracts/wire";
import { chatWithWorkspace } from "../chatroom/access";
import type { Database } from "../drivers/types";
import { chatKeyAt, chatKeyIsStale } from "../e2ee/chat-keys";
import { dispatchJobs, enqueueJob } from "../jobs/outbox";
import { notify } from "../notifications/notify";
import type { Runtime } from "../runtime";
import { STREAMS_DELETE_JOB } from "../streams/deletion";
import type { WorkerScope } from "../worker/auth";
import { workerAgents } from "../worker/schema";
import { applySessionPatch, chatE2ee, type SessionPatch } from "./lifecycle";
import { epochStreamPath, forgetEpochFence, writeEpochCapsule } from "./live";
import {
  acpError,
  checkWorker,
  findAgent,
  findSession,
  isWorkerErrorCode,
  machineSession,
  requireSealedBox,
  sealedShortInput,
  sealedWire,
  type AcpSession,
} from "./policy";
import { acpAgentSessions, acpCommands, acpInteractions, acpSessions } from "./schema";
import { isWarm, warmChats } from "./warm";

/*
 * Machine-side ACP (Convex `src/acp/machine.ts`): what the bound Worker reads and writes, scoped
 * by its verified identity (`workerProcedure`). Frames go to the epoch streams (`./live.ts`)
 * through `POST /api/streams/…`; the durable state that fences them lives here.
 */

/** Commands, interactions and sessions one recovery pass handles per kind. */
const RECOVERY_BATCH = 100;
/** Pending commands one queue read returns (oldest first). */
const QUEUE_PAGE = 16;
/** Answered interactions one read returns. */
const ANSWERS_PAGE = 32;

// ---------------------------------------------------------------------------------------------
// Inputs

/** A JSON value small enough to store: refuses oversized contract objects before any work. */
const bounded = <T extends z.ZodType>(schema: T, maxBytes: number) =>
  schema.refine((value) => JSON.stringify(value).length <= maxBytes, "Too large");

export const finishCommandInput = z.object({
  command: z.string().min(1).max(256),
  status: z.enum(["done", "failed"]),
  error: z.string().max(500).optional(),
});

export const openInteractionInput = z.object({
  chat: z.string().min(1).max(256),
  requestKey: z.string().min(1).max(256),
  sealed: z.object({
    kind: z.enum(["permission", "elicitation"]),
    epoch: z.number().int(),
    box: base64urlBytes(ACP_SEALED_INTERACTION_BYTES),
    signature: base64urlBytes(64),
  }),
});

export const startEpochInput = z.object({
  chat: z.string().min(1).max(256),
  epoch: z.number().int(),
  capsule: z.object({
    chatEpoch: z.number().int(),
    capsule: base64urlBytes(CAPSULE_BYTES),
    signature: base64urlBytes(64),
  }),
});

export const updateSessionInput = z.object({
  chat: z.string().min(1).max(256),
  patch: z.object({
    status: acpSessionStatusValidator.optional(),
    stopReason: acpStopReasonValidator.optional(),
    error: z.null().optional(),
    usage: bounded(acpUsageValidator, 1024).optional(),
    turnUsage: bounded(acpTurnUsageValidator, 1024).optional(),
    history: acpHistoryValidator.optional(),
    sessionId: z.string().max(256).optional(),
    sealedTitle: sealedShortInput.optional(),
    sealedError: sealedShortInput.nullable().optional(),
    indexTitle: sealedShortInput.extend({ tag: z.string().max(64) }).optional(),
    sessionProof: base64urlBytes(64).optional(),
    turn: bounded(acpTurnReportValidator, 4096).optional(),
  }),
});

export const reportAgentsInput = z.object({
  agents: z
    .array(bounded(acpAgentReportValidator, 64 * 1024))
    .max(ACP_AGENT_DEFINITIONS_MAX),
});

const agentSessionEntryInput = z.object({
  sessionId: z.string().max(256),
  cwd: z.string().max(4096),
  sealedTitle: z
    .object({ epoch: z.number().int(), box: base64urlBytes(ACP_SEALED_SHORT_BYTES) })
    .optional(),
  titleTag: z.string().max(64).optional(),
  updatedAt: z.number(),
});

export const syncAgentSessionsInput = z.object({
  agentId: z.string().max(64),
  upserts: z.array(agentSessionEntryInput).max(ACP_AGENT_SESSIONS_SYNC_CHUNK),
  removals: z.array(z.string().max(256)).max(ACP_AGENT_SESSIONS_SYNC_CHUNK),
  start: z.boolean().optional(),
  finish: z
    .union([
      z.object({ count: z.number().int(), truncated: z.boolean() }),
      z.object({ error: z.string().max(64) }),
    ])
    .optional(),
});

// ---------------------------------------------------------------------------------------------
// Commands

/** This Worker's pending commands, oldest first, without payloads. */
export async function assignedCommands(db: Database, scope: WorkerScope) {
  const rows = await db
    .select({
      id: acpCommands.id,
      kind: acpCommands.kind,
      chat: acpCommands.chat,
      createdAt: acpCommands.createdAt,
    })
    .from(acpCommands)
    .where(and(eq(acpCommands.worker, scope.workerId), eq(acpCommands.status, "pending")))
    .orderBy(asc(acpCommands.createdAt), asc(acpCommands.id))
    .limit(QUEUE_PAGE);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() }));
}

/** The session facts a claimed command carries, with the E2EE facts the Worker verifies. */
async function sessionFacts(db: Database, kv: Runtime["drivers"]["kv"], session: AcpSession) {
  const found = await chatWithWorkspace(db, session.chat);
  return {
    agentId: session.agentId,
    profile: session.profile,
    cwd: session.cwd,
    sessionId: session.sessionId,
    status: session.status,
    epoch: session.epoch,
    warm: await isWarm(kv, session.worker, session.chat),
    draft: session.draft,
    config: session.config,
    e2ee: found ? await chatE2ee(db, session, found.chat, found.workspace) : null,
  };
}

/**
 * Claims a pending command once and erases its payload in the claiming statement: the update is
 * conditional on `status = 'pending'`, so of two concurrent claims exactly one gets a row back and
 * only that one returns the payload it read. Signed payloads go to the Worker with the session's
 * binding facts, so it authorizes the signer itself. `null` for unknown or already claimed ones.
 */
export async function claimCommand(runtime: Runtime, scope: WorkerScope, commandId: string) {
  const { db, kv } = runtime.drivers;
  const [row] = await db.select().from(acpCommands).where(eq(acpCommands.id, commandId));
  if (!row) return null;
  checkWorker(scope, row);
  if (row.status !== "pending") return null;
  const claimed = await db
    .update(acpCommands)
    .set({
      status: "claimed",
      claimedAt: new Date(),
      payload: null,
      signedPayload: null,
      signedSignature: null,
      signedSignerKeyId: null,
    })
    .where(
      and(
        eq(acpCommands.id, row.id),
        eq(acpCommands.worker, scope.workerId),
        eq(acpCommands.status, "pending"),
      ),
    )
    .returning({ id: acpCommands.id });
  if (claimed.length === 0) return null;

  const session = row.chat ? await findSession(db, row.chat) : undefined;
  if (session) checkWorker(scope, session);
  // A signed fork names its target only inside the sealed payload; the Worker checks that the
  // target is this receipt's chat and verifies its binding before binding the forked session.
  const forkTarget =
    row.kind === "fork" && row.result ? await findSession(db, row.result) : undefined;
  if (forkTarget) checkWorker(scope, forkTarget);
  const forkChat = forkTarget ? await chatWithWorkspace(db, forkTarget.chat) : null;
  return {
    command: row.id,
    kind: row.kind,
    clientId: row.clientId,
    payload: row.payload,
    signed:
      row.signedPayload && row.signedSignature && row.signedSignerKeyId
        ? {
            clientId: row.clientId,
            payload: toBase64Url(row.signedPayload),
            signature: toBase64Url(row.signedSignature),
            signerKeyId: row.signedSignerKeyId,
          }
        : null,
    target: row.target,
    chat: row.chat,
    by: row.issuedBy,
    session: session ? await sessionFacts(db, kv, session) : null,
    forkTarget:
      forkTarget && forkChat
        ? {
            chat: forkTarget.chat,
            agentId: forkTarget.agentId,
            profile: forkTarget.profile,
            cwd: forkTarget.cwd,
            e2ee: await chatE2ee(db, forkTarget, forkChat.chat, forkChat.workspace),
          }
        : null,
  };
}

/**
 * Terminal receipt of a claimed command; repeating it is harmless. A paired Worker reports only
 * `ACP_WORKER_ERROR_CODES` and no result, so no free text reaches the backend.
 */
export async function finishCommand(
  db: Database,
  scope: WorkerScope,
  input: z.output<typeof finishCommandInput>,
) {
  const [row] = await db.select().from(acpCommands).where(eq(acpCommands.id, input.command));
  if (!row) return null;
  checkWorker(scope, row);
  if (row.status === input.status) return null;
  if (row.status !== "claimed") acpError("ACP_COMMAND_CLOSED");
  if (input.error !== undefined && !isWorkerErrorCode(input.error)) {
    acpError("ACP_PLAINTEXT_REFUSED");
  }
  const updated = await db
    .update(acpCommands)
    .set({ status: input.status, error: input.error ?? null, finishedAt: new Date() })
    .where(and(eq(acpCommands.id, row.id), eq(acpCommands.status, "claimed")))
    .returning({ status: acpCommands.status });
  if (updated.length === 0) {
    const [current] = await db
      .select({ status: acpCommands.status })
      .from(acpCommands)
      .where(eq(acpCommands.id, row.id));
    if (current?.status !== input.status) acpError("ACP_COMMAND_CLOSED");
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sessions

/** This Worker's warm sessions (the Valkey warm set, at most the cap), with their E2EE facts. */
export async function warmSessions(runtime: Runtime, scope: WorkerScope) {
  const { db, kv } = runtime.drivers;
  const chats = await warmChats(kv, scope.workerId);
  if (chats.length === 0) return [];
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.worker, scope.workerId), inArray(acpSessions.chat, chats)));
  return await Promise.all(
    rows.map(async (row) => {
      const found = await chatWithWorkspace(db, row.chat);
      return {
        chat: row.chat,
        epoch: row.epoch,
        agentId: row.agentId,
        profile: row.profile,
        cwd: row.cwd,
        sessionId: row.sessionId,
        status: row.status,
        e2ee: found ? await chatE2ee(db, row, found.chat, found.workspace) : null,
      };
    }),
  );
}

/**
 * Advances the chat's stream epoch and opens its stream `c/<chat>/acp/<epoch>` with the
 * Worker-signed capsule of the current chat key as its first message (`./live.ts`). Under the
 * session row lock the new epoch must be above the current one and above any cooled epoch, so
 * concurrent or stale starts can never move it backwards, and the session must be warm (a cold
 * one is refused with `accepted: false`). Retrying the current epoch is accepted with the same
 * capsule bytes only (`ACP_FRAME_CONFLICT` otherwise). The superseded epoch's stream is deleted
 * `ACP_SUPERSEDED_EPOCH_MS` later, so its readers can move on first.
 */
export async function startEpoch(
  runtime: Runtime,
  scope: WorkerScope,
  input: z.output<typeof startEpochInput>,
) {
  const { db, kv } = runtime.drivers;
  const session = await machineSession(db, scope, input.chat);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) acpError("ACP_STALE_EPOCH");
  const found = await chatWithWorkspace(db, input.chat);
  if (
    !found?.chat.keyEpoch ||
    input.capsule.chatEpoch !== found.chat.keyEpoch ||
    input.capsule.capsule.byteLength !== CAPSULE_BYTES ||
    input.capsule.signature.byteLength !== 64 ||
    // A stale epoch (revoked reader or rotated workspace key) must rotate before new frames.
    (await chatKeyIsStale(db, found.chat, found.workspace))
  )
    acpError("ACP_INVALID_SEALED");
  const current = (row: AcpSession) => input.epoch === row.epoch && input.epoch > (row.cooledEpoch ?? 0);
  if (!current(session)) {
    const started = await db.transaction(async (tx) => {
      const locked = await machineSession(tx, scope, input.chat, true);
      if (current(locked)) return { accepted: true, job: null };
      // Checked under the row lock: cooling leaves the warm set before it cools the epoch under
      // this lock, so an epoch started here is always cooled after, and none starts once cold.
      if (!(await isWarm(kv, scope.workerId, input.chat))) return { accepted: false, job: null };
      if (input.epoch <= locked.epoch || input.epoch <= (locked.cooledEpoch ?? 0)) acpError("ACP_STALE_EPOCH");
      await tx
        .update(acpSessions)
        .set({ epoch: input.epoch, updatedAt: new Date() })
        .where(eq(acpSessions.id, locked.id));
      const job =
        locked.epoch > 0
          ? await enqueueJob(tx, {
              kind: STREAMS_DELETE_JOB,
              payload: { paths: [epochStreamPath(input.chat, locked.epoch)] },
              runAt: new Date(Date.now() + ACP_SUPERSEDED_EPOCH_MS),
            })
          : null;
      return { accepted: true, job };
    });
    if (!started.accepted) return { accepted: false };
    await forgetEpochFence(kv, input.chat);
    runtime.defer(dispatchJobs(runtime, [started.job]));
  }
  await writeEpochCapsule(runtime, input.chat, input.epoch, input.capsule);
  // Cooling may have committed (and deleted the stream) between the start and the write above,
  // which would have re-created a stream nothing deletes any more.
  const after = await findSession(db, input.chat);
  if (!after || (after.cooledEpoch ?? 0) >= input.epoch) {
    await runtime.streams.delete(epochStreamPath(input.chat, input.epoch));
    return { accepted: false };
  }
  return { accepted: true };
}

/**
 * Bound-Worker lifecycle update (see `SessionPatch`), under the session row lock; jobs it queued
 * (turn pricing, notifications) run after commit.
 */
export async function updateSession(
  runtime: Runtime,
  scope: WorkerScope,
  input: z.output<typeof updateSessionInput>,
) {
  const jobs = await runtime.drivers.db.transaction(async (tx) => {
    const session = await machineSession(tx, scope, input.chat, true);
    const { patch } = input;
    if (
      patch.sessionId !== undefined &&
      patch.sessionId !== session.sessionId &&
      !patch.sessionProof
    )
      acpError("ACP_INVALID_SESSION_ID");
    return await applySessionPatch(tx, session, patch as SessionPatch);
  });
  runtime.defer(dispatchJobs(runtime, jobs));
  return null;
}

/**
 * The chat's current public key epoch for sealing frames, requests, titles and errors. Only a
 * locator: the Worker verifies the epoch signature and signer before using the key.
 */
export async function chatKey(db: Database, scope: WorkerScope, chatId: string) {
  await machineSession(db, scope, chatId);
  const found = await chatWithWorkspace(db, chatId);
  if (!found?.chat.e2eeId || !found.chat.keyEpoch) return null;
  const key = await chatKeyAt(db, chatId, found.chat.keyEpoch);
  if (!key) return null;
  return {
    e2eeId: found.chat.e2eeId,
    epoch: key.epoch,
    keyId: key.keyId,
    suite: key.suite,
    publicKey: toBase64Url(key.publicKey),
    signerKeyId: key.signerKeyId,
    signature: key.signature ? toBase64Url(key.signature) : null,
    bindingSignature: key.bindingSignature ? toBase64Url(key.bindingSignature) : null,
    bindingMembers: key.bindingMembers,
    // A key the chat must replace before anything is sealed to it (removed recipient).
    rekey: await chatKeyIsStale(db, found.chat, found.workspace),
  };
}

// ---------------------------------------------------------------------------------------------
// Interactions

/** Durable sealed answers awaiting delivery to the agent (answers are sealed after the cutover). */
export async function answeredInteractions(db: Database, scope: WorkerScope) {
  const rows = await db
    .select()
    .from(acpInteractions)
    .where(and(eq(acpInteractions.worker, scope.workerId), eq(acpInteractions.status, "answered")))
    .orderBy(asc(acpInteractions.answeredAt), asc(acpInteractions.id))
    .limit(ANSWERS_PAGE);
  return rows.flatMap((row) =>
    row.sealedAnswer && row.sealedAnswerSignature && row.sealedAnswerSignerKeyId
      ? [
          {
            id: row.id,
            chat: row.chat,
            requestKey: row.requestKey,
            sealed: {
              answer: toBase64Url(row.sealedAnswer),
              signature: toBase64Url(row.sealedAnswerSignature),
              signerKeyId: row.sealedAnswerSignerKeyId,
            },
          },
        ]
      : [],
  );
}

/**
 * Opens a blocking request once (`(chat, request_key)` is unique, so a retry returns the same
 * interaction), sealed to the chat key and Worker-signed; the session waits (`awaiting`) and the
 * user whose turn needs attention is notified.
 */
export async function openInteraction(
  runtime: Runtime,
  scope: WorkerScope,
  input: z.output<typeof openInteractionInput>,
) {
  const { db } = runtime.drivers;
  if (!validAcpToken(input.requestKey)) acpError("ACP_INVALID_REQUEST_KEY");
  const result = await db.transaction(async (tx) => {
    const session = await machineSession(tx, scope, input.chat, true);
    const [existing] = await tx
      .select({ id: acpInteractions.id, workspace: acpInteractions.workspace, worker: acpInteractions.worker })
      .from(acpInteractions)
      .where(and(eq(acpInteractions.chat, input.chat), eq(acpInteractions.requestKey, input.requestKey)));
    if (existing) {
      checkWorker(scope, existing);
      return { id: existing.id, jobs: [] };
    }
    if (session.status !== "running" && session.status !== "awaiting") {
      acpError("ACP_SESSION_NOT_RUNNING");
    }
    const found = await chatWithWorkspace(tx, input.chat);
    if (
      !found?.chat.keyEpoch ||
      input.sealed.epoch !== found.chat.keyEpoch ||
      input.sealed.signature.byteLength !== 64
    )
      acpError("ACP_INVALID_SEALED");
    requireSealedBox(input.sealed.box, ACP_SEALED_INTERACTION_BYTES);
    const [row] = await tx
      .insert(acpInteractions)
      .values({
        workspace: session.workspace,
        chat: input.chat,
        worker: session.worker,
        requestKey: input.requestKey,
        kind: input.sealed.kind,
        sealedRequestEpoch: input.sealed.epoch,
        sealedRequestBox: input.sealed.box,
        sealedRequestSignature: input.sealed.signature,
      })
      .returning({ id: acpInteractions.id });
    await tx
      .update(acpSessions)
      .set({ status: "awaiting", updatedAt: new Date() })
      .where(eq(acpSessions.id, session.id));
    const jobs: (string | null)[] = [];
    if (session.turnBy) {
      await notify(
        tx,
        {
          userId: session.turnBy,
          workspace: session.workspace,
          kind: input.sealed.kind === "permission" ? "session_approval" : "session_question",
          chat: input.chat,
        },
        jobs,
      );
    }
    return { id: row!.id, jobs };
  });
  runtime.defer(dispatchJobs(runtime, result.jobs));
  return result.id;
}

/**
 * Closes an interaction after the agent accepted the decision; the turn resumes (`running`) only
 * once no pending or answered interaction of the chat is left, checked in the same statement.
 */
export async function resolveInteraction(
  db: Database,
  scope: WorkerScope,
  input: { interaction: string; status: "resolved" | "cancelled" },
) {
  const [row] = await db
    .select()
    .from(acpInteractions)
    .where(eq(acpInteractions.id, input.interaction));
  if (!row) return null;
  checkWorker(scope, row);
  await db.transaction(async (tx) => {
    const closed = await tx
      .update(acpInteractions)
      .set({ status: input.status, resolvedAt: new Date() })
      .where(
        and(
          eq(acpInteractions.id, row.id),
          inArray(acpInteractions.status, ["pending", "answered"]),
        ),
      )
      .returning({ id: acpInteractions.id });
    if (closed.length === 0) return;
    await tx
      .update(acpSessions)
      .set({ status: "running", updatedAt: new Date() })
      .where(
        and(
          eq(acpSessions.chat, row.chat),
          eq(acpSessions.worker, scope.workerId),
          eq(acpSessions.status, "awaiting"),
          sql`not exists (select 1 from ${acpInteractions} where ${acpInteractions.chat} = ${row.chat} and ${acpInteractions.status} in ('pending', 'answered'))`,
        ),
      );
  });
  return null;
}

/**
 * Hands an answered interaction back to its viewers: the Worker found the sealed answer forged,
 * signed outside the chat's audience, or invalid. The backend cannot judge sealed answers, so the
 * first answer always wins until the Worker re-opens it.
 */
export async function reopenInteraction(db: Database, scope: WorkerScope, interaction: string) {
  const [row] = await db
    .select({ workspace: acpInteractions.workspace, worker: acpInteractions.worker })
    .from(acpInteractions)
    .where(eq(acpInteractions.id, interaction));
  if (!row) return null;
  checkWorker(scope, row);
  await db
    .update(acpInteractions)
    .set({
      status: "pending",
      answer: null,
      sealedAnswer: null,
      sealedAnswerSignature: null,
      sealedAnswerSignerKeyId: null,
      answeredBy: null,
      answeredAt: null,
    })
    .where(and(eq(acpInteractions.id, interaction), eq(acpInteractions.status, "answered")));
  return null;
}

// ---------------------------------------------------------------------------------------------
// Agent catalog and session index

/**
 * Replaces this Worker's agent catalog, keeping each agent's last advertised defaults across
 * probe-only reports; returns the defaults by agent id. Free-text reasons (`error`) are not stored:
 * they can carry local paths.
 */
export async function reportAgents(
  db: Database,
  scope: WorkerScope,
  agents: AcpAgentReport[],
): Promise<Record<string, NonNullable<AcpAgentReport["defaults"]>>> {
  if (
    agents.some((agent) => !validAcpAgentId(agent.agentId)) ||
    new Set(agents.map((agent) => agent.agentId)).size !== agents.length
  )
    acpError("ACP_INVALID_AGENTS");
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({ agentId: workerAgents.agentId, defaults: workerAgents.defaults })
      .from(workerAgents)
      .where(eq(workerAgents.worker, scope.workerId))
      .for("update");
    const previous = new Map(existing.map((row) => [row.agentId, row.defaults]));
    const defaults: Record<string, NonNullable<AcpAgentReport["defaults"]>> = {};
    const now = new Date();
    for (const agent of agents) {
      const kept = agent.defaults ?? previous.get(agent.agentId) ?? null;
      if (kept) defaults[agent.agentId] = kept;
      const values = {
        name: agent.name,
        version: agent.version,
        icon: agent.icon ?? null,
        source: agent.source,
        status: agent.status,
        error: null,
        capabilities: agent.capabilities,
        authMethods: agent.authMethods,
        defaults: kept,
        checkedAt: now,
      };
      await tx
        .insert(workerAgents)
        .values({ worker: scope.workerId, agentId: agent.agentId, ...values })
        .onConflictDoUpdate({ target: [workerAgents.worker, workerAgents.agentId], set: values });
    }
    const reported = agents.map((agent) => agent.agentId);
    await tx
      .delete(workerAgents)
      .where(
        and(
          eq(workerAgents.worker, scope.workerId),
          reported.length > 0 ? notInArray(workerAgents.agentId, reported) : undefined,
        ),
      );
    return defaults;
  });
}

/** This Worker's agent session index of one agent, read once before computing a diff. */
export async function knownAgentSessions(db: Database, scope: WorkerScope, agentId: string) {
  const rows = await db
    .select()
    .from(acpAgentSessions)
    .where(and(eq(acpAgentSessions.worker, scope.workerId), eq(acpAgentSessions.agentId, agentId)))
    .limit(ACP_AGENT_SESSIONS_MAX);
  return rows.map((row) => ({
    sessionId: row.sessionId,
    cwd: row.cwd,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.sealedTitleEpoch !== null && row.sealedTitleBox !== null
      ? { sealedTitle: sealedWire(row.sealedTitleEpoch, row.sealedTitleBox)! }
      : {}),
    ...(row.titleTag !== null ? { titleTag: row.titleTag } : {}),
    updatedAt: row.updatedAt.getTime(),
  }));
}

/**
 * Applies one chunk of a metadata diff of this Worker's session index (`start` marks a background
 * sync running, `finish` records its outcome). Titles are sealed to the owner key and sync errors
 * are fixed codes; changed rows keep their chat link, new rows link the chat already bound to the
 * session id.
 */
export async function syncAgentSessions(
  db: Database,
  scope: WorkerScope,
  input: z.output<typeof syncAgentSessionsInput>,
) {
  const agent = await findAgent(db, scope.workerId, input.agentId);
  if (!agent) acpError("ACP_AGENT_UNAVAILABLE");
  if (
    input.upserts.some(
      (row) =>
        !validAcpToken(row.sessionId) ||
        !validChatWorkerDirectory(row.cwd) ||
        !Number.isFinite(row.updatedAt),
    ) ||
    input.removals.some((id) => !validAcpToken(id)) ||
    (input.finish && "error" in input.finish && !isWorkerErrorCode(input.finish.error)) ||
    (input.finish &&
      "count" in input.finish &&
      (input.finish.count < 0 || input.finish.count > ACP_AGENT_SESSIONS_MAX))
  )
    acpError("ACP_INVALID_AGENT_SESSIONS");
  await db.transaction(async (tx) => {
    if (input.upserts.length > 0) {
      const bound = await tx
        .select({ sessionId: acpSessions.sessionId, chat: acpSessions.chat })
        .from(acpSessions)
        .where(
          and(
            eq(acpSessions.worker, scope.workerId),
            eq(acpSessions.agentId, input.agentId),
            inArray(
              acpSessions.sessionId,
              input.upserts.map((row) => row.sessionId),
            ),
          ),
        );
      const chats = new Map(bound.map((row) => [row.sessionId, row.chat]));
      for (const entry of input.upserts) {
        const fields = {
          cwd: entry.cwd,
          title: null,
          sealedTitleEpoch: entry.sealedTitle?.epoch ?? null,
          sealedTitleBox: entry.sealedTitle?.box ?? null,
          titleTag: entry.titleTag ?? null,
          updatedAt: new Date(entry.updatedAt),
        };
        await tx
          .insert(acpAgentSessions)
          .values({
            workspace: scope.workspaceId,
            worker: scope.workerId,
            agentId: input.agentId,
            sessionId: entry.sessionId,
            chat: chats.get(entry.sessionId) ?? null,
            ...fields,
          })
          .onConflictDoUpdate({
            target: [acpAgentSessions.worker, acpAgentSessions.agentId, acpAgentSessions.sessionId],
            set: fields,
          });
      }
    }
    if (input.removals.length > 0) {
      await tx
        .delete(acpAgentSessions)
        .where(
          and(
            eq(acpAgentSessions.worker, scope.workerId),
            eq(acpAgentSessions.agentId, input.agentId),
            inArray(acpAgentSessions.sessionId, input.removals),
          ),
        );
    }
    const at = Date.now();
    const sessionsSync = input.finish
      ? "error" in input.finish
        ? { status: "failed" as const, at, error: input.finish.error }
        : {
            status: "done" as const,
            at,
            count: input.finish.count,
            truncated: input.finish.truncated,
          }
      : input.start
        ? { status: "running" as const, at }
        : undefined;
    if (sessionsSync) {
      await tx.update(workerAgents).set({ sessionsSync }).where(eq(workerAgents.id, agent.id));
    }
  });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Recovery

/**
 * Process-start recovery: claimed commands fail (their outcome is unknown and never replayed), a
 * prompt or fork that had not started fails its session, sessions mid-turn fail, and open
 * interactions are cancelled. Unclaimed commands stay queued. `more` asks for another pass.
 */
export async function recoverWorker(runtime: Runtime, scope: WorkerScope) {
  const result = await runtime.drivers.db.transaction(async (tx) => {
    const jobs: (string | null)[] = [];
    const now = new Date();
    const commands = await tx
      .update(acpCommands)
      .set({ status: "failed", error: "ACP_FAILED", finishedAt: now })
      .where(
        sql`${acpCommands.id} in (select ${acpCommands.id} from ${acpCommands} where ${acpCommands.worker} = ${scope.workerId} and ${acpCommands.status} = 'claimed' limit ${RECOVERY_BATCH})`,
      )
      .returning({ kind: acpCommands.kind, chat: acpCommands.chat, result: acpCommands.result });
    const failed = { status: "failed" as const, sealedError: null };
    for (const row of commands) {
      if (row.kind !== "prompt" && row.kind !== "fork") continue;
      const target = row.kind === "fork" ? row.result : row.chat;
      const session = target ? await findSession(tx, target, true) : undefined;
      if (session?.status === "starting" && session.worker === scope.workerId) {
        jobs.push(...(await applySessionPatch(tx, session, failed)));
      }
    }
    const busy = await tx
      .select()
      .from(acpSessions)
      .where(
        and(
          eq(acpSessions.worker, scope.workerId),
          inArray(acpSessions.status, ["running", "awaiting"]),
        ),
      )
      .orderBy(asc(acpSessions.id))
      .limit(RECOVERY_BATCH)
      .for("update");
    for (const session of busy) jobs.push(...(await applySessionPatch(tx, session, failed)));
    const interactions = await tx
      .update(acpInteractions)
      .set({ status: "cancelled", resolvedAt: now })
      .where(
        sql`${acpInteractions.id} in (select ${acpInteractions.id} from ${acpInteractions} where ${acpInteractions.worker} = ${scope.workerId} and ${acpInteractions.status} in ('pending', 'answered') limit ${RECOVERY_BATCH})`,
      )
      .returning({ id: acpInteractions.id });
    const more =
      commands.length === RECOVERY_BATCH ||
      busy.length === RECOVERY_BATCH ||
      interactions.length === RECOVERY_BATCH;
    return { jobs, more };
  });
  runtime.defer(dispatchJobs(runtime, result.jobs));
  return { more: result.more };
}
