import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import schema from "../../convex/schema";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { isWorkerOnline } from "../worker/presence";
import { action, mutation, query } from "../../convex/_generated/server";
import { components, internal } from "../../convex/_generated/api";
import { createInternalGatewayProvider } from "../../convex/ai_gateway";
import { authComponent } from "../../convex/auth";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../../convex/helpers";
import { requireWorkspaceProject } from "../projects/projects";
import { requireActiveWorkspaceWorker, validChatWorkerDirectory } from "../worker/chat-config";
import {
  deriveChatWorkerDirectory,
  findWorkerPresence,
  workspaceWorkerMetadata,
} from "../worker/chat-selection";
import { generateChatTitle } from "../chatroom/titles";
import {
  ACP_AGENT_DEFINITIONS_MAX,
  ACP_BUSY_STATUSES,
  ACP_HISTORY_PAGE_ITEMS,
  ACP_PROMPT_BYTES,
  acpAnswerError,
  acpInteractionAnswerValidator,
  acpPromptBlockValidator,
  utf8Bytes,
  validAcpToken,
} from "./contract";
import {
  accessibleSession,
  acpError,
  enqueue,
  existingCommand,
  findAgent,
  findSession,
  validateConfig,
  validateMode,
} from "./policy";

/** Shared atomic chat + lifecycle creation for new and indexed agent sessions. */
async function insertAgentChat(
  ctx: MutationCtx,
  args: {
    workspace: Id<"workspaces">;
    userId: string;
    worker: string;
    agentId: string;
    cwd: string;
    version: string;
    scope?: "personal" | "workspace";
    project?: Id<"projects">;
    sessionId?: string;
    title?: string;
    updatedAt?: number;
  },
) {
  const now = Date.now();
  const chat = await ctx.db.insert("aisdk_chats", {
    workspace: args.workspace,
    userId: args.userId,
    scope: args.scope ?? "personal",
    project: args.project,
    title: args.title,
    agent: {
      kind: "acp",
      profile: "native",
      worker: args.worker,
      agentId: args.agentId,
      agentVersion: args.version,
      cwd: args.cwd,
      sessionId: args.sessionId,
    },
    activeStream: false,
    lastInteractionAt: args.updatedAt ?? now,
  });
  await ctx.db.insert("acp_sessions", {
    chat,
    workspace: args.workspace,
    worker: args.worker,
    agentId: args.agentId,
    cwd: args.cwd,
    sessionId: args.sessionId,
    status: "idle",
    epoch: 0,
    warm: false,
    history: "none",
    updatedAt: now,
  });
  return chat;
}

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

/**
 * Project of each `folderKey`; a folder in several Projects belongs to the first. The catalog is
 * bounded by the workspace's 200-Project limit, read once per page.
 */
async function projectFolders(ctx: QueryCtx | MutationCtx, workspace: Id<"workspaces">) {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
    .take(200);
  const folders = new Map<string, Id<"projects">>();
  for (const project of projects)
    for (const folder of project.folders ?? []) {
      const key = folderKey(folder.workerId, folder.directory);
      if (!folders.has(key)) folders.set(key, project._id);
    }
  return folders;
}

function indexedSessionRow(row: Doc<"acp_agent_sessions">, project: Id<"projects"> | null) {
  return {
    _id: row._id,
    worker: row.worker,
    agentId: row.agentId,
    sessionId: row.sessionId,
    cwd: row.cwd,
    title: row.title,
    updatedAt: row.updatedAt,
    chat: row.chat ?? null,
    project,
  };
}

