import { v } from "convex/values";
import { CAPSULE_BYTES } from "radium-crypto";
import { internal } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  workerMutation,
  workerQuery,
  type WorkerMutationCtx,
  type WorkerQueryCtx,
} from "../worker/machine";
import { validChatWorkerDirectory } from "../worker/chat-config";
import { chatKeyIsStale } from "../e2ee/chat-keys";
import {
  ACP_AGENT_DEFINITIONS_MAX,
  ACP_COMMAND_RESULT_BYTES,
  ACP_AGENT_SESSIONS_MAX,
  ACP_AGENT_SESSIONS_SYNC_CHUNK,
  acpAgentSessionEntryValidator,
  ACP_FRAME_BYTES,
  ACP_FRAMES_PER_APPEND,
  ACP_INTERACTION_REQUEST_BYTES,
  ACP_SUPERSEDED_EPOCH_MS,
  acpAgentReportValidator,
  acpCommandInfoValidator,
  acpConfigValidator,
  acpFrameInputValidator,
  acpHistoryValidator,
  acpInteractionRequestValidator,
  acpSessionStatusValidator,
  acpStopReasonValidator,
  acpTurnReportValidator,
  acpTurnUsageValidator,
  acpUsageValidator,
  acpStream,
  utf8Bytes,
  ACP_WARM_SESSIONS_MAX,
  validAcpAgentId,
  validAcpToken,
  type AcpAgentReport,
  ACP_SEALED_FRAME_BYTES,
  ACP_SEALED_INTERACTION_BYTES,
  ACP_SEALED_SHORT_BYTES,
  acpSealedBoxValidator,
  acpSealedRequestValidator,
  acpStreamCapsuleValidator,
} from "./contract";
import {
  acpError,
  applySessionPatch,
  checkWorker,
  findAgent,
  findSession,
  machineSession,
} from "./policy";
import {
  isWorkerErrorCode,
  requireMode,
  requireSealedBox,
  sameBytes,
  samePayload,
  workspaceHasKeys,
} from "./sealed";

/** Pending intent for this verified machine, without transient prompt payloads. */
export const assignedCommands = workerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("acp_commands")
      .withIndex("by_worker_and_status", (q) =>
        q
          .eq("workspace", ctx.worker.workspaceId)
          .eq("worker", ctx.worker.workerId)
          .eq("status", "pending"),
      )
      .take(16);
    return rows.map((row) => ({
      _id: row._id,
      kind: row.kind,
      chat: row.chat ?? null,
      createdAt: row._creationTime,
    }));
  },
});

/** E2EE facts a paired Worker verifies before acting on a chat (null for chats without keys). */
async function chatE2ee(ctx: WorkerQueryCtx | WorkerMutationCtx, session: Doc<"acp_sessions">) {
  const chat = await ctx.db.get(session.chat);
  if (!chat?.e2eeId) return null;
  const workspace = await ctx.db.get(session.workspace);
  return {
    e2eeId: chat.e2eeId,
    keyEpoch: chat.keyEpoch ?? null,
    rekey: !workspace || await chatKeyIsStale(ctx, chat, workspace),
    creatorUserId: chat.userId,
    binding: session.binding ?? null,
    sessionProof: session.sessionProof ?? null,
  };
}

/**
 * Claim once and erase payload in the same transaction that returns it to the Worker. In keyed
 * workspaces `payload` is null and `signed` carries the sealed, user-signed command; the session's
 * binding facts let the Worker authorize the signer itself. `draft` is legacy only.
 */
