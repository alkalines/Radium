import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { acpGatewayProfileOffered } from "contracts/acp/gateway";
import { findWorkerGateway } from "../worker/gateway";
import { acpProfileValidator, type AcpProfile } from "contracts/acp/contract";
import { paginationOptsValidator } from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import schema from "../../convex/schema";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { isWorkerOnline } from "contracts/worker/presence";
import { query } from "../../convex/_generated/server";
import { action, mutation } from "../maintenance";
import { components, internal } from "../../convex/_generated/api";
import { createInternalGatewayProvider } from "../../convex/ai_gateway";
import { authComponent } from "../../convex/auth";
import { authorizeChatRecord } from "../../convex/workspaces";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../../convex/helpers";
import { requireWorkspaceProject } from "../projects/projects";
import { requireActiveWorkspaceWorker, validChatWorkerDirectory } from "contracts/worker/chat-config";
import {
  deriveChatWorkerDirectory,
  findWorkerPresence,
  workspaceWorkerMetadata,
} from "../worker/chat-selection";
import { generateChatTitle } from "../chatroom/titles";
import {
  ACP_AGENT_DEFINITIONS_MAX,
  ACP_BUSY_STATUSES,
  ACP_HISTORY_REQUEST_ITEMS,
  ACP_PROMPT_BYTES,
  ACP_SEALED_INTERACTION_BYTES,
  acpAnswerError,
  acpChatScopeValidator,
  acpInteractionAnswerValidator,
  acpPromptBlockValidator,
  acpSealedAnswerValidator,
  acpSealedBoxValidator,
  acpSignedBindingValidator,
  acpSignedCommandValidator,
  utf8Bytes,
  validAcpToken,
  type AcpCommandKind,
  type AcpCommandPayload,
  type AcpSignedCommand,
} from "contracts/acp/contract";
import {
  accessibleSession,
  acpError,
  admitWarm,
  assertRelayPlaintextAllowed,
  enqueue,
  enqueueSigned,
  existingCommand,
  findAgent,
  findSession,
  validateConfig,
  validateMode,
} from "./policy";
import {
  chatAudience,
  requireSealedBox,
  signedDispatch,
  verifyImportProof,
  verifyNextBinding,
  verifySignedCommand,
  verifyUserSignature,
  workspaceHasKeys,
} from "./sealed";
import { acpAnswerStatement } from "radium-crypto";
import {
  chatKeyIsStale,
  requireChatKeysForCreate,
  insertChatKeysSetup,
} from "../e2ee/chat-keys";
import { chatKeysSetupValidator, type ChatKeysSetup } from "../e2ee/workspace-contract";
import {
  assertLegacyPlaintextAllowed,
  assertLegacyWritesAllowed,
  legacyPlaintextAllowed,
} from "../e2ee/migration-contract";
import { certifiedWorkerKeys } from "../e2ee/worker-keys";
import { setChatMembers, touchChatMembers } from "../chatroom/members";
import { validateChatBox } from "../chatroom/sealing";
import { zodToConvex } from "../zod-validators";

/**
 * Shared atomic chat + lifecycle creation for new, forked and indexed agent sessions. With `keys`
 * the chat is encrypted from the start (its title can only be `sealedTitle`), like
 * `aisdk.CreateChat`'s `e2ee`; `members` are the picked recipients of a `shared` chat.
 */
async function insertAgentChat(
  ctx: MutationCtx,
  args: {
    workspace: Doc<"workspaces">;
    userId: string;
    worker: string;
    agentId: string;
    cwd: string;
    version: string;
    profile?: AcpProfile;
    scope?: "personal" | "shared" | "workspace";
    members?: string[];
    keys?: ChatKeysSetup;
    project?: Id<"projects">;
    sessionId?: string;
    title?: string;
    sealedTitle?: { epoch: number; box: ArrayBuffer };
    updatedAt?: number;
    status?: "idle" | "starting";
  },
) {
  const now = Date.now();
  const scope = args.scope ?? "personal";
  if (scope !== "shared" && args.members?.length) acpError("ACP_INVALID_SCOPE");
  if (args.sealedTitle) {
    if (!args.keys) acpError("ACP_E2EE_MODE");
    validateChatBox(args.sealedTitle, 1, 2048);
  }
  const plaintextTitle = !args.keys && (await legacyPlaintextAllowed(ctx));
  const chat = await ctx.db.insert("aisdk_chats", {
    workspace: args.workspace._id,
    userId: args.userId,
    scope,
    project: args.project,
    title: plaintextTitle ? args.title : undefined,
    sealedTitle: args.sealedTitle,
    agent: {
      kind: "acp",
      profile: args.profile ?? "native",
      worker: args.worker,
      agentId: args.agentId,
      agentVersion: args.version,
      cwd: args.cwd,
      sessionId: args.sessionId,
    },
    activeStream: false,
    lastInteractionAt: args.updatedAt ?? now,
  });
  const row = (await ctx.db.get(chat))!;
  await setChatMembers(ctx, row, args.members ?? []);
  if (args.keys) {
    await insertChatKeysSetup(ctx, {
      chat: row,
      workspace: args.workspace,
      members: args.members ?? [],
      keys: args.keys,
    });
  }
  await ctx.db.insert("acp_sessions", {
    chat,
    workspace: args.workspace._id,
    worker: args.worker,
    agentId: args.agentId,
    profile: args.profile ?? "native",
    cwd: args.cwd,
    sessionId: args.sessionId,
    status: args.status ?? "idle",
    epoch: 0,
    warm: false,
    history: "none",
    updatedAt: now,
  });
  return chat;
}