/** Owner-selected immutable native binding; every creation starts a new agent session. */
export const CreateSession = ownedWorkspaceMutation({
  args: {
    scope: v.optional(v.union(v.literal("personal"), v.literal("workspace"))),
    project: v.optional(v.id("projects")),
    worker: v.string(),
    agentId: v.string(),
    cwd: v.optional(v.string()),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args) => {
    await requireActiveWorkspaceWorker(
      args.worker,
      ctx.workspace._id,
      workspaceWorkerMetadata(ctx, ctx.workspace._id),
    );
    if (args.project) await requireWorkspaceProject(ctx, args.project, ctx.workspace._id);
    const agent = await findAgent(ctx, ctx.workspace._id, args.worker, args.agentId);
    if (!agent || (agent.status !== "ready" && agent.status !== "needs_auth"))
      acpError("ACP_AGENT_UNAVAILABLE");
    const cwd =
      args.cwd ??
      (await deriveChatWorkerDirectory(ctx, ctx.workspace._id, args.worker, args.project));
    if (!cwd || !validChatWorkerDirectory(cwd)) acpError("ACP_INVALID_CWD");
    return insertAgentChat(ctx, {
      workspace: ctx.workspace._id,
      userId: ctx.identity._id,
      worker: args.worker,
      agentId: args.agentId,
      cwd,
      version: agent.version,
      scope: args.scope,
      project: args.project,
    });
  },
});

/** Admit exactly one prompt at a time, with worker-scoped retry keys. */
export const Prompt = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    prompt: v.array(acpPromptBlockValidator),
    clientId: v.string(),
  },
  returns: v.id("acp_commands"),
  handler: async (ctx, args) => {
    const { session, userId, chat } = await accessibleSession(ctx, args.chat);
    const existing = await existingCommand(
      ctx,
      session.workspace,
      session.worker,
      args.clientId,
      userId,
    );
    if (existing) return existing._id;
    if (session.status === "ended") acpError("ACP_SESSION_ENDED");
    if (ACP_BUSY_STATUSES.includes(session.status)) acpError("ACP_SESSION_BUSY");
    if (
      !args.prompt.length ||
      !args.prompt.some((block) => block.type !== "text" || block.text.trim()) ||
      utf8Bytes(JSON.stringify(args.prompt)) > ACP_PROMPT_BYTES
    )
      acpError("ACP_INVALID_PROMPT");
    const command = await enqueue(
      ctx,
      { workspace: session.workspace, worker: session.worker },
      userId,
      { kind: "prompt", prompt: args.prompt },
      args.chat,
      args.clientId,
    );
    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: "starting",
      turnBy: userId,
      stopReason: undefined,
      error: undefined,
      updatedAt: now,
      ...(!session.warm ? { warm: true, warmSince: now } : {}),
    });
    await ctx.db.patch(chat._id, { lastInteractionAt: now, interruption: undefined });
    return command;
  },
});

/** Cancel unclaimed intent locally; otherwise send one cancellation to the live agent. */
export const Cancel = mutation({
  args: { chat: v.id("aisdk_chats") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, userId } = await accessibleSession(ctx, args.chat);
    const prompts = await ctx.db
      .query("acp_commands")
      .withIndex("by_chat_and_status", (q) => q.eq("chat", args.chat).eq("status", "pending"))
      .filter((q) => q.eq(q.field("kind"), "prompt"))
      .take(1);
    if (prompts.length) {
      await ctx.db.patch(prompts[0]!._id, {
        status: "failed",
        error: "Cancelled",
        payload: undefined,
        finishedAt: Date.now(),
      });
      await ctx.db.patch(session._id, {
        status: "idle",
        stopReason: "cancelled",
        updatedAt: Date.now(),
      });
      await ctx.db.patch(args.chat, {
        activeStream: false,
        lastInteractionAt: Date.now(),
        interruption: { kind: "interrupted" },
      });
    } else if (ACP_BUSY_STATUSES.includes(session.status)) {
      const pending = await ctx.db
        .query("acp_commands")
        .withIndex("by_chat_and_status", (q) => q.eq("chat", args.chat).eq("status", "pending"))
        .filter((q) => q.eq(q.field("kind"), "cancel"))
        .take(1);
      if (!pending.length)
        await enqueue(
          ctx,
          { workspace: session.workspace, worker: session.worker },
          userId,
          { kind: "cancel" },
          args.chat,
        );
    }
    return null;
  },
});

