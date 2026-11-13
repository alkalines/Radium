import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { authComponent } from "./auth";
import { messageSchema, queuedMessageSchema } from "./aisdk_schemas";
import { internal } from "./_generated/api";
import { requireAccessibleChat, requireChatManager, resolveWorkspaceForChat } from "./workspaces";
import { workspaceMutation, workspaceQuery } from "./helpers";
import { firstUserMessageText } from "@/chatroom/titles";
import {
  cleanupChatContent,
  insertChatMessages,
  saveSealedChatMessages,
  loadFirstUserMessage,
  saveChatMessages,
} from "../src/chatroom/messages";
import { linkChatFiles, storedFileUrls } from "../src/chatroom/files";
import { canManageChat } from "../src/workspaces/policy";
import { chatWorkerSelectionValidator, type ChatWorkerSelection } from "../src/worker/chat-config";
import {
  rederiveChatWorkerDirectory,
  resolveChatWorkerSelection,
} from "../src/worker/chat-selection";
import { requireWorkspaceProject } from "../src/projects/projects";
import { storedSelection, toolSelectionValidator } from "../src/chatroom/tool-selection";
import { chatInterruptionValidator } from "../src/chatroom/interruption";
import { findSession, requireChatActor } from "../src/acp/policy";
import { queueChatDeletion } from "../src/acp/retention";
import {
  activeIdentityFor,
  chatKeyInputValidator,
  chatKeysSetupValidator,
  wrapInputValidator,
} from "../src/e2ee/workspace-contract";
import {
  chatKeyIsStale,
  currentChatPublicKey,
  insertChatKeysSetup,
  newestWorkspaceWrap,
  requireChatKeysForCreate,
} from "../src/e2ee/chat-keys";
import { setChatMembers, touchChatMembers } from "../src/chatroom/members";
import {
  chatCapsuleValidator,
  invalidSealedContent,
  sealedBoxValidator,
  sealedWritesValidator,
  sealChatTitle,
  validateChatBox,
  validateChatCapsule,
  validateMessageEnvelope,
  validatePlaintextAttachments,
} from "../src/chatroom/sealing";
import { generateChatTitle } from "../src/chatroom/titles";
import { createInternalGatewayProvider } from "./ai_gateway";
import { changeChatScope } from "../src/e2ee/chat-scope";

const chatScopeValidator = v.union(
  v.literal("personal"),
  v.literal("shared"),
  v.literal("workspace"),
);
// A Home page never scans more than this many chats, whatever its filters skip.
const CHAT_PAGE_MAX_ROWS_READ = 400;
// Pinned chats sort first however old they are, so they are read apart from the pages.
const MAX_PINNED_CANDIDATES = 100;
// Legacy balance-only chats have no workspace index; keep the wider pre-split window for them.
const MAX_LEGACY_CANDIDATES = 100;

/** Registered for `DeleteChat`; implementation in src/chatroom/messages.ts. */
export { cleanupChatContent };

// Mutation
/**
 * Create a private-by-default chat and schedule title generation from its queued prompt.
 * `project` must belong to the same workspace. `tools` becomes the chat's per-chat tool override
 * after sanitizing, so a draft's tool choices never write workspace defaults. `worker` is
 * owner-only; its `directory` is ignored and derived from the Project folder or the Worker's
 * reported temp directory.
 */