export const claimCommand = workerMutation({
  args: { command: v.id("acp_commands") },
  handler: async (ctx, { command }) => {
    const row = await ctx.db.get(command);
    if (!row) return null;
    checkWorker(ctx, row);
    if (row.status !== "pending") return null;
    const session = row.chat ? await findSession(ctx, row.chat) : null;
    const chat = row.chat ? await ctx.db.get(row.chat) : null;
    if (row.chat && (!session || !chat)) {
      await ctx.db.patch(command, {
        status: "failed",
        error: "ACP_SESSION_DELETED",
        payload: undefined,
        signed: undefined,
        finishedAt: Date.now(),
      });
      return null;
    }
    if (session) checkWorker(ctx, session);
    if (!row.payload && !row.signed) acpError("ACP_COMMAND_INVALID");
    await ctx.db.patch(command, {
      status: "claimed",
      claimedAt: Date.now(),
      payload: undefined,
      signed: undefined,
    });
    // A signed fork names its target only inside the sealed payload; the Worker checks that the
    // target is this receipt's chat and verifies its binding before binding the forked session.
    const forkTargetId =
      row.kind === "fork" && row.signed && row.result
        ? ctx.db.normalizeId("aisdk_chats", row.result)
        : null;
    const forkTarget = forkTargetId ? await findSession(ctx, forkTargetId) : null;
    if (forkTarget) checkWorker(ctx, forkTarget);
    return {
      command,
      kind: row.kind,
      clientId: row.clientId,
      payload: row.payload ?? null,
      signed: row.signed ?? null,
      target: row.target ?? null,
      chat: row.chat ?? null,
      by: row.by,
      session: session
        ? {
            agentId: session.agentId,
            profile: session.profile ?? "native",
            cwd: session.cwd,
            sessionId: session.sessionId ?? null,
            status: session.status,
            epoch: session.epoch,
            warm: session.warm,
            draft: session.draft ?? null,
            config: session.config ?? null,
            e2ee: await chatE2ee(ctx, session),
          }
        : null,
      forkTarget: forkTarget
        ? {
            chat: forkTarget.chat,
            agentId: forkTarget.agentId,
            profile: forkTarget.profile ?? "native",
            cwd: forkTarget.cwd,
            e2ee: await chatE2ee(ctx, forkTarget),
          }
        : null,
    };
  },
});

/**
 * Terminal command receipt; repeated acknowledgements are harmless. A Worker in a keyed workspace
 * reports only `ACP_WORKER_ERROR_CODES` and no result, so no free text reaches Convex.
 */
export const finishCommand = workerMutation({
  args: {
    command: v.id("acp_commands"),
    status: v.union(v.literal("done"), v.literal("failed")),
    error: v.optional(v.string()),
    result: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.command);
    if (!row) return null;
    checkWorker(ctx, row);
    if (row.status === args.status) return null;
    if (row.status !== "claimed") acpError("ACP_COMMAND_CLOSED");
    if (args.result !== undefined && utf8Bytes(args.result) > ACP_COMMAND_RESULT_BYTES)
      acpError("ACP_RESULT_TOO_LARGE");
    if (
      (await workspaceHasKeys(ctx, row.workspace)) &&
      (args.result !== undefined || (args.error !== undefined && !isWorkerErrorCode(args.error)))
    )
      acpError("ACP_PLAINTEXT_REFUSED");
    await ctx.db.patch(row._id, {
      status: args.status,
      error: args.error?.slice(0, 500),
      result: args.result ?? row.result,
      finishedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Warm bindings only; appending frames never invalidates these session rows. Watch and Prompt
 * admit at most `ACP_WARM_SESSIONS_MAX` warm Sessions per Worker, so this read is complete.
 */
export const warmSessions = workerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("acp_sessions")
      .withIndex("by_worker_and_warm", (q) =>
        q
          .eq("workspace", ctx.worker.workspaceId)
          .eq("worker", ctx.worker.workerId)
          .eq("warm", true),
      )
      .take(ACP_WARM_SESSIONS_MAX);
    return Promise.all(
      rows.map(async (row) => ({
        chat: row.chat,
        epoch: row.epoch,
        agentId: row.agentId,
        profile: row.profile ?? "native",
        cwd: row.cwd,
        sessionId: row.sessionId ?? null,
        status: row.status,
        e2ee: await chatE2ee(ctx, row),
      })),
    );
  },
});

/**
 * Durable browser decisions awaiting delivery to the agent: a plaintext `answer` (keyless
 * workspaces) or a `sealed` one the Worker verifies and, when invalid, re-opens.
 */
export const answeredInteractions = workerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("acp_interactions")
      .withIndex("by_worker_and_status", (q) =>
        q
          .eq("workspace", ctx.worker.workspaceId)
          .eq("worker", ctx.worker.workerId)
          .eq("status", "answered"),
      )
      .take(32);
    return rows
      .filter((row) => row.answer !== undefined || row.sealedAnswer !== undefined)
      .map((row) => ({
        _id: row._id,
        chat: row.chat,
        requestKey: row.requestKey,
        ...(row.answer ? { answer: row.answer } : {}),
        ...(row.sealedAnswer ? { sealed: row.sealedAnswer } : {}),
      }));
  },
});