/** Store pre-session choices as metadata; live changes go through the assigned Worker. */
export const SetConfig = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    configId: v.string(),
    value: v.union(v.string(), v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, userId } = await accessibleSession(ctx, args.chat);
    if (session.status === "ended") acpError("ACP_SESSION_ENDED");
    if (!session.sessionId) {
      const agent = await findAgent(ctx, session.workspace, session.worker, session.agentId);
      validateConfig(agent?.defaults?.config, args.configId, args.value);
      const draft = session.draft ?? { config: [] };
      const config = draft.config.filter((option) => option.configId !== args.configId);
      config.push({ configId: args.configId, value: args.value });
      await ctx.db.patch(session._id, { draft: { ...draft, config }, updatedAt: Date.now() });
    } else {
      if (!session.config) acpError("ACP_INVALID_CONFIG");
      validateConfig(session.config, args.configId, args.value);
      await enqueue(
        ctx,
        { workspace: session.workspace, worker: session.worker },
        userId,
        { kind: "set_config", configId: args.configId, value: args.value },
        args.chat,
      );
    }
    return null;
  },
});

/** Choose an advertised mode, either in the draft or through a live command. */
export const SetMode = mutation({
  args: { chat: v.id("aisdk_chats"), modeId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, userId } = await accessibleSession(ctx, args.chat);
    if (session.status === "ended") acpError("ACP_SESSION_ENDED");
    if (!session.sessionId) {
      const agent = await findAgent(ctx, session.workspace, session.worker, session.agentId);
      validateMode(agent?.defaults?.config, args.modeId);
      await ctx.db.patch(session._id, {
        draft: { ...(session.draft ?? { config: [] }), modeId: args.modeId },
        updatedAt: Date.now(),
      });
    } else {
      if (!session.config) acpError("ACP_INVALID_MODE");
      validateMode(session.config, args.modeId);
      await enqueue(
        ctx,
        { workspace: session.workspace, worker: session.worker },
        userId,
        { kind: "set_mode", modeId: args.modeId },
        args.chat,
      );
    }
    return null;
  },
});

/** First valid visible user's decision wins; another user's private chat is never exposed. */
export const Answer = mutation({
  args: { interaction: v.id("acp_interactions"), answer: acpInteractionAnswerValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.interaction);
    if (!row) acpError("ACP_INTERACTION_CLOSED");
    const { userId } = await accessibleSession(ctx, row.chat);
    if (row.status !== "pending") acpError("ACP_INTERACTION_CLOSED");
    const message = acpAnswerError(row.request, args.answer);
    if (message) acpError("ACP_INVALID_ANSWER", message);
    await ctx.db.patch(row._id, {
      status: "answered",
      answer: args.answer,
      answeredBy: userId,
      answeredAt: Date.now(),
    });
    return null;
  },
});

/** History pages are shared within a warm epoch, so duplicate page requests share a command. */
export const RequestHistory = mutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number(), before: v.number(), limit: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, userId } = await accessibleSession(ctx, args.chat);
    if (!session.warm || args.epoch !== session.epoch) return null;
    // Dedupe keys are Worker-scoped, so the chat must be part of the page's key.
    const clientId = `history:${args.chat}:${args.epoch}:${args.before}`;
    const existing = (
      await ctx.db
        .query("acp_commands")
        .withIndex("by_worker_and_clientId", (q) =>
          q
            .eq("workspace", session.workspace)
            .eq("worker", session.worker)
            .eq("clientId", clientId),
        )
        .take(1)
    )[0];
    if (!existing)
      await enqueue(
        ctx,
        { workspace: session.workspace, worker: session.worker },
        userId,
        {
          kind: "history",
          epoch: args.epoch,
          before: args.before,
          limit: Math.min(ACP_HISTORY_PAGE_ITEMS, Math.max(1, Math.floor(args.limit))),
        },
        args.chat,
        clientId,
      );
    return null;
  },
});