export const CreateChat = workspaceMutation({
  args: {
    scope: v.optional(chatScopeValidator),
    messages_queue: v.optional(queuedMessageSchema),
    members: v.optional(v.array(v.string())),
    e2ee: v.optional(
      v.object({
        keys: chatKeysSetupValidator,
        sealedQueue: sealedBoxValidator,
        fileUrls: v.array(v.string()),
      }),
    ),
    worker: v.optional(chatWorkerSelectionValidator),
    project: v.optional(v.id("projects")),
    tools: v.optional(toolSelectionValidator),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args): Promise<Id<"aisdk_chats">> => {
    const scope = args.scope ?? "personal";
    await requireChatKeysForCreate(ctx, {
      userId: ctx.identity._id,
      workspace: ctx.workspace,
      scope,
      hasKeys: !!args.e2ee,
    });
    // A keyed chat's queued prompt must never take the plaintext storage/scheduler path.
    if (args.e2ee ? args.messages_queue !== undefined : !args.messages_queue) {
      invalidSealedContent();
    }
    if (scope !== "shared" && args.members !== undefined) {
      invalidSealedContent();
    }
    if (args.e2ee) {
      validateChatBox(args.e2ee.sealedQueue, 1, 64 * 1024);
    }
    if (args.messages_queue) {
      validatePlaintextAttachments(args.messages_queue.files);
    }
    if (args.project) {
      await requireWorkspaceProject(ctx, args.project, ctx.workspace._id);
    }

    let worker: ChatWorkerSelection | undefined;
    if (args.worker) {
      worker = await resolveChatWorkerSelection(ctx, {
        requested: args.worker,
        userId: ctx.identity._id,
        workspace: ctx.workspace,
        project: args.project,
        current: undefined,
      });
    }
    const tools = args.tools ? await storedSelection(ctx, ctx.workspace, args.tools) : undefined;

    const chatId = await ctx.db.insert("aisdk_chats", {
      messages_queue: args.messages_queue,
      sealedQueue: args.e2ee?.sealedQueue,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      worker,
      project: args.project,
      tools,
      userId: ctx.identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });
    const chat = (await ctx.db.get("aisdk_chats", chatId))!;
    await setChatMembers(ctx, chat, args.members ?? []);
    if (args.e2ee) {
      await insertChatKeysSetup(ctx, {
        chat,
        workspace: ctx.workspace,
        members: args.members ?? [],
        keys: args.e2ee.keys,
      });
    }
    await linkChatFiles(
      ctx,
      args.workspace,
      chatId,
      args.e2ee?.fileUrls ?? storedFileUrls([{ parts: args.messages_queue!.files }]),
      { sealed: !!args.e2ee },
    );
    if (!args.e2ee) {
      await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, { chatId });
    }
    return chatId;
  },
});

/**
 * Creates a new chat seeded with an existing conversation history (a "fork").
 *
 * Used by the message-level fork actions: assistant forks pass the history up to
 * and including the assistant turn and no queue (the user continues with a new
 * model), while user forks pass the prior history plus a `messages_queue` so the
 * forked user turn is regenerated with another model on load. `project` must belong to the
 * same workspace.
 */
export const ForkChat = workspaceMutation({
  args: {
    scope: v.optional(chatScopeValidator),
    messages: v.optional(v.array(messageSchema)),
    members: v.optional(v.array(v.string())),
    e2ee: v.optional(
      v.object({
        keys: chatKeysSetupValidator,
        capsules: v.array(chatCapsuleValidator),
        messages: v.array(
          v.object({ messageId: v.string(), capsuleId: v.string(), envelope: v.bytes() }),
        ),
        sealedQueue: v.optional(sealedBoxValidator),
        fileUrls: v.array(v.string()),
      }),
    ),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
    project: v.optional(v.id("projects")),
  },
  returns: v.id("aisdk_chats"),
  handler: async (ctx, args): Promise<Id<"aisdk_chats">> => {
    const scope = args.scope ?? "personal";
    await requireChatKeysForCreate(ctx, {
      userId: ctx.identity._id,
      workspace: ctx.workspace,
      scope,
      hasKeys: !!args.e2ee,
    });
    if (
      args.e2ee
        ? args.messages !== undefined || args.messages_queue != null
        : args.messages === undefined
    ) {
      invalidSealedContent();
    }
    if (scope !== "shared" && args.members !== undefined) {
      invalidSealedContent();
    }
    if (args.e2ee?.sealedQueue) {
      validateChatBox(args.e2ee.sealedQueue, 1, 64 * 1024);
    }
    if (args.messages_queue) {
      validatePlaintextAttachments(args.messages_queue.files);
    }
    if (args.project) {
      await requireWorkspaceProject(ctx, args.project, ctx.workspace._id);
    }

    const chatId = await ctx.db.insert("aisdk_chats", {
      messages_queue: args.messages_queue ?? undefined,
      sealedQueue: args.e2ee?.sealedQueue,
      workspace: args.workspace,
      scope: args.scope ?? "personal",
      project: args.project,
      userId: ctx.identity._id,
      activeStream: false,
      lastInteractionAt: Date.now(),
    });
    const chat = (await ctx.db.get("aisdk_chats", chatId))!;
    await setChatMembers(ctx, chat, args.members ?? []);
    if (args.e2ee) {
      await insertChatKeysSetup(ctx, {
        chat,
        workspace: ctx.workspace,
        members: args.members ?? [],
        keys: args.e2ee.keys,
      });
      const capsuleIds = new Set<string>();
      for (const capsule of args.e2ee.capsules) {
        validateChatCapsule(capsule);
        if (capsule.chatEpoch !== 1 || capsuleIds.has(capsule.capsuleId)) {
          invalidSealedContent();
        }
        capsuleIds.add(capsule.capsuleId);
        await ctx.db.insert("e2ee_capsules", { chat: chatId, ...capsule });
      }
      const messageIds = new Set<string>();
      for (const [position, message] of args.e2ee.messages.entries()) {
        if (
          !message.messageId ||
          messageIds.has(message.messageId) ||
          !capsuleIds.has(message.capsuleId)
        ) {
          invalidSealedContent();
        }
        validateMessageEnvelope(message.envelope, message.capsuleId);
        messageIds.add(message.messageId);
        await ctx.db.insert("chat_messages", {
          chat: chatId,
          position,
          messageId: message.messageId,
          revision: 1,
          sealed: { capsuleId: message.capsuleId, envelope: message.envelope },
        });
      }
      await linkChatFiles(ctx, args.workspace, chatId, args.e2ee.fileUrls, { sealed: true });
    } else {
      await insertChatMessages(ctx, chatId, args.workspace, args.messages!);
    }
    if (args.messages_queue) {
      await linkChatFiles(
        ctx,
        args.workspace,
        chatId,
        storedFileUrls([{ parts: args.messages_queue.files }]),
      );
    }

    if (args.messages_queue?.text.trim()) {
      await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, { chatId });
    }
    return chatId;
  },
});

