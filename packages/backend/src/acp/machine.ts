import { v } from "convex/values";
import { internal } from "../../convex/_generated/api";
import { workerMutation, workerQuery } from "../worker/machine";
import {
  ACP_COMMAND_RESULT_BYTES,
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
  acpUsageValidator,
  acpStream,
  utf8Bytes,
  validAcpAgentId,
  validAcpToken,
} from "./contract";
import { acpError, applySessionPatch, checkWorker, findSession, machineSession } from "./policy";

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

/** Claim once and erase payload in the same transaction that returns it to the Worker. */
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
        error: "Session deleted",
        payload: undefined,
        finishedAt: Date.now(),
      });
      return null;
    }
    if (session) checkWorker(ctx, session);
    if (!row.payload) acpError("ACP_COMMAND_INVALID");
    await ctx.db.patch(command, { status: "claimed", claimedAt: Date.now(), payload: undefined });
    return {
      command,
      kind: row.kind,
      payload: row.payload,
      chat: row.chat ?? null,
      by: row.by,
      session: session
        ? {
            agentId: session.agentId,
            cwd: session.cwd,
            sessionId: session.sessionId ?? null,
            status: session.status,
            epoch: session.epoch,
            warm: session.warm,
            draft: session.draft ?? null,
            config: session.config ?? null,
          }
        : null,
    };
  },
});

/** Terminal command receipt; repeated acknowledgements are harmless. */
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
    await ctx.db.patch(row._id, {
      status: args.status,
      error: args.error?.slice(0, 500),
      result: args.result ?? row.result,
      finishedAt: Date.now(),
    });
    return null;
  },
});

/** Warm bindings only; appending frames never invalidates these session rows. */
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
      .take(64);
    return rows.map((row) => ({
      chat: row.chat,
      epoch: row.epoch,
      agentId: row.agentId,
      cwd: row.cwd,
      sessionId: row.sessionId ?? null,
      status: row.status,
    }));
  },
});

/** Durable browser decisions awaiting delivery to the agent. */
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
      .filter((row) => row.answer !== undefined)
      .map((row) => ({
        _id: row._id,
        chat: row.chat,
        requestKey: row.requestKey,
        answer: row.answer!,
      }));
  },
});

/** Open a bounded blocking request once, notifying the user whose turn needs attention. */
export const openInteraction = workerMutation({
  args: {
    chat: v.id("aisdk_chats"),
    requestKey: v.string(),
    request: acpInteractionRequestValidator,
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
    if (utf8Bytes(JSON.stringify(args.request)) > ACP_INTERACTION_REQUEST_BYTES)
      acpError("ACP_INTERACTION_TOO_LARGE");
    const interaction = await ctx.db.insert("acp_interactions", {
      ...args,
      workspace: session.workspace,
      worker: session.worker,
      kind: args.request.kind,
      status: "pending",
      createdAt: Date.now(),
    });
    await ctx.db.patch(session._id, { status: "awaiting", updatedAt: Date.now() });
    if (session.turnBy) {
      try {
        await ctx.scheduler.runAfter(0, internal.notifications.notifySession, {
          userId: session.turnBy,
          chat: args.chat,
          kind: args.request.kind === "permission" ? "session_approval" : "session_question",
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

/** Open a monotonically increasing warm stream; retrying its creation is idempotent. */
export const startEpoch = workerMutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number() },
  handler: async (ctx, args) => {
    const session = await machineSession(ctx, args.chat);
    if (!Number.isSafeInteger(args.epoch) || args.epoch < 0) acpError("ACP_STALE_EPOCH");
    const old = (
      await ctx.db
        .query("acp_streams")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", args.chat).eq("epoch", session.epoch))
        .take(1)
    )[0];
    if (args.epoch === session.epoch && old) return { accepted: true };
    if (!session.warm) return { accepted: false };
    if (args.epoch <= session.epoch) acpError("ACP_STALE_EPOCH");
    await ctx.db.insert("acp_streams", {
      chat: args.chat,
      epoch: args.epoch,
      nextSeq: 0,
      bytes: 0,
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

/** Atomic ordered append with exact retries; only per-stream counters are patched. */
export const appendFrames = workerMutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number(), frames: v.array(acpFrameInputValidator) },
  handler: async (ctx, args) => {
    const session = await machineSession(ctx, args.chat);
    if (!session.warm || session.epoch !== args.epoch) return { accepted: false, bytes: 0 };
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
    for (const frame of args.frames) {
      const size = utf8Bytes(frame.payload);
      if (size > ACP_FRAME_BYTES) acpError("ACP_FRAME_TOO_LARGE");
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
          existing.payload !== frame.payload
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

/** Bound-Worker lifecycle and immutable session binding updates. */
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
      history: v.optional(acpHistoryValidator),
      sessionId: v.optional(v.string()),
      title: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applySessionPatch(ctx, await machineSession(ctx, args.chat), args.patch);
    return null;
  },
});

/** Replace this machine's bounded catalog, retaining defaults across probe-only reports. */
export const reportAgents = workerMutation({
  args: { agents: v.array(acpAgentReportValidator) },
  returns: v.null(),
  handler: async (ctx, { agents }) => {
    if (
      agents.length > 32 ||
      agents.some((agent) => !validAcpAgentId(agent.agentId)) ||
      new Set(agents.map((agent) => agent.agentId)).size !== agents.length
    )
      acpError("ACP_INVALID_AGENTS");
    const rows = await ctx.db
      .query("worker_agents")
      .withIndex("by_worker_and_agentId", (q) =>
        q.eq("workspace", ctx.worker.workspaceId).eq("worker", ctx.worker.workerId),
      )
      .take(33);
    for (const agent of agents) {
      const existing = rows.find((row) => row.agentId === agent.agentId);
      const report = {
        ...agent,
        defaults: agent.defaults ?? existing?.defaults,
        checkedAt: Date.now(),
      };
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
    return null;
  },
});

/** Process-start recovery never replays a claimed prompt whose outcome is unknown. */
export const recoverWorker = workerMutation({
  args: {},
  handler: async (ctx) => {
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
        error: "Worker restarted",
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
            await applySessionPatch(ctx, session, { status: "failed", error: "Worker restarted" });
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
          await applySessionPatch(ctx, row, { status: "failed", error: "Worker restarted" });
        else
          await ctx.db.patch(row._id, {
            status: "failed",
            error: "Worker restarted",
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