/** Latest-point fork preserves binding and scope but grants ownership of the new chat to its caller. */
export const Fork = mutation({
  args: { chat: v.id("aisdk_chats"), clientId: v.string() },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args) => {
    const { session, chat, userId, agent } = await accessibleSession(ctx, args.chat);
    const existing = await existingCommand(
      ctx,
      session.workspace,
      session.worker,
      args.clientId,
      userId,
    );
    if (existing) {
      if (existing.kind !== "fork") acpError("ACP_INVALID_CLIENT_ID");
      // The command keeps no prompt; its receipt identifies the fork after payload removal.
      const target = existing.result ? ctx.db.normalizeId("aisdk_chats", existing.result) : null;
      if (target) return target;
      acpError("ACP_COMMAND_CLOSED");
    }
    const report = await findAgent(ctx, session.workspace, session.worker, session.agentId);
    if (!report?.capabilities.fork || !session.sessionId) acpError("ACP_UNSUPPORTED");
    if (ACP_BUSY_STATUSES.includes(session.status)) acpError("ACP_SESSION_BUSY");
    const { sessionId: _, ...binding } = agent;
    const target = await ctx.db.insert("aisdk_chats", {
      workspace: session.workspace,
      scope: chat.scope,
      project: chat.project,
      userId,
      agent: binding,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });
    await ctx.db.insert("acp_sessions", {
      chat: target,
      workspace: session.workspace,
      worker: session.worker,
      agentId: session.agentId,
      cwd: session.cwd,
      status: "starting",
      epoch: 0,
      warm: false,
      history: "none",
      updatedAt: Date.now(),
    });
    const command = await enqueue(
      ctx,
      { workspace: session.workspace, worker: session.worker },
      userId,
      { kind: "fork", targetChat: target },
      args.chat,
      args.clientId,
    );
    await ctx.db.patch(command, { result: target });
    return target;
  },
});