/**
 * Open a bounded blocking request once, notifying the user whose turn needs attention. In a keyed
 * workspace the request must be `sealed` to the chat key and Worker-signed; the plaintext form is
 * refused there.
 */
export const openInteraction = workerMutation({
  args: {
    chat: v.id("aisdk_chats"),
    requestKey: v.string(),
    request: v.optional(acpInteractionRequestValidator),
    sealed: v.optional(
      v.object({
        kind: v.union(v.literal("permission"), v.literal("elicitation")),
        ...acpSealedRequestValidator.fields,
      }),
    ),
  },
  handler: async (ctx, args) => {
    const session = await machineSession(ctx, args.chat);
    if (!validAcpToken(args.requestKey)) acpError("ACP_INVALID_REQUEST_KEY");
    const existing = (
      await ctx.db
        .query("acp_interactions")
        .withIndex("by_chat_and_requestKey", (q) =>
          q.eq("chat", args.chat).eq("requestKey", args.requestKey),
        )
        .take(1)
    )[0];
    if (existing) {
      checkWorker(ctx, existing);
      return existing._id;
    }
    if (session.status !== "running" && session.status !== "awaiting")
      acpError("ACP_SESSION_NOT_RUNNING");
    const keyed = await workspaceHasKeys(ctx, session.workspace);
    requireMode(keyed, args.sealed !== undefined, args.request !== undefined);
    let kind: "permission" | "elicitation";
    if (args.sealed) {
      const chat = await ctx.db.get(args.chat);
      if (
        !chat?.keyEpoch ||
        args.sealed.epoch !== chat.keyEpoch ||
        args.sealed.signature.byteLength !== 64
      )
        acpError("ACP_INVALID_SEALED");
      requireSealedBox(args.sealed.box, ACP_SEALED_INTERACTION_BYTES);
      kind = args.sealed.kind;
    } else {
      if (utf8Bytes(JSON.stringify(args.request)) > ACP_INTERACTION_REQUEST_BYTES)
        acpError("ACP_INTERACTION_TOO_LARGE");
      kind = args.request!.kind;
    }
    const interaction = await ctx.db.insert("acp_interactions", {
      chat: args.chat,
      requestKey: args.requestKey,
      ...(args.request ? { request: args.request } : {}),
      ...(args.sealed
        ? {
            sealedRequest: {
              epoch: args.sealed.epoch,
              box: args.sealed.box,
              signature: args.sealed.signature,
            },
          }
        : {}),
      workspace: session.workspace,
      worker: session.worker,
      kind,
      status: "pending",
      createdAt: Date.now(),
    });
    await ctx.db.patch(session._id, { status: "awaiting", updatedAt: Date.now() });
    if (session.turnBy) {
      try {
        await ctx.scheduler.runAfter(0, internal.notifications.notifySession, {
          userId: session.turnBy,
          chat: args.chat,
          kind: kind === "permission" ? "session_approval" : "session_question",
        });
      } catch {
        /* Notification delivery cannot block the request. */
      }
    }
    return interaction;
  },
});