/**
 * Chat HTTP action write: request start (`activeStream: true`, queue cleared) and request end
 * (messages, `activeStream: false`, and the `interruption` if it stopped short). Omitted fields
 * other than `messages` are cleared, so every start drops the previous interruption. `messages`
 * replaces the stored history (only changed positions are written) and moves an unmigrated
 * chat's embedded history out of the chat document.
 */
export const EditChat = internalMutation({
  args: {
    messages: v.optional(v.array(messageSchema)),
    sealedWrites: v.optional(sealedWritesValidator),
    sealedTitle: v.optional(sealedBoxValidator),
    activeStream: v.optional(v.boolean()),
    messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
    interruption: v.optional(chatInterruptionValidator),
    chatId: v.id("aisdk_chats"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) {
      return "Chat not Found.";
    }
    if (
      (args.messages && chat.e2eeId) ||
      (args.sealedWrites && !chat.e2eeId) ||
      (args.messages && args.sealedWrites)
    ) {
      invalidSealedContent();
    }
    if (chat.e2eeId && args.messages_queue) {
      invalidSealedContent();
    }
    if (args.sealedTitle) {
      if (!chat.e2eeId || chat.rekey) {
        invalidSealedContent();
      }
      validateChatBox(args.sealedTitle, chat.keyEpoch!, 2048);
    }
    if (args.sealedWrites) {
      const workspace = await resolveWorkspaceForChat(ctx, chat);
      if (!workspace) return "Chat not Found.";
      await saveSealedChatMessages(ctx, chat, workspace._id, args.sealedWrites);
    }

    if (args.messages) {
      const workspace = await resolveWorkspaceForChat(ctx, chat);
      if (!workspace) return "Chat not Found.";
      await saveChatMessages(ctx, chat, workspace._id, args.messages);
    }

    const at = Date.now();
    await ctx.db.patch("aisdk_chats", args.chatId, {
      ...(args.messages || args.sealedWrites
        ? { messages: undefined, chat_completions: undefined }
        : {}),
      ...(args.sealedTitle
        ? { sealedTitle: args.sealedTitle, title: undefined, emoji: undefined }
        : {}),
      ...(args.activeStream !== undefined || args.messages || args.sealedWrites
        ? {
            activeStream: args.activeStream,
            interruption: args.interruption,
            messages_queue: args.messages_queue,
            sealedQueue: undefined,
          }
        : {}),
      lastInteractionAt: at,
    });
    await touchChatMembers(ctx, args.chatId, at);
    return null;
  },
});

/**
 * Chat metadata for a session Tab, without its history: every mounted Tab subscribes to this,
 * so it must stay cheap. History comes from `GetChatMessages`, subscribed only by opened Tabs.
 */