/**
 * Queue one session-level command in the chat's dispatch mode. Signed mode (keyed workspace,
 * certified Worker) needs the creator's binding and a command its caller sealed and signed; the
 * plaintext `payload` is the keyless-workspace path. `clientId`, when given, must be the signed one.
 */
async function dispatchCommand(
  ctx: MutationCtx,
  input: {
    signedMode: boolean;
    session: Doc<"acp_sessions">;
    chat: Doc<"aisdk_chats">;
    userId: string;
    kind: AcpCommandKind;
    payload?: AcpCommandPayload;
    signed?: AcpSignedCommand;
    clientId?: string;
  },
) {
  const { session } = input;
  const binding = { workspace: session.workspace, worker: session.worker };
  if (input.signedMode) {
    if (!input.signed || (input.clientId !== undefined && input.signed.clientId !== input.clientId))
      acpError("ACP_SIGNATURE_REQUIRED");
    // A paired Worker executes nothing for a chat its creator has not bound and signed.
    if (!input.chat.e2eeId || !session.binding) acpError("ACP_BINDING_REQUIRED");
    await verifySignedCommand(ctx, {
      ...binding,
      chat: session.chat,
      kind: input.kind,
      userId: input.userId,
      signed: input.signed,
    });
    return enqueueSigned(
      ctx,
      binding,
      input.userId,
      { kind: input.kind, signed: input.signed },
      session.chat,
    );
  }
  if (input.signed || !input.payload) acpError("ACP_E2EE_MODE");
  return enqueue(ctx, binding, input.userId, input.payload, session.chat, input.clientId);
}

/** A directory without trailing separators; the root keeps its own. */
function bareDirectory(directory: string) {
  return directory.replace(/[\\/]+$/, "") || directory;
}

/**
 * Matches an agent session's `cwd` to a Project folder on the same Worker. Agents report a
 * directory without its trailing separator while a Project folder may keep one, so neither counts.
 */
export function folderKey(worker: string, directory: string) {
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
export async function projectFolders(ctx: QueryCtx | MutationCtx, workspace: Id<"workspaces">) {
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
    sealedTitle: row.sealedTitle,
    legacyContent: row.legacyContent,
    updatedAt: row.updatedAt,
    chat: row.chat ?? null,
    project,
  };
}

/** Index rows linked to a chat the caller cannot see (another member's personal chat) are hidden. */
async function visibleIndexRows(ctx: QueryCtx, userId: string, rows: Doc<"acp_agent_sessions">[]) {
  const visible = await Promise.all(
    rows.map(
      async (row) =>
        !row.chat ||
        !(await ctx.db.get(row.chat)) ||
        (await authorizeChatRecord(ctx, row.chat, userId)) !== null,
    ),
  );
  return rows.filter((_, index) => visible[index]);
}

/**
 * Owner-selected immutable binding; every creation starts a new agent session. In a keyed workspace
 * (`requireDispatchableWorker`) the chat must be created with chat keys (`e2ee`, as
 * `aisdk.CreateChat`); the creator then signs and publishes its binding (`PublishBinding`) before
 * any command. `shared` chats name their `members`.
 */