/** Paginate metadata without contacting the Worker or reading conversation content. */
export const ListAgentSessionIndex = ownedWorkspaceQuery({
  args: { agentId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("acp_agent_sessions")
      .withIndex("by_workspace_and_agentId_and_updatedAt", (q) =>
        q.eq("workspace", ctx.workspace._id).eq("agentId", args.agentId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const folders = await projectFolders(ctx, ctx.workspace._id);
    return {
      ...page,
      page: page.page.map((row) =>
        indexedSessionRow(row, folders.get(folderKey(row.worker, row.cwd)) ?? null),
      ),
    };
  },
});

export const SearchAgentSessionIndex = ownedWorkspaceQuery({
  args: { agentId: v.string(), query: v.string() },
  handler: async (ctx, args) => {
    const text = args.query.trim().slice(0, 500);
    if (!text) return [];
    const rows = await ctx.db
      .query("acp_agent_sessions")
      .withSearchIndex("search_title", (q) =>
        q.search("title", text).eq("workspace", ctx.workspace._id).eq("agentId", args.agentId),
      )
      .take(50);
    const folders = await projectFolders(ctx, ctx.workspace._id);
    return rows.map((row) =>
      indexedSessionRow(row, folders.get(folderKey(row.worker, row.cwd)) ?? null),
    );
  },
});

// An agent-session page never scans more than this many index rows, whatever its filters skip.
const AGENT_SESSIONS_PAGE_MAX_ROWS_READ = 400;

/**
 * One page of the agent sessions Radium has not opened yet (opened ones are chats, listed by
 * `aisdk.ListChats`), newest first, for Home's session list. `project` narrows to sessions in
 * that Project's folders (a folder shared by several Projects belongs to the one
 * `OpenAgentSession` would file it under), `project: null` to sessions outside every Project
 * folder. Only enabled agents' sessions are listed. Pages are reactive: clients pass `endCursor`
 * (convex-helpers `usePaginatedQuery` with `customPagination`) to keep them gapless.
 */
export const ListUnopenedAgentSessions = ownedWorkspaceQuery({
  args: {
    project: v.optional(v.union(v.id("projects"), v.null())),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const none = { page: [], isDone: true, continueCursor: "" };
    const workspace = ctx.workspace._id;
    const project = args.project ? await ctx.db.get(args.project) : null;
    if (args.project) {
      // A Project deleted while a list is subscribed has no sessions left; a foreign one is an error.
      if (!project) return none;
      if (project.workspace !== workspace) throw new Error("Project not found.");
    }
    const definitions = await ctx.db
      .query("acp_agents")
      .withIndex("by_workspace_and_agentId", (q) => q.eq("workspace", workspace))
      .take(ACP_AGENT_DEFINITIONS_MAX);
    const enabled = new Set(definitions.filter((row) => row.enabled).map((row) => row.agentId));
    if (enabled.size === 0) return none;
    const folders = await projectFolders(ctx, workspace);
    const rows = () => stream(ctx.db, schema).query("acp_agent_sessions");

    let sessions;
    if (project) {
      const streams = (project.folders ?? [])
        .filter(
          (folder) => folders.get(folderKey(folder.workerId, folder.directory)) === project._id,
        )
        .flatMap((folder) =>
          directorySpellings(folder.directory).map((cwd) =>
            rows()
              .withIndex("by_worker_and_cwd_and_chat_and_updatedAt", (q) =>
                q
                  .eq("workspace", workspace)
                  .eq("worker", folder.workerId)
                  .eq("cwd", cwd)
                  .eq("chat", undefined),
              )
              .order("desc"),
          ),
        );
      if (streams.length === 0) return none;
      sessions = mergedStream(streams, ["updatedAt"]);
    } else {
      sessions = rows()
        .withIndex("by_workspace_and_chat_and_updatedAt", (q) =>
          q.eq("workspace", workspace).eq("chat", undefined),
        )
        .order("desc");
    }
    const result = await sessions
      .filterWith(
        async (row) =>
          enabled.has(row.agentId) &&
          (args.project !== null || !folders.has(folderKey(row.worker, row.cwd))),
      )
      .paginate({ ...args.paginationOpts, maximumRowsRead: AGENT_SESSIONS_PAGE_MAX_ROWS_READ });
    return {
      ...result,
      page: result.page.map((row) =>
        indexedSessionRow(row, folders.get(folderKey(row.worker, row.cwd)) ?? null),
      ),
    };
  },
});

/** Safe on every Home open: online-only, coalesced intent and a one-minute freshness window. */
export const SyncAgentSessions = ownedWorkspaceMutation({
  args: { agentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const agents = await ctx.db
      .query("worker_agents")
      .withIndex("by_workspace_and_agentId", (q) =>
        q.eq("workspace", ctx.workspace._id).eq("agentId", args.agentId),
      )
      .collect();
    for (const agent of agents) {
      if (agent.status !== "ready" || !agent.capabilities.list) continue;
      if (
        agent.sessionsSync &&
        agent.sessionsSync.status !== "failed" &&
        now - agent.sessionsSync.at < 60_000
      )
        continue;
      const presence = await findWorkerPresence(ctx, ctx.workspace._id, agent.worker);
      if (!isWorkerOnline(presence?.lastSeenAt, now)) continue;
      let pending = false;
      for (const status of ["pending", "claimed"] as const) {
        const command = await ctx.db
          .query("acp_commands")
          .withIndex("by_worker_and_status", (q) =>
            q.eq("workspace", ctx.workspace._id).eq("worker", agent.worker).eq("status", status),
          )
          .filter((q) =>
            q.and(q.eq(q.field("kind"), "sync_sessions"), q.eq(q.field("agentId"), args.agentId)),
          )
          .first();
        if (command) {
          pending = true;
          break;
        }
      }
      if (pending) continue;
      await enqueue(ctx, { workspace: ctx.workspace._id, worker: agent.worker }, ctx.identity._id, {
        kind: "sync_sessions",
        agentId: args.agentId,
      });
    }
    return null;
  },
});

/** Open an indexed session even while offline; the immutable binding reopens when it reconnects. */
export const OpenAgentSession = ownedWorkspaceMutation({
  args: { worker: v.string(), agentId: v.string(), sessionId: v.string() },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("acp_agent_sessions")
      .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
        q
          .eq("workspace", ctx.workspace._id)
          .eq("worker", args.worker)
          .eq("agentId", args.agentId)
          .eq("sessionId", args.sessionId),
      )
      .first();
    if (!row) acpError("ACP_SESSION_NOT_FOUND");
    if (row.chat && (await ctx.db.get(row.chat))) return row.chat;
    await requireActiveWorkspaceWorker(
      args.worker,
      ctx.workspace._id,
      workspaceWorkerMetadata(ctx, ctx.workspace._id),
    );
    const agent = await findAgent(ctx, ctx.workspace._id, args.worker, args.agentId);
    if (!agent || !(agent.capabilities.loadSession || agent.capabilities.resume))
      acpError("ACP_UNSUPPORTED");
    const bound = await ctx.db
      .query("acp_sessions")
      .withIndex("by_worker_and_sessionId", (q) =>
        q
          .eq("workspace", ctx.workspace._id)
          .eq("worker", args.worker)
          .eq("sessionId", args.sessionId),
      )
      .take(8);
    if (bound.some((session) => session.agentId === args.agentId)) acpError("ACP_SESSION_BOUND");
    const folders = await projectFolders(ctx, ctx.workspace._id);
    const chat = await insertAgentChat(ctx, {
      workspace: ctx.workspace._id,
      userId: ctx.identity._id,
      worker: args.worker,
      agentId: args.agentId,
      sessionId: args.sessionId,
      cwd: row.cwd,
      version: agent.version,
      title: row.title,
      updatedAt: row.updatedAt,
      project: folders.get(folderKey(row.worker, row.cwd)),
    });
    await ctx.db.patch(row._id, { chat });
    return chat;
  },
});