export const GetChat = query({
  args: {
    chatId: v.id("aisdk_chats"),
  },
  returns: v.union(
    v.literal("Not logged in!"),
    v.object({
      id: v.id("aisdk_chats"),
      workspace: v.id("workspaces"),
      scope: chatScopeValidator,
      canManage: v.boolean(),
      canManageScope: v.boolean(),
      title: v.optional(v.string()),
      e2eeId: v.union(v.string(), v.null()),
      keyEpoch: v.union(v.number(), v.null()),
      rekey: v.boolean(),
      sealedTitle: v.union(sealedBoxValidator, v.null()),
      sealedQueue: v.union(sealedBoxValidator, v.null()),
      activeStream: v.optional(v.boolean()),
      interruption: v.union(chatInterruptionValidator, v.null()),
      messages_queue: v.optional(v.union(queuedMessageSchema, v.null())),
      worker: v.optional(chatWorkerSelectionValidator),
      agent: schema.tables.aisdk_chats.validator.fields.agent,
      project: v.union(v.id("projects"), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";
    const { chat, workspace, canManage } = await requireAccessibleChat(ctx, args.chatId);

    return {
      id: chat._id,
      workspace: workspace._id,
      scope: chat.scope ?? "personal",
      canManage,
      canManageScope: chat.userId === identity._id,
      title: chat.title,
      e2eeId: chat.e2eeId ?? null,
      keyEpoch: chat.keyEpoch ?? null,
      rekey: chat.rekey ?? false,
      sealedTitle: chat.sealedTitle ?? null,
      sealedQueue: chat.sealedQueue ?? null,
      activeStream: chat.activeStream,
      interruption: chat.interruption ?? null,
      messages_queue: chat.messages_queue,
      worker: chat.worker,
      agent: chat.agent,
      project: chat.project ?? null,
    };
  },
});

/**
 * A chat's full history for the open session, with `activeStream` from the same snapshot so the
 * client can tell whether a request was still running when these messages were read.
 */
export const GetChatMessages = query({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.object({
    entries: v.array(
      v.object({
        position: v.number(),
        messageId: v.optional(v.string()),
        revision: v.optional(v.number()),
        message: v.optional(messageSchema),
        sealed: v.optional(v.object({ capsuleId: v.string(), envelope: v.bytes() })),
      }),
    ),
    capsules: v.array(chatCapsuleValidator),
    activeStream: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { chat } = await requireAccessibleChat(ctx, args.chatId);
    const entries =
      chat.messages !== undefined
        ? chat.messages.map((message, position) => ({ position, message, messageId: message.id }))
        : (
            await ctx.db
              .query("chat_messages")
              .withIndex("by_chat_and_position", (q) => q.eq("chat", chat._id))
              .collect()
          ).map(({ position, messageId, revision, message, sealed }) => ({
            position,
            messageId,
            revision,
            message,
            sealed,
          }));
    const capsules = (
      await ctx.db
        .query("e2ee_capsules")
        .withIndex("by_chat_and_capsuleId", (q) => q.eq("chat", chat._id))
        .collect()
    ).map(({ capsuleId, chatEpoch, capsule }) => ({ capsuleId, chatEpoch, capsule }));
    return {
      entries,
      capsules,
      activeStream: chat.activeStream ?? false,
    };
  },
});

/** Stored row IDs/revisions only; the turn action never reads stored message plaintext. */
export const chatMessageHeads = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.array(
    v.object({
      position: v.number(),
      messageId: v.optional(v.string()),
      revision: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("chat_messages")
      .withIndex("by_chat_and_position", (q) => q.eq("chat", args.chatId))
      .collect();
    return rows.map(({ position, messageId, revision }) => ({ position, messageId, revision }));
  },
});

/** Resolve the current public sealing key, optionally requiring authenticated chat management. */
export const chatSealingInfo = internalQuery({
  args: { chatId: v.id("aisdk_chats"), manager: v.optional(v.boolean()) },
  returns: v.union(
    v.null(),
    v.object({
      e2eeId: v.string(),
      workspace: v.id("workspaces"),
      epoch: v.number(),
      keyId: v.string(),
      publicKey: v.bytes(),
    }),
  ),
  handler: async (ctx, args) => {
    // HTTP callers already authorized the turn; public title regeneration must recheck management.
    const chat = args.manager
      ? (await requireChatManager(ctx, args.chatId)).chat
      : await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat?.e2eeId) {
      return null;
    }
    const workspace = await resolveWorkspaceForChat(ctx, chat);
    if (!workspace || (await chatKeyIsStale(ctx, chat, workspace))) {
      return null;
    }
    const key = await currentChatPublicKey(ctx, chat);
    return key ? { e2eeId: chat.e2eeId, workspace: workspace._id, ...key } : null;
  },
});

/** Generate and store only a sealed title; the supplied first prompt lives only in this action. */
export const regenerateTitle = action({
  args: { chatId: v.id("aisdk_chats"), prompt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.prompt.length > 8000 || !args.prompt.trim()) {
      invalidSealedContent();
    }
    const target = await ctx.runQuery(internal.aisdk.chatSealingInfo, {
      chatId: args.chatId,
      manager: true,
    });
    if (!target) {
      invalidSealedContent();
    }
    const info = await ctx.runQuery(internal.chatroom.titleModelForChat, { chatId: args.chatId });
    if (!info) {
      throw new ConvexError({ code: "TITLE_MODEL_UNAVAILABLE" });
    }
    const provider = createInternalGatewayProvider(ctx, info.workspace, {}, undefined, undefined, {
      userId: info.userId,
      chatId: args.chatId,
    });
    let title;
    try {
      title = await generateChatTitle({
        model: provider(info.model),
        initialUserMessage: args.prompt,
      });
    } catch {
      // Provider errors can echo the prompt; surface only a generic code.
      throw new ConvexError({ code: "TITLE_GENERATION_FAILED" });
    }
    const sealedTitle = await sealChatTitle(
      { ...target, publicKey: new Uint8Array(target.publicKey) },
      title,
    );
    await ctx.runMutation(internal.aisdk.EditChat, { chatId: args.chatId, sealedTitle });
    return null;
  },
});

/**
 * Set (or clear) a chat's Worker selection. Only the workspace owner may do so. The client
 * `directory` is ignored: a changed Worker (or a missing stored directory) re-derives it from the
 * chat's Project folder or the Worker's temp directory; toggling tools keeps the stored one.
 */
export const SetChatWorker = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    selection: v.union(chatWorkerSelectionValidator, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireChatManager(ctx, args.chatId);
    if (chat.agent) throw new ConvexError({ code: "ACP_IMMUTABLE_BINDING" });

    if (!args.selection) {
      if (workspace.ownerId !== userId) {
        throw new Error("Only the workspace owner can configure a Worker for chats.");
      }
      await ctx.db.patch("aisdk_chats", chat._id, { worker: undefined });
      return null;
    }

    const worker = await resolveChatWorkerSelection(ctx, {
      requested: args.selection,
      userId,
      workspace,
      project: chat.project,
      current: chat.worker,
    });
    await ctx.db.patch("aisdk_chats", chat._id, { worker });
    return null;
  },
});