/** Resolve after the agent accepted the decision; resume only after every open request closes. */
export const resolveInteraction = workerMutation({
  args: {
    interaction: v.id("acp_interactions"),
    status: v.union(v.literal("resolved"), v.literal("cancelled")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.interaction);
    if (!row) return null;
    checkWorker(ctx, row);
    if (row.status === "resolved" || row.status === "cancelled") return null;
    await ctx.db.patch(row._id, { status: args.status, resolvedAt: Date.now() });
    const session = await findSession(ctx, row.chat);
    if (session?.status === "awaiting") {
      checkWorker(ctx, session);
      const pending = await ctx.db
        .query("acp_interactions")
        .withIndex("by_chat_and_status", (q) => q.eq("chat", row.chat).eq("status", "pending"))
        .take(1);
      const answered = await ctx.db
        .query("acp_interactions")
        .withIndex("by_chat_and_status", (q) => q.eq("chat", row.chat).eq("status", "answered"))
        .take(1);
      if (!pending.length && !answered.length)
        await ctx.db.patch(session._id, { status: "running", updatedAt: Date.now() });
    }
    return null;
  },
});

/**
 * Hand an answered interaction back to its viewers: the Worker found the sealed answer forged,
 * signed by someone outside the chat's audience, or invalid for its request. Convex cannot judge
 * sealed answers itself, so the first answer always wins until the Worker re-opens it.
 */