/** Agent-managed authentication only; terminal methods stay local to the Worker. */
export const Authenticate = ownedWorkspaceMutation({
  args: { worker: v.string(), agentId: v.string(), methodId: v.string(), clientId: v.string() },
  returns: v.id("acp_commands"),
  handler: async (ctx, args) => {
    await requireActiveWorkspaceWorker(
      args.worker,
      ctx.workspace._id,
      workspaceWorkerMetadata(ctx, ctx.workspace._id),
    );
    const agent = await findAgent(ctx, ctx.workspace._id, args.worker, args.agentId);
    if (
      !agent?.authMethods.some((method) => method.id === args.methodId && method.type === "agent")
    )
      acpError("ACP_UNSUPPORTED");
    return enqueue(
      ctx,
      { workspace: ctx.workspace._id, worker: args.worker },
      ctx.identity._id,
      { kind: "authenticate", agentId: args.agentId, methodId: args.methodId },
      undefined,
      args.clientId,
    );
  },
});

/** Owner-only logout when supported by the installed agent. */
export const Logout = ownedWorkspaceMutation({
  args: { worker: v.string(), agentId: v.string(), clientId: v.string() },
  returns: v.id("acp_commands"),
  handler: async (ctx, args) => {
    await requireActiveWorkspaceWorker(
      args.worker,
      ctx.workspace._id,
      workspaceWorkerMetadata(ctx, ctx.workspace._id),
    );
    const agent = await findAgent(ctx, ctx.workspace._id, args.worker, args.agentId);
    if (!agent?.capabilities.logout) acpError("ACP_UNSUPPORTED");
    return enqueue(
      ctx,
      { workspace: ctx.workspace._id, worker: args.worker },
      ctx.identity._id,
      { kind: "logout", agentId: args.agentId },
      undefined,
      args.clientId,
    );
  },
});

/** Transient command results are visible only to their issuer, never to workspace owners by default. */
export const GetCommand = query({
  args: { command: v.id("acp_commands") },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    const command = await ctx.db.get(args.command);
    if (!identity || !command || command.by !== identity._id) return null;
    return {
      kind: command.kind,
      status: command.status,
      ...(command.error !== undefined ? { error: command.error } : {}),
      ...(command.result !== undefined ? { result: command.result } : {}),
    };
  },
});

/**
 * Subscribe only while a Session is visible; this query wakes on each Worker heartbeat by design.
 * Identity metadata is workspace-scoped even when the viewer is a member rather than the owner.
 */