/**
 * File a chat under a Project in its own workspace, or detach it with `null`. Requires chat
 * management (creator, or workspace owner for shared chats); filing never changes visibility.
 * A chat with a Worker gets its directory re-derived for the new Project (owner-set folders).
 */
export const SetChatProject = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    project: v.union(v.id("projects"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace } = await requireChatManager(ctx, args.chatId);

    if (args.project) {
      await requireWorkspaceProject(ctx, args.project, workspace._id);
    }

    const project = args.project ?? undefined;
    let worker = chat.worker;
    const needsDirectory =
      worker?.workerId !== undefined &&
      (chat.project !== project || worker.directory === undefined);
    if (worker && needsDirectory) {
      worker = await rederiveChatWorkerDirectory(ctx, workspace._id, worker, project);
    }

    await ctx.db.patch("aisdk_chats", chat._id, { project, worker });
    return null;
  },
});

/** Change a chat's visibility. Only its creator may change its scope. */
export const SetChatScope = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    scope: chatScopeValidator,
    members: v.optional(v.array(v.string())),
    keys: v.optional(
      v.object({ rotate: v.optional(chatKeyInputValidator), wraps: v.array(wrapInputValidator) }),
    ),
  },
  returns: v.object({ scope: chatScopeValidator }),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const { chat, workspace } = await requireAccessibleChat(ctx, args.chatId);
    await changeChatScope(ctx, chat, workspace, identity._id, args);
    return { scope: args.scope };
  },
});