export const reopenInteraction = workerMutation({
  args: { interaction: v.id("acp_interactions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.interaction);
    if (!row) return null;
    checkWorker(ctx, row);
    if (row.status !== "answered") return null;
    await ctx.db.patch(row._id, {
      status: "pending",
      answer: undefined,
      sealedAnswer: undefined,
      answeredBy: undefined,
      answeredAt: undefined,
    });
    return null;
  },
});

/**
 * Open a monotonically increasing warm stream; retrying its creation is idempotent. In a keyed
 * workspace every epoch carries the Worker-signed `capsule` its frames are sealed under, and a retry
 * must repeat the same capsule bytes.
 */
export const startEpoch = workerMutation({
  args: {
    chat: v.id("aisdk_chats"),
    epoch: v.number(),
    capsule: v.optional(acpStreamCapsuleValidator),
  },
  handler: async (ctx, args) => {
    const session = await machineSession(ctx, args.chat);
    if (!Number.isSafeInteger(args.epoch) || args.epoch < 0) acpError("ACP_STALE_EPOCH");
    const keyed = await workspaceHasKeys(ctx, session.workspace);
    if (keyed !== (args.capsule !== undefined)) acpError("ACP_E2EE_MODE");
    if (args.capsule) {
      const chat = await ctx.db.get(args.chat);
      if (
        !chat?.keyEpoch ||
        args.capsule.chatEpoch !== chat.keyEpoch ||
        args.capsule.capsule.byteLength !== CAPSULE_BYTES ||
        args.capsule.signature.byteLength !== 64
      )
        acpError("ACP_INVALID_SEALED");
    }
    const old = (
      await ctx.db
        .query("acp_streams")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", args.chat).eq("epoch", session.epoch))
        .take(1)
    )[0];
    // A cooled epoch is being cleared: its retries and appends restart on a fresh snapshot.
    if (args.epoch === session.epoch && old && args.epoch > (session.cooledEpoch ?? -1)) {
      if (
        args.capsule &&
        (!old.capsule ||
          !sameBytes(old.capsule.capsule, args.capsule.capsule) ||
          !sameBytes(old.capsule.signature, args.capsule.signature))
      )
        acpError("ACP_FRAME_CONFLICT");
      return { accepted: true };
    }
    if (!session.warm) return { accepted: false };
    if (args.epoch <= session.epoch) acpError("ACP_STALE_EPOCH");
    await ctx.db.insert("acp_streams", {
      chat: args.chat,
      epoch: args.epoch,
      nextSeq: 0,
      bytes: 0,
      ...(args.capsule ? { capsule: args.capsule } : {}),
    });
    await ctx.db.patch(session._id, { epoch: args.epoch, updatedAt: Date.now() });
    if (session.epoch > 0 || old)
      await ctx.scheduler.runAfter(ACP_SUPERSEDED_EPOCH_MS, internal.acp.deleteStream, {
        chat: args.chat,
        epoch: session.epoch,
      });
    return { accepted: true };
  },
});

/**
 * Atomic ordered append with exact retries; only per-stream counters are patched. Frames of a
 * keyed workspace are sealed bytes (bounded by ciphertext length); a retry must resend the same
 * bytes, since the Worker seals each frame once.
 */
export const appendFrames = workerMutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number(), frames: v.array(acpFrameInputValidator) },
  handler: async (ctx, args) => {
    const session = await machineSession(ctx, args.chat);
    if (!session.warm || session.epoch !== args.epoch) return { accepted: false, bytes: 0 };
    if (args.epoch <= (session.cooledEpoch ?? -1)) acpError("ACP_STALE_EPOCH");
    if (args.frames.length < 1 || args.frames.length > ACP_FRAMES_PER_APPEND)
      acpError("ACP_INVALID_FRAMES");
    const stream = (
      await ctx.db
        .query("acp_streams")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", args.chat).eq("epoch", args.epoch))
        .take(1)
    )[0];
    if (!stream) acpError("ACP_STALE_EPOCH");
    let { nextSeq, bytes } = stream;
    const keyed = stream.capsule !== undefined;
    for (const frame of args.frames) {
      let size: number;
      if (typeof frame.payload === "string") {
        if (keyed) acpError("ACP_PLAINTEXT_REFUSED");
        size = utf8Bytes(frame.payload);
        if (size > ACP_FRAME_BYTES) acpError("ACP_FRAME_TOO_LARGE");
      } else {
        if (!keyed) acpError("ACP_E2EE_MODE");
        size = frame.payload.byteLength;
        if (size > ACP_SEALED_FRAME_BYTES) acpError("ACP_FRAME_TOO_LARGE");
      }
      if (
        !Number.isSafeInteger(frame.seqFrom) ||
        !Number.isSafeInteger(frame.seqTo) ||
        frame.seqFrom < 0 ||
        frame.seqTo < frame.seqFrom
      )
        acpError("ACP_INVALID_FRAMES");
      if (frame.seqFrom < nextSeq) {
        const existing = (
          await ctx.db
            .query("chat_frames")
            .withIndex("by_chat_and_stream_and_seqFrom", (q) =>
              q
                .eq("chat", args.chat)
                .eq("stream", acpStream(args.epoch))
                .eq("seqFrom", frame.seqFrom),
            )
            .take(1)
        )[0];
        if (
          !existing ||
          existing.seqTo !== frame.seqTo ||
          existing.kind !== frame.kind ||
          !samePayload(existing.payload, frame.payload)
        )
          acpError("ACP_FRAME_CONFLICT");
        continue;
      }
      if (frame.seqFrom > nextSeq) acpError("ACP_FRAME_GAP");
      await ctx.db.insert("chat_frames", {
        chat: args.chat,
        stream: acpStream(args.epoch),
        format: "acp",
        ...frame,
      });
      nextSeq = frame.seqTo + 1;
      bytes += size;
    }
    if (nextSeq !== stream.nextSeq) await ctx.db.patch(stream._id, { nextSeq, bytes });
    return { accepted: true, bytes };
  },
});

/**
 * Bound-Worker lifecycle updates. In keyed workspaces titles and errors are sealed, while
 * per-session config and commands travel only in sealed frames; new session IDs require a proof.
 */