export const CreateSession = ownedWorkspaceMutation({
  args: {
    scope: v.optional(zodToConvex(acpChatScopeValidator)),
    members: v.optional(v.array(v.string())),
    project: v.optional(v.id("projects")),
    worker: v.string(),
    agentId: v.string(),
    cwd: v.optional(v.string()),
    profile: v.optional(zodToConvex(acpProfileValidator)),
    e2ee: v.optional(v.object({ keys: chatKeysSetupValidator })),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args) => {
    await requireActiveWorkspaceWorker(
      args.worker,
      ctx.workspace._id,
      workspaceWorkerMetadata(ctx, ctx.workspace._id),
    );
    const scope = args.scope ?? "personal";
    await requireChatKeysForCreate(ctx, {
      userId: ctx.identity._id,
      workspace: ctx.workspace,
      scope,
      hasKeys: !!args.e2ee,
    });
    if ((await signedDispatch(ctx, ctx.workspace._id, args.worker)) && !args.e2ee)
      acpError("ACP_E2EE_REQUIRED");
    if (args.project) await requireWorkspaceProject(ctx, args.project, ctx.workspace._id);
    if (args.profile === "gateway") {
      const definition = await ctx.db
        .query("acp_agents")
        .withIndex("by_workspace_and_agentId", (q) =>
          q.eq("workspace", ctx.workspace._id).eq("agentId", args.agentId),
        )
        .unique();
      const gateway = await findWorkerGateway(ctx, ctx.workspace._id, args.worker);
      if (!definition || !acpGatewayProfileOffered(definition))
        throw new ConvexError({
          code: "ACP_GATEWAY_UNAVAILABLE",
          message: "This agent does not offer a Gateway profile.",
        });
      if (gateway?.access !== "active")
        throw new ConvexError({
          code: "ACP_GATEWAY_UNAVAILABLE",
          message: "Gateway access is not active on this Worker.",
        });
    }
    const agent = await findAgent(ctx, ctx.workspace._id, args.worker, args.agentId);
    if (!agent || (agent.status !== "ready" && agent.status !== "needs_auth"))
      acpError("ACP_AGENT_UNAVAILABLE");
    const cwd =
      args.cwd ??
      (await deriveChatWorkerDirectory(ctx, ctx.workspace._id, args.worker, args.project));
    if (!cwd || !validChatWorkerDirectory(cwd)) acpError("ACP_INVALID_CWD");
    return insertAgentChat(ctx, {
      workspace: ctx.workspace,
      userId: ctx.identity._id,
      worker: args.worker,
      agentId: args.agentId,
      cwd,
      version: agent.version,
      profile: args.profile ?? "native",
      scope,
      members: args.members,
      keys: args.e2ee?.keys,
      project: args.project,
    });
  },
});

/**
 * The creator signs the chat's binding (`acpBindingStatement`): at creation, to repair a legacy
 * chat once it has keys, and again with a higher version on every audience change
 * (`aisdk.SetChatScope`). A session id bound without a Worker proof (an imported or legacy session)
 * needs the workspace owner's `importProof`.
 */
export const PublishBinding = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    binding: zodToConvex(acpSignedBindingValidator),
    importProof: v.optional(v.object({ signerKeyId: v.string(), signature: v.bytes() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const { chat, session, userId, workspace } = await accessibleSession(ctx, args.chat);
    if (chat.userId !== userId) acpError("ACP_DENIED");
    await verifyNextBinding(ctx, {
      session,
      chat,
      ...(await chatAudience(ctx, chat)),
      binding: args.binding,
    });
    const patch: Partial<Doc<"acp_sessions">> = { binding: args.binding, updatedAt: Date.now() };
    if (session.sessionId && !session.sessionProof) {
      if (!args.importProof) acpError("ACP_SESSION_PROOF_REQUIRED");
      await verifyImportProof(ctx, {
        session,
        ownerId: workspace.ownerId,
        proof: args.importProof,
      });
      patch.sessionProof = { kind: "import", ...args.importProof };
    }
    await ctx.db.patch(session._id, patch);
    return null;
  },
});

/**
 * Admit exactly one prompt at a time, with worker-scoped retry keys. Signed mode sends only the
 * sealed command (`signed`, whose clientId is `clientId`); the prompt text never reaches Convex.
 */
export const Prompt = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    prompt: v.optional(v.array(zodToConvex(acpPromptBlockValidator))),
    clientId: v.string(),
    signed: v.optional(zodToConvex(acpSignedCommandValidator)),
  },
  returns: v.id("acp_commands"),
  handler: async (ctx, args) => {
    // Signed commands are frozen too: admitting one makes the session busy and blocks sealing its rows.
    await assertLegacyWritesAllowed(ctx);
    const { session, userId, chat } = await accessibleSession(ctx, args.chat);
    if (session.profile === "gateway") {
      const gateway = await findWorkerGateway(ctx, session.workspace, session.worker);
      if (gateway?.access !== "active")
        throw new ConvexError({
          code: "ACP_GATEWAY_KEY_MISSING",
          message:
            !gateway || gateway.access === "off"
              ? "Gateway access is off on this Worker."
              : "This Worker's Gateway key was deleted. The workspace owner must issue a new key in Settings → Workers.",
        });
    }
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
      args.prompt &&
      (!args.prompt.length ||
        !args.prompt.some((block) => block.type !== "text" || block.text.trim()) ||
        utf8Bytes(JSON.stringify(args.prompt)) > ACP_PROMPT_BYTES)
    )
      acpError("ACP_INVALID_PROMPT");
    const signedMode = await signedDispatch(ctx, session.workspace, session.worker);
    // The prompt text itself must never reach Convex for a paired Worker.
    if (signedMode && args.prompt) acpError("ACP_E2EE_MODE");
    const command = await dispatchCommand(ctx, {
      signedMode,
      session,
      chat,
      userId,
      kind: "prompt",
      payload: args.prompt ? { kind: "prompt", prompt: args.prompt } : undefined,
      signed: args.signed,
      clientId: args.clientId,
    });
    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: "starting",
      turnBy: userId,
      stopReason: undefined,
      error: undefined,
      sealedError: undefined,
      updatedAt: now,
      ...(await admitWarm(ctx, session, now)),
    });
    await ctx.db.patch(chat._id, { lastInteractionAt: now, interruption: undefined });
    await touchChatMembers(ctx, chat._id, now);
    return command;
  },
});