/** Rename through a sealed box for keyed chats, preserving the legacy plaintext path otherwise. */
export const RenameChat = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    title: v.optional(v.string()),
    sealedTitle: v.optional(sealedBoxValidator),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    const { chat } = await requireChatActor(ctx, args.chatId);
    if (chat.e2eeId) {
      if (args.title !== undefined || !args.sealedTitle || chat.rekey) {
        invalidSealedContent();
      }
      validateChatBox(args.sealedTitle, chat.keyEpoch!, 2048);
      await ctx.db.patch("aisdk_chats", args.chatId, {
        sealedTitle: args.sealedTitle,
        title: undefined,
        emoji: undefined,
      });
      return null;
    }
    if (args.sealedTitle) {
      invalidSealedContent();
    }
    const title = (args.title ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
    if (!title) return "Title is required.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title });
    const session = await findSession(ctx, args.chatId);
    if (session) await ctx.db.patch(session._id, { userTitled: true });
    return null;
  },
});

export const SetChatPinned = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    await requireChatActor(ctx, args.chatId);

    await ctx.db.patch("aisdk_chats", args.chatId, {
      pinnedAt: args.pinned ? Date.now() : undefined,
    });
    return null;
  },
});

/** Schedule a legacy plaintext title; encrypted callers must supply a prompt to regenerateTitle. */
export const RegenerateChatTitle = mutation({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    const { chat } = await requireChatManager(ctx, args.chatId);
    if (chat.e2eeId) {
      invalidSealedContent();
    }
    const firstUserMessage = await loadFirstUserMessage(ctx, chat);
    const prompt = firstUserMessageText({
      messages_queue: chat.messages_queue,
      messages: firstUserMessage ? [firstUserMessage] : [],
    });
    if (!prompt) return "Chat has no prompt to title.";

    await ctx.db.patch("aisdk_chats", args.chatId, { title: undefined, emoji: undefined });
    await ctx.scheduler.runAfter(0, internal.chatroom.generateForChat, {
      chatId: args.chatId,
      force: true,
    });
    return null;
  },
});

export const DeleteChat = mutation({
  args: { chatId: v.id("aisdk_chats"), deleteInAgent: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!";

    const access = await requireChatActor(ctx, args.chatId);
    await queueChatDeletion(ctx, access.chat, identity._id, args.deleteInAgent);

    await ctx.db.delete("aisdk_chats", args.chatId);
    await ctx.scheduler.runAfter(0, internal.worker_tasks.cleanupChatCalls, {
      chatId: args.chatId,
    });
    await ctx.scheduler.runAfter(0, internal.aisdk.cleanupChatContent, { chatId: args.chatId });
    return null;
  },
});

/** Match both ownership keys during the legacy migration for chats with a workspace id. */
function chatBelongsToWorkspace(chat: Doc<"aisdk_chats">, workspace: Doc<"workspaces">) {
  return (
    chat.workspace === workspace._id &&
    (chat.balance === undefined || chat.balance === workspace.legacyBalance)
  );
}

/** A legacy balance-only chat visible to `userId`: personal and theirs. */
function isLegacyChatOf(chat: Doc<"aisdk_chats">, userId: string) {
  return (
    chat.workspace === undefined &&
    chat.userId === userId &&
    (chat.scope === undefined || chat.scope === "personal")
  );
}

/** Validates a Project filter: a deleted Project lists nothing, a foreign one is an error. */
async function projectFilterExists(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  project: Id<"projects"> | null | undefined,
) {
  if (!project) return true;
  const row = await ctx.db.get("projects", project);
  if (!row) return false;
  if (row.workspace !== workspace) throw new Error("Project not found.");
  return true;
}

/**
 * The one wrap a Home row needs to open a chat's title: the caller's identity wrap, else the
 * newest workspace wrap for workspace chats. Point lookups; no other wrap is read.
 */
async function callerWrap(
  ctx: QueryCtx,
  chat: Doc<"aisdk_chats">,
  chatEpoch: number,
  userId: string,
  identityKeyId: string | undefined,
) {
  const own = identityKeyId
    ? await ctx.db
        .query("e2ee_chat_key_wraps")
        .withIndex("by_chat_and_chatEpoch_and_recipientKeyId", (q) =>
          q.eq("chat", chat._id).eq("chatEpoch", chatEpoch).eq("recipientKeyId", identityKeyId),
        )
        .first()
    : null;
  if (own?.recipient === "identity" && own.userId === userId) {
    return own;
  }
  return chat.scope === "workspace"
    ? ((await newestWorkspaceWrap(ctx, chat._id, chatEpoch)) ?? undefined)
    : undefined;
}