export const updateSession = workerMutation({
  args: {
    chat: v.id("aisdk_chats"),
    patch: v.object({
      status: v.optional(acpSessionStatusValidator),
      stopReason: v.optional(acpStopReasonValidator),
      error: v.optional(v.union(v.string(), v.null())),
      config: v.optional(acpConfigValidator),
      commands: v.optional(v.array(acpCommandInfoValidator)),
      usage: v.optional(acpUsageValidator),
      turnUsage: v.optional(acpTurnUsageValidator),
      history: v.optional(acpHistoryValidator),
      sessionId: v.optional(v.string()),
      title: v.optional(v.string()),
      sealedTitle: v.optional(acpSealedBoxValidator),
      sealedError: v.optional(v.union(acpSealedBoxValidator, v.null())),
      indexTitle: v.optional(v.object({ ...acpSealedBoxValidator.fields, tag: v.string() })),
      sessionProof: v.optional(v.bytes()),
      turn: v.optional(acpTurnReportValidator),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await machineSession(ctx, args.chat);
    const { patch } = args;
    if (await workspaceHasKeys(ctx, session.workspace)) {
      if (patch.title !== undefined || typeof patch.error === "string" ||
          patch.config !== undefined || patch.commands !== undefined)
        acpError("ACP_PLAINTEXT_REFUSED");
      if (
        patch.sessionId !== undefined &&
        patch.sessionId !== session.sessionId &&
        !patch.sessionProof
      )
        acpError("ACP_INVALID_SESSION_ID");
    } else if (patch.sealedTitle || patch.sealedError || patch.indexTitle || patch.sessionProof) {
      acpError("ACP_E2EE_MODE");
    }
    await applySessionPatch(ctx, session, patch);
    return null;
  },
});

/**
 * The chat's current public key epoch for sealing frames, requests, titles and errors. Only a
 * locator: the Worker verifies the epoch signature and signer before using the key.
 */
export const chatKey = workerQuery({
  args: { chat: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const session = await machineSession(ctx, args.chat);
    const chat = await ctx.db.get(args.chat);
    if (!chat?.e2eeId || !chat.keyEpoch) return null;
    const key = await ctx.db
      .query("e2ee_chat_keys")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id).eq("epoch", chat.keyEpoch!))
      .unique();
    if (!key) return null;
    const workspace = await ctx.db.get(session.workspace);
    if (!workspace) return null;
    return {
      e2eeId: chat.e2eeId,
      epoch: key.epoch,
      keyId: key.keyId,
      suite: key.suite,
      publicKey: key.publicKey,
      signerKeyId: key.signerKeyId ?? null,
      signature: key.signature ?? null,
      // A key the chat must replace before anything is sealed to it (removed recipient).
      rekey: await chatKeyIsStale(ctx, chat, workspace),
    };
  },
});

/** Replace this machine's bounded catalog, retaining defaults across probe-only reports. */
export const reportAgents = workerMutation({
  args: { agents: v.array(acpAgentReportValidator) },
  returns: v.record(
    v.string(),
    v.object({
      config: v.optional(acpConfigValidator),
      commands: v.optional(v.array(acpCommandInfoValidator)),
    }),
  ),
  handler: async (ctx, { agents }) => {
    if (
      agents.length > ACP_AGENT_DEFINITIONS_MAX ||
      agents.some((agent) => !validAcpAgentId(agent.agentId)) ||
      new Set(agents.map((agent) => agent.agentId)).size !== agents.length
    )
      acpError("ACP_INVALID_AGENTS");
    const rows = await ctx.db
      .query("worker_agents")
      .withIndex("by_worker_and_agentId", (q) =>
        q.eq("workspace", ctx.worker.workspaceId).eq("worker", ctx.worker.workerId),
      )
      .take(ACP_AGENT_DEFINITIONS_MAX + 1);
    const defaults: Record<string, NonNullable<AcpAgentReport["defaults"]>> = {};
    for (const agent of agents) {
      const existing = rows.find((row) => row.agentId === agent.agentId);
      const report = {
        ...agent,
        defaults: agent.defaults ?? existing?.defaults,
        checkedAt: Date.now(),
      };
      if (report.defaults) defaults[agent.agentId] = report.defaults;
      if (existing) await ctx.db.patch(existing._id, report);
      else
        await ctx.db.insert("worker_agents", {
          ...report,
          workspace: ctx.worker.workspaceId,
          worker: ctx.worker.workerId,
        });
    }
    for (const row of rows)
      if (!agents.some((agent) => agent.agentId === row.agentId)) await ctx.db.delete(row._id);
    return defaults;
  },
});

