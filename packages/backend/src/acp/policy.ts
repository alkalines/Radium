import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { requireAccessibleChat } from "../../convex/workspaces";
import type { WorkerMutationCtx, WorkerQueryCtx } from "../worker/machine";
import type { AcpCommandPayload, AcpConfig, AcpSessionStatus, AcpStopReason } from "./contract";
import { validAcpToken } from "./contract";

type ReadCtx = QueryCtx | MutationCtx;

/** Caller-visible ACP failure, without leaking another Worker's binding. */
export function acpError(code: string, message?: string): never {
  throw new ConvexError(message ? { code, message } : { code });
}

/** Single indexed metadata lookup; no presence or transcript reads. */
export async function findSession(ctx: ReadCtx, chat: Id<"aisdk_chats">) {
  return (
    (
      await ctx.db
        .query("acp_sessions")
        .withIndex("by_chat", (q) => q.eq("chat", chat))
        .take(1)
    )[0] ?? null
  );
}

/** Visibility is control, including for members of shared ACP chats. */
export async function accessibleSession(ctx: ReadCtx, chatId: Id<"aisdk_chats">) {
  const access = await requireAccessibleChat(ctx, chatId);
  if (!access.chat.agent) acpError("ACP_NOT_ACP");
  const session = await findSession(ctx, chatId);
  if (!session) acpError("ACP_NOT_ACP");
  return { ...access, session, agent: access.chat.agent };
}

/**
 * Authorize chat-level actions (rename, pin, delete). Built-in chats need a manager (creator, or
 * the owner for shared chats); in an ACP chat everyone who can see it may act
 * (`docs/ACP.md#who-can-use-it`).
 */
export async function requireChatActor(ctx: ReadCtx, chatId: Id<"aisdk_chats">) {
  const access = await requireAccessibleChat(ctx, chatId);
  if (!access.chat.agent && !access.canManage) throw new Error("Chat not found.");
  return access;
}

/** Fence every machine-selected row by the verified workspace and Worker identity. */
export function checkWorker(
  ctx: WorkerQueryCtx | WorkerMutationCtx,
  row: { workspace: Id<"workspaces">; worker: string },
) {
  if (row.workspace !== ctx.worker.workspaceId || row.worker !== ctx.worker.workerId)
    acpError("ACP_DENIED");
}

/** Require the metadata row assigned to this machine. */
export async function machineSession(
  ctx: WorkerQueryCtx | WorkerMutationCtx,
  chat: Id<"aisdk_chats">,
) {
  const session = await findSession(ctx, chat);
  if (!session) acpError("ACP_DENIED");
  checkWorker(ctx, session);
  return session;
}

/** Catalog lookup bounded by the composite identity index. */
export async function findAgent(
  ctx: ReadCtx,
  workspace: Id<"workspaces">,
  worker: string,
  agentId: string,
) {
  return (
    (
      await ctx.db
        .query("worker_agents")
        .withIndex("by_worker_and_agentId", (q) =>
          q.eq("workspace", workspace).eq("worker", worker).eq("agentId", agentId),
        )
        .take(1)
    )[0] ?? null
  );
}

/** Idempotency keys are scoped to a machine, but never grant access to another issuer's command. */
export async function existingCommand(
  ctx: ReadCtx,
  workspace: Id<"workspaces">,
  worker: string,
  clientId: string,
  by: string,
) {
  if (!validAcpToken(clientId, 128)) acpError("ACP_INVALID_CLIENT_ID");
  const command = (
    await ctx.db
      .query("acp_commands")
      .withIndex("by_worker_and_clientId", (q) =>
        q.eq("workspace", workspace).eq("worker", worker).eq("clientId", clientId),
      )
      .take(1)
  )[0];
  if (command && command.by !== by) acpError("ACP_DENIED");
  return command ?? null;
}

/** Insert durable browser intent; callers authorize the target before using this helper. */
export async function enqueue(
  ctx: MutationCtx,
  binding: { workspace: Id<"workspaces">; worker: string },
  by: string,
  payload: AcpCommandPayload,
  chat?: Id<"aisdk_chats">,
  clientId: string = crypto.randomUUID(),
) {
  const existing = await existingCommand(ctx, binding.workspace, binding.worker, clientId, by);
  if (existing) return existing._id;
  return ctx.db.insert("acp_commands", {
    ...binding,
    by,
    kind: payload.kind,
    agentId: "agentId" in payload ? payload.agentId : undefined,
    payload,
    chat,
    clientId,
    status: "pending",
  });
}

/** Agent-advertised config is authoritative when known; drafts may precede its first report. */
export function validateConfig(
  config: AcpConfig | undefined,
  configId: string,
  value: string | boolean,
) {
  if (!validAcpToken(configId)) acpError("ACP_INVALID_CONFIG");
  if (!config) return;
  const option = config.options.find((option) => option.id === configId);
  if (
    !option ||
    (option.type === "boolean"
      ? typeof value !== "boolean"
      : typeof value !== "string" || !option.choices.some((choice) => choice.value === value))
  )
    acpError("ACP_INVALID_CONFIG");
}

/** A selected mode must belong to the latest advertised mode set when it is known. */
export function validateMode(config: AcpConfig | undefined, modeId: string) {
  if (
    !validAcpToken(modeId) ||
    (config && !config.modes?.available.some((mode) => mode.id === modeId))
  )
    acpError("ACP_INVALID_MODE");
}