/**
 * Home row for a chat, with its ACP agent's configured name. `canAct` mirrors `requireChatActor`
 * (rename, pin, delete: everyone who can see an ACP chat); `canManage` gates manager-only actions.
 */
async function chatRows(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  userId: string,
  chats: Doc<"aisdk_chats">[],
) {
  const agentIds = new Set(chats.flatMap((chat) => (chat.agent ? [chat.agent.agentId] : [])));
  const agentNames = new Map(
    await Promise.all(
      [...agentIds].map(async (agentId) => {
        const definition = await ctx.db
          .query("acp_agents")
          .withIndex("by_workspace_and_agentId", (q) =>
            q.eq("workspace", workspace._id).eq("agentId", agentId),
          )
          .unique();
        return [agentId, definition?.name ?? agentId] as const;
      }),
    ),
  );
  const identity = chats.some((chat) => chat.e2eeId) ? await activeIdentityFor(ctx, userId) : null;
  return await Promise.all(
    chats.map(async (chat) => {
      const canManage = canManageChat(chat, workspace, userId);
      const titleEpoch = chat.sealedTitle?.epoch ?? chat.keyEpoch;
      const wrap =
        chat.e2eeId && titleEpoch
          ? await callerWrap(ctx, chat, titleEpoch, userId, identity?.keyId)
          : undefined;
      return {
        id: chat._id,
        title: chat.title,
        emoji: chat.emoji,
        scope: chat.scope ?? "personal",
        e2ee: chat.e2eeId ? { e2eeId: chat.e2eeId, title: chat.sealedTitle, wrap } : null,
        pinnedAt: chat.pinnedAt,
        lastInteractionAt: chat.lastInteractionAt ?? chat._creationTime,
        activeStream: chat.activeStream ?? false,
        agent: chat.agent
          ? {
              agentId: chat.agent.agentId,
              profile: chat.agent.profile,
              name: agentNames.get(chat.agent.agentId) ?? chat.agent.agentId,
              worker: chat.agent.worker,
            }
          : null,
        canManage,
        canAct: chat.agent !== undefined || canManage,
        project: chat.project,
      };
    }),
  );
}

const projectFilterValidator = v.optional(v.union(v.id("projects"), v.null()));

/**
 * One page of the visible, unpinned chats in a workspace, most recent first (pinned ones come
 * from `ListPinnedChats`). `project` narrows to that Project's chats, `project: null` to chats
 * without a Project; the privacy filter (own chats plus workspace-scoped chats, and the caller's
 * legacy balance-only chats) is the same in every case.
 *
 * The creator-owned, shared and legacy indexes are merged into one stream by
 * `lastInteractionAt`, so a page reads only its own rows. Pages are reactive: clients pass
 * `endCursor` (convex-helpers `usePaginatedQuery` with `customPagination`) to keep them gapless.
 */
export const ListChats = workspaceQuery({
  args: { project: projectFilterValidator, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!(await projectFilterExists(ctx, ctx.workspace._id, args.project))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const workspace = ctx.workspace;
    const userId = ctx.identity._id;
    const project = args.project ?? undefined;
    const chats = () => stream(ctx.db, schema).query("aisdk_chats");

    // Read creator-owned and explicitly shared chats separately: workspace membership, including
    // ownership, must never expose another user's personal chats, and filing a chat under a
    // Project never shares it. The caller's own shared chats come from the first stream.
    const own =
      args.project === undefined
        ? chats().withIndex("by_workspace_and_userId_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("userId", userId),
          )
        : chats().withIndex("by_workspace_and_userId_and_project_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("userId", userId).eq("project", project),
          );
    const shared =
      args.project === undefined
        ? chats().withIndex("by_workspace_and_scope_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("scope", "workspace"),
          )
        : chats().withIndex("by_workspace_and_scope_and_project_and_lastInteractionAt", (q) =>
            q.eq("workspace", workspace._id).eq("scope", "workspace").eq("project", project),
          );
    const streams = [
      own.order("desc").filterWith(async (chat) => chatBelongsToWorkspace(chat, workspace)),
      shared
        .order("desc")
        .filterWith(
          async (chat) => chat.userId !== userId && chatBelongsToWorkspace(chat, workspace),
        ),
      stream(ctx.db, schema)
        .query("chat_members")
        .withIndex("by_workspace_and_userId_and_lastInteractionAt", (q) =>
          q.eq("workspace", workspace._id).eq("userId", userId),
        )
        .order("desc")
        .map(async (row) => {
          const chat = await ctx.db.get("aisdk_chats", row.chat);
          return chat &&
            chat.scope === "shared" &&
            chat.userId !== userId &&
            chatBelongsToWorkspace(chat, workspace) &&
            (args.project === undefined || chat.project === project)
            ? chat
            : null;
        }),
    ];
    if (workspace.legacyBalance) {
      streams.push(
        chats()
          .withIndex("by_balance_and_lastInteractionAt", (q) =>
            q.eq("balance", workspace.legacyBalance!),
          )
          .order("desc")
          .filterWith(
            async (chat) =>
              isLegacyChatOf(chat, userId) &&
              (args.project === undefined || chat.project === project),
          ),
      );
    }
    const result = await mergedStream(streams, ["lastInteractionAt"])
      .filterWith(async (chat) => !chat.pinnedAt)
      .paginate({ ...args.paginationOpts, maximumRowsRead: CHAT_PAGE_MAX_ROWS_READ });
    return { ...result, page: await chatRows(ctx, workspace, userId, result.page) };
  },
});