/** This Worker's small agent index, read once before computing a metadata-only diff. */
export const knownAgentSessions = workerQuery({
  args: { agentId: v.string() },
  returns: v.array(acpAgentSessionEntryValidator),
  handler: async (ctx, { agentId }) => {
    const rows = await ctx.db
      .query("acp_agent_sessions")
      .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
        q
          .eq("workspace", ctx.worker.workspaceId)
          .eq("worker", ctx.worker.workerId)
          .eq("agentId", agentId),
      )
      .take(ACP_AGENT_SESSIONS_MAX);
    return rows.map(({ sessionId, cwd, title, sealedTitle, titleTag, updatedAt }) => ({
      sessionId,
      cwd,
      ...(title !== undefined ? { title } : {}),
      ...(sealedTitle ? { sealedTitle } : {}),
      ...(titleTag !== undefined ? { titleTag } : {}),
      updatedAt,
    }));
  },
});

/** `start` marks a background sync running; unchanged syncs only write start/finish state. */
export const syncAgentSessions = workerMutation({
  args: {
    agentId: v.string(),
    upserts: v.array(acpAgentSessionEntryValidator),
    removals: v.array(v.string()),
    start: v.optional(v.boolean()),
    finish: v.optional(
      v.union(
        v.object({ count: v.number(), truncated: v.boolean() }),
        v.object({ error: v.string() }),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const agent = await findAgent(ctx, ctx.worker.workspaceId, ctx.worker.workerId, args.agentId);
    if (!agent) acpError("ACP_AGENT_UNAVAILABLE");
    // A paired Worker's titles are sealed to the owner key and its sync errors are fixed codes.
    const keyed = await workspaceHasKeys(ctx, ctx.worker.workspaceId);
    if (
      args.upserts.length > ACP_AGENT_SESSIONS_SYNC_CHUNK ||
      args.removals.length > ACP_AGENT_SESSIONS_SYNC_CHUNK ||
      args.upserts.some(
        (row) =>
          !validAcpToken(row.sessionId) ||
          !validChatWorkerDirectory(row.cwd) ||
          !Number.isFinite(row.updatedAt) ||
          (row.title !== undefined && (row.title.length > 500 || row.title !== row.title.trim())) ||
          (row.titleTag !== undefined && row.titleTag.length > 64) ||
          (row.sealedTitle !== undefined &&
            row.sealedTitle.box.byteLength > ACP_SEALED_SHORT_BYTES) ||
          (keyed ? row.title !== undefined : row.sealedTitle !== undefined),
      ) ||
      args.removals.some((id) => !validAcpToken(id)) ||
      (keyed && args.finish && "error" in args.finish && !isWorkerErrorCode(args.finish.error))
    )
      acpError("ACP_INVALID_AGENT_SESSIONS");
    if (
      args.finish &&
      "count" in args.finish &&
      (!Number.isSafeInteger(args.finish.count) ||
        args.finish.count < 0 ||
        args.finish.count > ACP_AGENT_SESSIONS_MAX)
    )
      acpError("ACP_INVALID_AGENT_SESSIONS");
    for (const entry of args.upserts) {
      const row = await ctx.db
        .query("acp_agent_sessions")
        .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
          q
            .eq("workspace", ctx.worker.workspaceId)
            .eq("worker", ctx.worker.workerId)
            .eq("agentId", args.agentId)
            .eq("sessionId", entry.sessionId),
        )
        .first();
      if (row) {
        if (
          row.cwd !== entry.cwd ||
          row.title !== entry.title ||
          row.titleTag !== entry.titleTag ||
          row.sealedTitle?.epoch !== entry.sealedTitle?.epoch ||
          row.updatedAt !== entry.updatedAt
        )
          await ctx.db.patch(row._id, {
            ...entry,
            title: entry.title,
            sealedTitle: entry.sealedTitle,
            titleTag: entry.titleTag,
          });
      } else {
        const bound = await ctx.db
          .query("acp_sessions")
          .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
            q
              .eq("workspace", ctx.worker.workspaceId)
              .eq("worker", ctx.worker.workerId)
              .eq("agentId", args.agentId)
              .eq("sessionId", entry.sessionId),
          )
          .first();
        await ctx.db.insert("acp_agent_sessions", {
          workspace: ctx.worker.workspaceId,
          worker: ctx.worker.workerId,
          agentId: args.agentId,
          ...entry,
          chat: bound?.chat,
        });
      }
    }
    for (const sessionId of args.removals) {
      const row = await ctx.db
        .query("acp_agent_sessions")
        .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
          q
            .eq("workspace", ctx.worker.workspaceId)
            .eq("worker", ctx.worker.workerId)
            .eq("agentId", args.agentId)
            .eq("sessionId", sessionId),
        )
        .first();
      if (row) await ctx.db.delete(row._id);
    }
    if (args.finish) {
      const finish = args.finish;
      await ctx.db.patch(agent._id, {
        sessionsSync:
          "error" in finish
            ? { status: "failed", at: Date.now(), error: finish.error.slice(0, 500) }
            : { status: "done", at: Date.now(), count: finish.count, truncated: finish.truncated },
      });
    } else if (args.start) {
      await ctx.db.patch(agent._id, { sessionsSync: { status: "running", at: Date.now() } });
    }
    return null;
  },
});