/**
 * Cancel unclaimed intent locally; otherwise send one cancellation to the live agent. Signed mode
 * callers always pass a signed `cancel`; it is used only when a command must be queued.
 */
export const Cancel = mutation({
  args: { chat: v.id("aisdk_chats"), signed: v.optional(zodToConvex(acpSignedCommandValidator)) },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Cancelling rewrites a command and its session, so it is frozen with every other writer.
    await assertLegacyWritesAllowed(ctx);
    const { session, userId, chat } = await accessibleSession(ctx, args.chat);
    const prompts = await ctx.db
      .query("acp_commands")
      .withIndex("by_chat_and_status", (q) => q.eq("chat", args.chat).eq("status", "pending"))
      .filter((q) => q.eq(q.field("kind"), "prompt"))
      .take(1);
    if (prompts.length) {
      await ctx.db.patch(prompts[0]!._id, {
        status: "failed",
        // A fixed code, never free text: verification must be able to reach zero plaintext after cutover.
        error: "ACP_CANCELLED",
        payload: undefined,
        signed: undefined,
        finishedAt: Date.now(),
      });
      const now = Date.now();
      await ctx.db.patch(session._id, {
        status: "idle",
        stopReason: "cancelled",
        updatedAt: now,
      });
      await ctx.db.patch(args.chat, {
        activeStream: false,
        lastInteractionAt: now,
        interruption: { kind: "interrupted" },
      });
      await touchChatMembers(ctx, args.chat, now);
    } else if (ACP_BUSY_STATUSES.includes(session.status)) {
      const pending = await ctx.db
        .query("acp_commands")
        .withIndex("by_chat_and_status", (q) => q.eq("chat", args.chat).eq("status", "pending"))
        .filter((q) => q.eq(q.field("kind"), "cancel"))
        .take(1);
      if (!pending.length)
        await dispatchCommand(ctx, {
          signedMode: await signedDispatch(ctx, session.workspace, session.worker),
          session,
          chat,
          userId,
          kind: "cancel",
          payload: { kind: "cancel" },
          signed: args.signed,
        });
    }
    return null;
  },
});

/**
 * The first prompt's claim hands the draft to the Worker; until the session id is bound, later
 * choices still update the draft but must also travel as live commands or they would be lost.
 */
async function promptClaimed(ctx: MutationCtx, chat: Id<"aisdk_chats">) {
  const claimed = await ctx.db
    .query("acp_commands")
    .withIndex("by_chat_and_status", (q) => q.eq("chat", chat).eq("status", "claimed"))
    .filter((q) => q.eq(q.field("kind"), "prompt"))
    .first();
  return claimed !== null;
}

/**
 * Keyless workspaces retain pre-session draft metadata. In keyed workspaces the choice travels
 * only in the signed sealed command; Convex cannot inspect or validate its contents.
 */
export const SetConfig = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    configId: v.optional(v.string()),
    value: v.optional(v.union(v.string(), v.boolean())),
    signed: v.optional(zodToConvex(acpSignedCommandValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const { session, userId, chat } = await accessibleSession(ctx, args.chat);
    if (session.status === "ended") acpError("ACP_SESSION_ENDED");
    const signedMode = await signedDispatch(ctx, session.workspace, session.worker);
    if (signedMode) {
      if (args.configId !== undefined || args.value !== undefined) acpError("ACP_E2EE_MODE");
    } else {
      if (args.configId === undefined || args.value === undefined) acpError("ACP_INVALID_CONFIG");
      if (!session.sessionId) {
        await assertRelayPlaintextAllowed(ctx, session);
        const agent = await findAgent(ctx, session.workspace, session.worker, session.agentId);
        validateConfig(agent?.defaults?.config, args.configId, args.value);
        const draft = session.draft ?? { config: [] };
        const config = draft.config.filter((option) => option.configId !== args.configId);
        config.push({ configId: args.configId, value: args.value });
        await ctx.db.patch(session._id, { draft: { ...draft, config }, updatedAt: Date.now() });
        if (!(await promptClaimed(ctx, args.chat))) return null;
      } else {
        if (!session.config) acpError("ACP_INVALID_CONFIG");
        validateConfig(session.config, args.configId, args.value);
      }
    }
    await dispatchCommand(ctx, {
      signedMode,
      session,
      chat,
      userId,
      kind: "set_config",
      payload: args.configId !== undefined && args.value !== undefined
        ? { kind: "set_config", configId: args.configId, value: args.value }
        : undefined,
      signed: args.signed,
    });
    return null;
  },
});