/**
 * Every visible pinned chat (bounded) under the same filters as `ListChats`, newest pin first.
 * Pinned chats sort first however old they are, so they are read apart from the pages.
 */
export const ListPinnedChats = workspaceQuery({
  args: { project: projectFilterValidator },
  handler: async (ctx, args) => {
    if (!(await projectFilterExists(ctx, ctx.workspace._id, args.project))) return [];
    const workspace = ctx.workspace;
    const userId = ctx.identity._id;
    const project = args.project ?? undefined;
    const matchesProject = (chat: Doc<"aisdk_chats">) =>
      args.project === undefined || chat.project === project;

    // Pinned chats are few; read them across Projects and filter here instead of adding a Project
    // variant of each pinned index.
    const [own, shared, legacy] = await Promise.all([
      ctx.db
        .query("aisdk_chats")
        .withIndex("by_workspace_and_userId_and_pinnedAt", (q) =>
          q.eq("workspace", workspace._id).eq("userId", userId).gt("pinnedAt", 0),
        )
        .order("desc")
        .take(MAX_PINNED_CANDIDATES),
      ctx.db
        .query("aisdk_chats")
        .withIndex("by_workspace_and_scope_and_pinnedAt", (q) =>
          q.eq("workspace", workspace._id).eq("scope", "workspace").gt("pinnedAt", 0),
        )
        .order("desc")
        .take(MAX_PINNED_CANDIDATES),
      workspace.legacyBalance
        ? ctx.db
            .query("aisdk_chats")
            .withIndex("by_balance_and_lastInteractionAt", (q) =>
              q.eq("balance", workspace.legacyBalance!),
            )
            .order("desc")
            .take(MAX_LEGACY_CANDIDATES)
        : Promise.resolve([]),
    ]);
    const explicitRows = await ctx.db
      .query("chat_members")
      .withIndex("by_workspace_and_userId_and_lastInteractionAt", (q) =>
        q.eq("workspace", workspace._id).eq("userId", userId),
      )
      .order("desc")
      .take(CHAT_PAGE_MAX_ROWS_READ);
    const explicit = await Promise.all(
      explicitRows.map((row) => ctx.db.get("aisdk_chats", row.chat)),
    );
    const pinned = new Map<Id<"aisdk_chats">, Doc<"aisdk_chats">>();
    for (const chat of [...own, ...shared]) {
      if (chatBelongsToWorkspace(chat, workspace) && matchesProject(chat)) {
        pinned.set(chat._id, chat);
      }
    }
    for (const chat of explicit)
      if (
        chat?.pinnedAt &&
        chat.scope === "shared" &&
        chatBelongsToWorkspace(chat, workspace) &&
        matchesProject(chat)
      )
        pinned.set(chat._id, chat);
    for (const chat of legacy) {
      if (chat.pinnedAt && isLegacyChatOf(chat, userId) && matchesProject(chat)) {
        pinned.set(chat._id, chat);
      }
    }
    const chats = [...pinned.values()].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    return chatRows(ctx, workspace, userId, chats);
  },
});