/** Process-start recovery never replays a claimed prompt whose outcome is unknown. */
export const recoverWorker = workerMutation({
  args: {},
  handler: async (ctx) => {
    const keyed = await workspaceHasKeys(ctx, ctx.worker.workspaceId);
    const commands = await ctx.db
      .query("acp_commands")
      .withIndex("by_worker_and_status", (q) =>
        q
          .eq("workspace", ctx.worker.workspaceId)
          .eq("worker", ctx.worker.workerId)
          .eq("status", "claimed"),
      )
      .take(32);
    for (const row of commands) {
      await ctx.db.patch(row._id, {
        status: "failed",
        error: keyed ? "ACP_FAILED" : "Worker restarted",
        finishedAt: Date.now(),
      });
      if (row.kind === "prompt" || row.kind === "fork") {
        const target =
          row.kind === "fork" && row.result
            ? ctx.db.normalizeId("aisdk_chats", row.result)
            : row.chat;
        const session = target ? await findSession(ctx, target) : null;
        if (session?.status === "starting") {
          checkWorker(ctx, session);
          if (await ctx.db.get(session.chat))
            await applySessionPatch(ctx, session, keyed
              ? { status: "failed", sealedError: null }
              : { status: "failed", error: "Worker restarted" });
        }
      }
    }
    let more = commands.length === 32;
    for (const status of ["running", "awaiting"] as const) {
      const rows = await ctx.db
        .query("acp_sessions")
        .withIndex("by_worker_and_status", (q) =>
          q
            .eq("workspace", ctx.worker.workspaceId)
            .eq("worker", ctx.worker.workerId)
            .eq("status", status),
        )
        .take(32);
      for (const row of rows) {
        if (await ctx.db.get(row.chat))
          await applySessionPatch(ctx, row, keyed
            ? { status: "failed", sealedError: null }
            : { status: "failed", error: "Worker restarted" });
        else
          await ctx.db.patch(row._id, {
            status: "failed",
            error: keyed ? undefined : "Worker restarted",
            updatedAt: Date.now(),
          });
      }
      if (rows.length === 32) more = true;
    }
    for (const status of ["pending", "answered"] as const) {
      const rows = await ctx.db
        .query("acp_interactions")
        .withIndex("by_worker_and_status", (q) =>
          q
            .eq("workspace", ctx.worker.workspaceId)
            .eq("worker", ctx.worker.workerId)
            .eq("status", status),
        )
        .take(32);
      for (const row of rows)
        await ctx.db.patch(row._id, { status: "cancelled", resolvedAt: Date.now() });
      if (rows.length === 32) more = true;
    }
    return { more };
  },
});