/** Choose an advertised mode, either in the draft or through a live command (see `SetConfig`). */
export const SetMode = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    modeId: v.optional(v.string()),
    signed: v.optional(zodToConvex(acpSignedCommandValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const { session, userId, chat } = await accessibleSession(ctx, args.chat);
    if (session.status === "ended") acpError("ACP_SESSION_ENDED");
    const signedMode = await signedDispatch(ctx, session.workspace, session.worker);
    if (signedMode) {
      if (args.modeId !== undefined) acpError("ACP_E2EE_MODE");
    } else {
      if (args.modeId === undefined) acpError("ACP_INVALID_MODE");
      if (!session.sessionId) {
        await assertRelayPlaintextAllowed(ctx, session);
        const agent = await findAgent(ctx, session.workspace, session.worker, session.agentId);
        validateMode(agent?.defaults?.config, args.modeId);
        await ctx.db.patch(session._id, {
          draft: { ...(session.draft ?? { config: [] }), modeId: args.modeId },
          updatedAt: Date.now(),
        });
        if (!(await promptClaimed(ctx, args.chat))) return null;
      } else {
        if (!session.config) acpError("ACP_INVALID_MODE");
        validateMode(session.config, args.modeId);
      }
    }
    await dispatchCommand(ctx, {
      signedMode,
      session,
      chat,
      userId,
      kind: "set_mode",
      payload: args.modeId !== undefined ? { kind: "set_mode", modeId: args.modeId } : undefined,
      signed: args.signed,
    });
    return null;
  },
});

/**
 * First visible user's decision wins; another user's private chat is never exposed. A sealed
 * request (keyed workspace) takes a `sealed` answer Convex cannot validate: it checks only that the
 * caller signed it, and the Worker re-opens the interaction when the answer is not valid.
 */