export const WorkerStatus = query({
  args: { chat: v.id("aisdk_chats") },
  returns: v.object({
    name: v.union(v.string(), v.null()),
    lastSeenAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const { session } = await accessibleSession(ctx, args.chat);
    const [worker, presence] = await Promise.all([
      ctx
        .runQuery(components.workerIdentity.identities.getWorkerMetadata, {
          workspaceId: session.workspace,
          workerId: session.worker,
        })
        // The component reports unknown and foreign-workspace identities as errors.
        .catch(() => null),
      findWorkerPresence(ctx, session.workspace, session.worker),
    ]);
    return {
      name: worker?.status === "active" ? worker.name : null,
      lastSeenAt: presence?.lastSeenAt ?? null,
    };
  },
});

/** Generate a fallback title from the first prompt without storing or logging conversation text. */
export const GenerateTitle = action({
  args: { chat: v.id("aisdk_chats"), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const chat = await ctx.runQuery(internal.chatroom.acpTitleGenerationInfo, {
      chatId: args.chat,
    });
    const text = args.text.trim().slice(0, 4000);
    if (!chat || !text) return null;

    try {
      const provider = createInternalGatewayProvider(
        ctx,
        chat.workspace,
        {},
        undefined,
        undefined,
        {
          userId: chat.userId,
          chatId: args.chat,
        },
      );
      const title = await generateChatTitle({
        model: provider(chat.model),
        initialUserMessage: text,
      });
      // Non-forced saving preserves an agent title or user rename that arrived during generation.
      await ctx.runMutation(internal.chatroom.saveGeneratedTitle, {
        chatId: args.chat,
        ...title,
      });
    } catch {
      // Provider errors can contain request/response bodies, so never log the error itself.
      console.error("Failed to generate ACP chat title.");
    }
    return null;
  },
});

/**
 * Quiet session metadata subscription; deliberately excludes Worker presence and viewer rows.
 * Before the ACP session exists, `defaultConfig` and `commands` come from the agent's last
 * advertised defaults, so draft choices can be shown and changed.
 */
export const GetSession = query({
  args: { chat: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const { session, agent } = await accessibleSession(ctx, args.chat);
    const report = await findAgent(ctx, session.workspace, session.worker, session.agentId);
    return {
      agent,
      ...(report
        ? {
            agentName: report.name,
            capabilities: report.capabilities,
            ...(report.icon ? { agentIcon: report.icon } : {}),
          }
        : {}),
      status: session.status,
      epoch: session.epoch,
      warm: session.warm,
      stopReason: session.stopReason,
      error: session.error,
      config: session.config,
      ...(!session.sessionId && report?.defaults?.config
        ? { defaultConfig: report.defaults.config }
        : {}),
      commands: session.commands ?? (session.sessionId ? undefined : report?.defaults?.commands),
      usage: session.usage,
      history: session.history,
      draft: session.draft,
    };
  },
});

/** Both pending questions and durable, not-yet-relayed answers remain visible. */
export const OpenInteractions = query({
  args: { chat: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    await accessibleSession(ctx, args.chat);
    const pending = await ctx.db
      .query("acp_interactions")
      .withIndex("by_chat_and_status", (q) => q.eq("chat", args.chat).eq("status", "pending"))
      .take(32);
    const answered = await ctx.db
      .query("acp_interactions")
      .withIndex("by_chat_and_status", (q) => q.eq("chat", args.chat).eq("status", "answered"))
      .take(32);
    return [...pending, ...answered]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({
        _id: row._id,
        kind: row.kind,
        request: row.request,
        status: row.status,
        createdAt: row.createdAt,
      }));
  },
});

/** Owner-only agent catalog for the Run target picker, bounded even across many Workers. */
export const ListAgents = ownedWorkspaceQuery({
  args: { worker: v.optional(v.string()) },
  handler: async (ctx, args) =>
    ctx.db
      .query("worker_agents")
      .withIndex("by_worker_and_agentId", (q) =>
        args.worker === undefined
          ? q.eq("workspace", ctx.workspace._id)
          : q.eq("workspace", ctx.workspace._id).eq("worker", args.worker),
      )
      .take(256),
});