/** Lifecycle patch accepted only from the bound Worker. Null explicitly clears the last error. */
export type SessionPatch = {
  status?: AcpSessionStatus;
  stopReason?: AcpStopReason;
  error?: string | null;
  config?: Doc<"acp_sessions">["config"];
  commands?: Doc<"acp_sessions">["commands"];
  usage?: Doc<"acp_sessions">["usage"];
  history?: Doc<"acp_sessions">["history"];
  sessionId?: string;
  title?: string;
};

/** Interruption text for stop reasons that end a turn as failed. */
const STOP_REASON_FAILURES: Partial<Record<AcpStopReason, string>> = {
  max_tokens: "Output limit reached",
  max_turn_requests: "The agent's turn limit was reached",
  refusal: "The model refused",
};

/** Mirror boundaries atomically; frame writes deliberately never call this policy. */
export async function applySessionPatch(
  ctx: MutationCtx,
  session: Doc<"acp_sessions">,
  patch: SessionPatch,
) {
  const chat = await ctx.db.get(session.chat);
  if (!chat?.agent) acpError("ACP_DENIED");
  const now = Date.now();
  const { title, sessionId, error, ...fields } = patch;
  const updates: Partial<Doc<"acp_sessions">> = { ...fields, updatedAt: now };
  if (error !== undefined) updates.error = error === null ? undefined : error.slice(0, 500);
  const chatPatch: Partial<Doc<"aisdk_chats">> = {};
  if (sessionId !== undefined) {
    if (!validAcpToken(sessionId)) acpError("ACP_INVALID_SESSION_ID");
    if (
      (session.sessionId && session.sessionId !== sessionId) ||
      (chat.agent.sessionId && chat.agent.sessionId !== sessionId)
    )
      acpError("ACP_SESSION_BOUND");
    if (!session.sessionId) {
      const bound = await ctx.db
        .query("acp_sessions")
        .withIndex("by_worker_and_sessionId", (q) =>
          q
            .eq("workspace", session.workspace)
            .eq("worker", session.worker)
            .eq("sessionId", sessionId),
        )
        .take(8);
      if (bound.some((row) => row.agentId === session.agentId && row.chat !== session.chat))
        acpError("ACP_SESSION_BOUND");
    }
    updates.sessionId = sessionId;
    chatPatch.agent = { ...chat.agent, sessionId };
  }
  if (title !== undefined && !session.userTitled) {
    const normalized = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (normalized) chatPatch.title = normalized;
  }
  const indexedSessionId = sessionId ?? session.sessionId;
  if (indexedSessionId && (sessionId !== undefined || chatPatch.title !== undefined)) {
    const row = await ctx.db
      .query("acp_agent_sessions")
      .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
        q
          .eq("workspace", session.workspace)
          .eq("worker", session.worker)
          .eq("agentId", session.agentId)
          .eq("sessionId", indexedSessionId),
      )
      .first();
    const indexedTitle = chatPatch.title ?? chat.title ?? row?.title;
    if (row) {
      if (row.chat !== chat._id || row.title !== indexedTitle)
        await ctx.db.patch(row._id, { chat: chat._id, title: indexedTitle });
    } else {
      await ctx.db.insert("acp_agent_sessions", {
        workspace: session.workspace,
        worker: session.worker,
        agentId: session.agentId,
        sessionId: indexedSessionId,
        cwd: session.cwd,
        title: indexedTitle,
        updatedAt: now,
        chat: chat._id,
      });
    }
  }
  let notification: "session_finished" | "session_failed" | undefined;
  let detail: string | undefined;
  if (patch.status === "running") {
    updates.draft = undefined;
    if (session.status !== "running")
      Object.assign(chatPatch, { activeStream: true, interruption: undefined });
  } else if (patch.status === "idle") {
    const stopReason = patch.stopReason ?? session.stopReason;
    Object.assign(chatPatch, {
      activeStream: false,
      lastInteractionAt: now,
      interruption: stopReason === "cancelled" ? { kind: "interrupted" } : undefined,
    });
    if (
      stopReason === "end_turn" &&
      (session.status === "running" || session.status === "awaiting")
    )
      notification = "session_finished";
  } else if (patch.status === "failed") {
    const reason = patch.stopReason ?? session.stopReason;
    const reported = error === null ? undefined : (error ?? session.error);
    detail = reported || (reason && STOP_REASON_FAILURES[reason]) || "Agent failed";
    Object.assign(chatPatch, {
      activeStream: false,
      lastInteractionAt: now,
      interruption: { kind: "failed", message: detail },
    });
    if (session.status !== "failed") notification = "session_failed";
  } else if (patch.status === "ended") chatPatch.activeStream = false;
  await ctx.db.patch(session._id, updates);
  if (Object.keys(chatPatch).length) await ctx.db.patch(chat._id, chatPatch);
  if (notification && session.turnBy) {
    // Notifications are a side channel and must not reject a successful state transition.
    try {
      await ctx.scheduler.runAfter(0, internal.notifications.notifySession, {
        userId: session.turnBy,
        chat: chat._id,
        kind: notification,
        ...(detail ? { detail } : {}),
      });
    } catch {
      /* Metadata remains authoritative. */
    }
  }
}