export const Answer = mutation({
  args: {
    interaction: v.id("acp_interactions"),
    answer: v.optional(zodToConvex(acpInteractionAnswerValidator)),
    sealed: v.optional(zodToConvex(acpSealedAnswerValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const row = await ctx.db.get(args.interaction);
    if (!row) acpError("ACP_INTERACTION_CLOSED");
    const { userId } = await accessibleSession(ctx, row.chat);
    if (row.status !== "pending") acpError("ACP_INTERACTION_CLOSED");
    if (row.sealedRequest) {
      if (!args.sealed || args.answer) acpError("ACP_E2EE_MODE");
      requireSealedBox(args.sealed.answer, ACP_SEALED_INTERACTION_BYTES);
      await verifyUserSignature(ctx, {
        userId,
        signerKeyId: args.sealed.signerKeyId,
        signature: args.sealed.signature,
        message: acpAnswerStatement({
          workspaceId: row.workspace,
          workerId: row.worker,
          chatId: row.chat,
          requestKey: row.requestKey,
          answer: new Uint8Array(args.sealed.answer),
        }),
      });
      await ctx.db.patch(row._id, {
        status: "answered",
        sealedAnswer: args.sealed,
        answeredBy: userId,
        answeredAt: Date.now(),
      });
      return null;
    }
    // Plaintext answers are a legacy writer: closed by the freeze and permanently after cutover.
    await assertLegacyPlaintextAllowed(ctx);
    if (!row.request || !args.answer || args.sealed) acpError("ACP_E2EE_MODE");
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

/**
 * History pages are shared within a warm epoch, so duplicate page requests share an unfinished
 * command; a retry after it finished or failed asks the Worker again. A signed request's clientId
 * must start with the page key `history:${chat}:${epoch}:${before}:`.
 */
export const RequestHistory = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    epoch: v.number(),
    before: v.number(),
    limit: v.number(),
    signed: v.optional(zodToConvex(acpSignedCommandValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const { session, userId, chat } = await accessibleSession(ctx, args.chat);
    if (!session.warm || args.epoch !== session.epoch) return null;
    // Dedupe keys are Worker-scoped, so the chat must be part of the page's key.
    const page = `history:${args.chat}:${args.epoch}:${args.before}`;
    for (const status of ["pending", "claimed"] as const) {
      const active = await ctx.db
        .query("acp_commands")
        .withIndex("by_chat_and_status", (q) => q.eq("chat", args.chat).eq("status", status))
        .filter((q) => q.eq(q.field("kind"), "history"))
        .take(32);
      if (active.some((row) => row.clientId.startsWith(`${page}:`))) return null;
    }
    if (args.signed && !args.signed.clientId.startsWith(`${page}:`))
      acpError("ACP_INVALID_CLIENT_ID");
    await dispatchCommand(ctx, {
      signedMode: await signedDispatch(ctx, session.workspace, session.worker),
      session,
      chat,
      userId,
      kind: "history",
      payload: {
        kind: "history",
        epoch: args.epoch,
        before: args.before,
        limit: Math.min(ACP_HISTORY_REQUEST_ITEMS, Math.max(1, Math.floor(args.limit))),
      },
      signed: args.signed,
      clientId: args.signed?.clientId ?? `${page}:${crypto.randomUUID()}`,
    });
    return null;
  },
});

/**
 * Latest-point fork preserves binding and scope but grants ownership of the new chat to its caller.
 * Signed mode is two steps, since the fork command names the new chat: this creates the target with
 * chat keys (`e2ee`; `members` for a shared source), then `StartFork` publishes its binding and
 * queues the signed command.
 */
export const Fork = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    clientId: v.string(),
    e2ee: v.optional(
      v.object({ keys: chatKeysSetupValidator, members: v.optional(v.array(v.string())) }),
    ),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const { session, chat, userId, agent, workspace } = await accessibleSession(ctx, args.chat);
    const signedMode = await signedDispatch(ctx, session.workspace, session.worker);
    if (!signedMode) {
      if (args.e2ee) acpError("ACP_E2EE_MODE");
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
    }
    const report = await findAgent(ctx, session.workspace, session.worker, session.agentId);
    if (!report?.capabilities.fork || !session.sessionId) acpError("ACP_UNSUPPORTED");
    if (ACP_BUSY_STATUSES.includes(session.status)) acpError("ACP_SESSION_BUSY");
    if (signedMode) {
      if (!args.e2ee || !session.binding) acpError("ACP_BINDING_REQUIRED");
      return insertAgentChat(ctx, {
        workspace,
        userId,
        worker: session.worker,
        agentId: session.agentId,
        cwd: session.cwd,
        version: agent.agentVersion,
        profile: session.profile ?? "native",
        scope: chat.scope ?? "personal",
        members: args.e2ee.members,
        keys: args.e2ee.keys,
        project: chat.project,
        status: "starting",
      });
    }
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
      profile: session.profile ?? "native",
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

/**
 * Second step of a signed fork: the caller (the target's creator) publishes the target's binding
 * (version 1) and queues the signed `fork` command, whose statement names the source chat. Retrying
 * with the same command is a no-op.
 */
export const StartFork = mutation({
  args: {
    chat: v.id("aisdk_chats"),
    target: v.id("aisdk_chats"),
    binding: zodToConvex(acpSignedBindingValidator),
    signed: zodToConvex(acpSignedCommandValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const { session, userId, chat } = await accessibleSession(ctx, args.chat);
    const existing = await existingCommand(
      ctx,
      session.workspace,
      session.worker,
      args.signed.clientId,
      userId,
    );
    if (existing) return null;
    const target = await accessibleSession(ctx, args.target);
    if (
      target.chat.userId !== userId ||
      target.session.sessionId ||
      target.session.worker !== session.worker ||
      target.session.workspace !== session.workspace ||
      !session.sessionId ||
      !session.binding
    )
      acpError("ACP_INVALID_BINDING");
    await verifyNextBinding(ctx, {
      session: target.session,
      chat: target.chat,
      ...(await chatAudience(ctx, target.chat)),
      binding: args.binding,
    });
    await ctx.db.patch(target.session._id, { binding: args.binding, updatedAt: Date.now() });
    const command = await dispatchCommand(ctx, {
      signedMode: await signedDispatch(ctx, session.workspace, session.worker),
      session,
      chat,
      userId,
      kind: "fork",
      signed: args.signed,
    });
    // The receipt lets Worker recovery find the target once the payload is gone.
    await ctx.db.patch(command, { result: args.target });
    return null;
  },
});

/**
 * Fallback title of an encrypted ACP chat, which the browser derives from the first prompt and
 * seals itself (the server never sees the prompt). Ignored once the chat has any title.
 */
export const SetFallbackTitle = mutation({
  args: { chat: v.id("aisdk_chats"), sealedTitle: zodToConvex(acpSealedBoxValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLegacyWritesAllowed(ctx);
    const { chat, session, workspace } = await accessibleSession(ctx, args.chat);
    // A stale epoch (revoked reader or rotated workspace key) must be replaced before new sealing.
    if (!chat.e2eeId || !chat.keyEpoch || (await chatKeyIsStale(ctx, chat, workspace)))
      acpError("ACP_E2EE_MODE");
    // A sidecar title is the chat's historical title; a prompt-derived fallback must not replace it.
    if (chat.sealedTitle || chat.title || chat.legacyContent || session.userTitled) return null;
    validateChatBox(args.sealedTitle, chat.keyEpoch, 2048);
    await ctx.db.patch(chat._id, { sealedTitle: args.sealedTitle });
    return null;
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
      page: (await visibleIndexRows(ctx, ctx.identity._id, page.page)).map((row) =>
        indexedSessionRow(row, folders.get(folderKey(row.worker, row.cwd)) ?? null),
      ),
    };
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

/**
 * Safe on every Home open: online-only, coalesced intent and a one-minute freshness window. In a
 * keyed workspace each certified Worker needs its own owner-signed `sync_sessions` command
 * (`signed`, by Worker); Workers without one, or not certified, are skipped.
 */
export const SyncAgentSessions = ownedWorkspaceMutation({
  args: {
    agentId: v.string(),
    signed: v.optional(
      v.array(v.object({ worker: v.string(), ...zodToConvex(acpSignedCommandValidator).fields })),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const keyed = await workspaceHasKeys(ctx, ctx.workspace._id);
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
      const signedEntry = args.signed?.find((entry) => entry.worker === agent.worker);
      if (keyed) {
        if (!signedEntry) continue;
        if (!(await certifiedWorkerKeys(ctx, ctx.workspace._id, agent.worker))) continue;
      }
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
      const binding = { workspace: ctx.workspace._id, worker: agent.worker };
      if (keyed && signedEntry) {
        const { worker: _, ...signed } = signedEntry;
        await verifySignedCommand(ctx, {
          ...binding,
          chat: "",
          kind: "sync_sessions",
          userId: ctx.identity._id,
          signed,
        });
        await enqueueSigned(ctx, binding, ctx.identity._id, {
          kind: "sync_sessions",
          signed,
          agentId: args.agentId,
        });
      } else {
        await enqueue(ctx, binding, ctx.identity._id, {
          kind: "sync_sessions",
          agentId: args.agentId,
        });
      }
    }
    return null;
  },
});

/**
 * Open an indexed session even while offline; the immutable binding reopens when it reconnects.
 * In a keyed workspace the owner's browser creates chat keys (`e2ee`) and seals the decrypted index
 * title to them, then publishes the binding with its import proof (`PublishBinding`).
 */
export const OpenAgentSession = ownedWorkspaceMutation({
  args: {
    worker: v.string(),
    agentId: v.string(),
    sessionId: v.string(),
    e2ee: v.optional(
      v.object({ keys: chatKeysSetupValidator, sealedTitle: v.optional(zodToConvex(acpSealedBoxValidator)) }),
    ),
  },
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
    await requireChatKeysForCreate(ctx, {
      userId: ctx.identity._id,
      workspace: ctx.workspace,
      scope: "personal",
      hasKeys: !!args.e2ee,
    });
    if ((await signedDispatch(ctx, ctx.workspace._id, args.worker)) && !args.e2ee)
      acpError("ACP_E2EE_REQUIRED");
    const agent = await findAgent(ctx, ctx.workspace._id, args.worker, args.agentId);
    // No report: the Worker has not launched the agent (for a paired Worker, often an unreviewed
    // definition), which is not the same as an agent that cannot reopen sessions.
    if (!agent) acpError("ACP_AGENT_UNAVAILABLE");
    if (!(agent.capabilities.loadSession || agent.capabilities.resume)) acpError("ACP_UNSUPPORTED");
    const bound = await ctx.db
      .query("acp_sessions")
      .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
        q
          .eq("workspace", ctx.workspace._id)
          .eq("worker", args.worker)
          .eq("agentId", args.agentId)
          .eq("sessionId", args.sessionId),
      )
      .first();
    if (bound) acpError("ACP_SESSION_BOUND");
    const folders = await projectFolders(ctx, ctx.workspace._id);
    const chat = await insertAgentChat(ctx, {
      workspace: ctx.workspace,
      userId: ctx.identity._id,
      worker: args.worker,
      agentId: args.agentId,
      sessionId: args.sessionId,
      cwd: row.cwd,
      version: agent.version,
      title: row.title,
      keys: args.e2ee?.keys,
      sealedTitle: args.e2ee?.sealedTitle,
      updatedAt: row.updatedAt,
      project: folders.get(folderKey(row.worker, row.cwd)),
    });
    await ctx.db.patch(row._id, { chat });
    return chat;
  },
});

/** Queue an owner-only agent-level command in the Worker's dispatch mode (`chat` is `""`). */
async function dispatchAgentCommand(
  ctx: MutationCtx,
  input: {
    workspace: Id<"workspaces">;
    worker: string;
    userId: string;
    payload: Extract<AcpCommandPayload, { kind: "authenticate" | "logout" }>;
    clientId: string;
    signed?: AcpSignedCommand;
  },
) {
  const binding = { workspace: input.workspace, worker: input.worker };
  if (await signedDispatch(ctx, input.workspace, input.worker)) {
    if (!input.signed || input.signed.clientId !== input.clientId)
      acpError("ACP_SIGNATURE_REQUIRED");
    await verifySignedCommand(ctx, {
      ...binding,
      chat: "",
      kind: input.payload.kind,
      userId: input.userId,
      signed: input.signed,
    });
    return enqueueSigned(ctx, binding, input.userId, {
      kind: input.payload.kind,
      signed: input.signed,
      agentId: input.payload.agentId,
    });
  }
  if (input.signed) acpError("ACP_E2EE_MODE");
  return enqueue(ctx, binding, input.userId, input.payload, undefined, input.clientId);
}

/** Agent-managed authentication only; terminal methods stay local to the Worker. */
export const Authenticate = ownedWorkspaceMutation({
  args: {
    worker: v.string(),
    agentId: v.string(),
    methodId: v.string(),
    clientId: v.string(),
    signed: v.optional(zodToConvex(acpSignedCommandValidator)),
  },
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
    return dispatchAgentCommand(ctx, {
      workspace: ctx.workspace._id,
      worker: args.worker,
      userId: ctx.identity._id,
      payload: { kind: "authenticate", agentId: args.agentId, methodId: args.methodId },
      clientId: args.clientId,
      signed: args.signed,
    });
  },
});

/** Owner-only logout when supported by the installed agent. */
export const Logout = ownedWorkspaceMutation({
  args: {
    worker: v.string(),
    agentId: v.string(),
    clientId: v.string(),
    signed: v.optional(zodToConvex(acpSignedCommandValidator)),
  },
  returns: v.id("acp_commands"),
  handler: async (ctx, args) => {
    await requireActiveWorkspaceWorker(
      args.worker,
      ctx.workspace._id,
      workspaceWorkerMetadata(ctx, ctx.workspace._id),
    );
    const agent = await findAgent(ctx, ctx.workspace._id, args.worker, args.agentId);
    if (!agent?.capabilities.logout) acpError("ACP_UNSUPPORTED");
    return dispatchAgentCommand(ctx, {
      workspace: ctx.workspace._id,
      worker: args.worker,
      userId: ctx.identity._id,
      payload: { kind: "logout", agentId: args.agentId },
      clientId: args.clientId,
      signed: args.signed,
    });
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
      _id: command._id,
      workspace: command.workspace,
      chat: command.chat,
      legacyContent: command.legacyContent,
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
 * advertised defaults, so draft choices can be shown and changed. `signed` tells the client to
 * seal and sign every command; `binding` is the published audience (null: the creator must
 * publish one first); `sealedError` replaces the generic `error` text for keyed chats.
 */
export const GetSession = query({
  args: { chat: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const { session, agent, chat } = await accessibleSession(ctx, args.chat);
    const report = await findAgent(ctx, session.workspace, session.worker, session.agentId);
    return {
      agent,
      _id: session._id,
      legacyContent: session.legacyContent,
      workspace: session.workspace,
      profile: session.profile ?? "native",
      gateway:
        session.profile === "gateway"
          ? {
              access:
                (await findWorkerGateway(ctx, session.workspace, session.worker))?.access ?? "off",
            }
          : null,
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
      sealedError: session.sealedError ?? null,
      signed: await workspaceHasKeys(ctx, session.workspace),
      e2eeId: chat.e2eeId ?? null,
      binding: session.binding
        ? {
            version: session.binding.version,
            scope: session.binding.scope,
            members: session.binding.members,
          }
        : null,
      config: session.config,
      // Native process defaults cannot describe the Gateway process's model choices.
      ...(session.profile !== "gateway" && report?.defaults?.config
        ? { defaultConfig: report.defaults.config }
        : {}),
      commands: session.commands ?? (session.sessionId ? undefined : report?.defaults?.commands),
      usage: session.usage,
      turnUsage: session.turnUsage,
      history: session.history,
      draft: session.draft,
    };
  },
});

/**
 * Both pending questions and durable, not-yet-relayed answers remain visible. Keyed workspaces
 * return the Worker-sealed request (`sealed`), which clients verify against the roster first.
 */
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
        requestKey: row.requestKey,
        ...(row.request ? { request: row.request } : {}),
        ...(row.sealedRequest ? { sealed: row.sealedRequest } : {}),
        status: row.status,
        createdAt: row.createdAt,
      }));
  },
});

/** The Worker-signed capsule of one stream epoch (keyed chats), for viewers to open frames. */
export const StreamCapsule = query({
  args: { chat: v.id("aisdk_chats"), epoch: v.number() },
  handler: async (ctx, args) => {
    await accessibleSession(ctx, args.chat);
    const stream = await ctx.db
      .query("acp_streams")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", args.chat).eq("epoch", args.epoch))
      .first();
    return stream?.capsule ?? null;
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
