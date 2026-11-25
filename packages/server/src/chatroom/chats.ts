import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import { toBase64Url } from "radium-crypto";
import { z } from "zod";
import { base64urlBytes } from "contracts/wire";
import { chatWorkerToolValidator } from "contracts/worker/chat-config";
import { queueAcpChatDeletion } from "../acp/deletion";
import { signedBindingInput, signedCommandInput } from "../acp/policy";
import { acpChatBindings, isAcpChat, markAcpChatUserTitled } from "../acp/sessions";
import { removeWarm } from "../acp/warm";
import type { Database, Kv } from "../drivers/types";
import {
  callerTitleWrap,
  chatKeysSetupInput,
  currentChatPublicKey,
  insertChatKeysSetup,
  type ChatKeysSetup,
} from "../e2ee/chat-keys";
import { changeChatScope, scopeKeysInput } from "../e2ee/chat-scope";
import { e2eeCapsules } from "../e2ee/schema";
import { activeIdentity } from "../e2ee/workspace-keys";
import { AppError } from "../errors";
import { createInternalGatewayProvider } from "../gateway/completions";
import { dispatchJobs } from "../jobs/outbox";
import type { Runtime } from "../runtime";
import {
  attachChatWorkerGrant,
  chatWorkerColumns,
  chatWorkerSelection,
  rederiveChatWorkerDirectory,
  resolveChatWorkerSelection,
} from "../worker/chat-selection";
import type { WorkspaceAccess } from "../workspaces/access";
import { requireWorkspaceProject } from "../workspaces/projects";
import { projects } from "../workspaces/schema";
import { requireChatAccess, requireChatManager, type Chat, type ChatWorkspace } from "./access";
import { linkChatFiles, queueChatFileRelease } from "./files";
import { readChatHistory } from "./messages";
import { setChatMembers, touchChatMembers } from "./members";
import { chatMembers, chatMessages, chatRuns, chats } from "./schema";
import {
  chatCapsuleInput,
  invalidSealedContent,
  MAX_MESSAGE_ENVELOPE_BYTES,
  MAX_QUEUE_BOX_BYTES,
  MAX_TITLE_BOX_BYTES,
  sealChatTitle,
  sealedBoxInput,
  validateChatBox,
  validateChatCapsule,
  validateMessageEnvelope,
  type SealedBox,
} from "./sealing";
import { titleModelFor } from "./settings";
import { generateChatTitle } from "./titles";
import { toolSelectionInput, writeChatSelection } from "./tool-selection";

/**
 * Chats (Convex `aisdk.*`): creation, forks, Home lists, metadata changes and deletion. Every
 * chat-scoped call authorizes through the one access function (`./access.ts`). Content is sealed
 * by clients; the server checks structure and key epochs (`../e2ee/chat-keys.ts`) and never
 * accepts plaintext content, titles or queued prompts.
 */

/** Chats one Home page holds at most. */
export const MAX_CHAT_PAGE = 100;
/** Pinned chats each source contributes to Home. */
const MAX_PINNED = 100;
/** Messages a fork may seed. */
const MAX_FORK_MESSAGES = 1000;
/** File URLs one write may link. */
export const MAX_FILE_URLS = 200;
/** Longest title-generation prompt. */
const MAX_TITLE_PROMPT = 8000;

const idInput = z.string().min(1).max(256);
const fileUrlsInput = z.array(z.string().max(2048)).max(MAX_FILE_URLS);
export const chatScopeInput = z.enum(["personal", "shared", "workspace"]);
const membersInput = z.array(idInput).max(200);
const workerRequestInput = z.object({
  workerId: idInput.optional(),
  tools: z.array(chatWorkerToolValidator).max(8),
});

export const createChatInput = z.object({
  scope: chatScopeInput.optional(),
  members: membersInput.optional(),
  e2ee: z.object({
    keys: chatKeysSetupInput,
    sealedQueue: sealedBoxInput,
    fileUrls: fileUrlsInput,
  }),
  worker: workerRequestInput.optional(),
  project: idInput.optional(),
  tools: toolSelectionInput.optional(),
});

export const forkChatInput = z.object({
  scope: chatScopeInput.optional(),
  members: membersInput.optional(),
  e2ee: z.object({
    keys: chatKeysSetupInput,
    capsules: z.array(chatCapsuleInput).max(MAX_FORK_MESSAGES),
    messages: z
      .array(
        z.object({
          messageId: z.string().min(1).max(128),
          capsuleId: z.string().max(32),
          envelope: base64urlBytes(MAX_MESSAGE_ENVELOPE_BYTES),
        }),
      )
      .max(MAX_FORK_MESSAGES),
    sealedQueue: sealedBoxInput.optional(),
    fileUrls: fileUrlsInput,
  }),
  project: idInput.optional(),
});

export const setChatScopeInput = z.object({
  chatId: idInput,
  scope: chatScopeInput,
  members: membersInput.optional(),
  keys: scopeKeysInput.optional(),
  /** ACP chats with a published binding: the creator's next binding for the new audience. */
  acpBinding: signedBindingInput.optional(),
});

export const chatWorkerGrantInput = z.object({
  tools: z.array(chatWorkerToolValidator).max(8),
  issuedAt: z.number(),
  signature: base64urlBytes(64),
  signerKeyId: z.string().max(128),
});

/** Keyset cursor of a Home page: the last row's `(lastInteractionAt, id)`. */
export const chatCursorInput = z.object({ at: z.number().int(), id: idInput });
type ChatCursor = z.output<typeof chatCursorInput>;

type ChatScope = Chat["scope"];

// ---------------------------------------------------------------------------------------------
// Creation

/**
 * Creates a keyed chat with its queued first prompt sealed to epoch one (Convex `CreateChat`).
 * `project` must be in the workspace; `tools` becomes the chat's tool override; `worker` is
 * owner-only and its directory is derived server-side. One transaction.
 */
export async function createChat(
  runtime: Runtime,
  access: WorkspaceAccess,
  userId: string,
  input: z.output<typeof createChatInput>,
): Promise<string> {
  const scope = input.scope ?? "personal";
  if (scope !== "shared" && input.members !== undefined) invalidSealedContent();
  validateChatBox(input.e2ee.sealedQueue, 1, MAX_QUEUE_BOX_BYTES);
  return await runtime.drivers.db.transaction(async (tx) => {
    const project = input.project ?? null;
    if (project) await requireWorkspaceProject(tx, project, access.workspace.id);
    const worker = input.worker
      ? await resolveChatWorkerSelection(tx, runtime.drivers.kv, {
          requested: input.worker,
          userId,
          workspace: access.workspace,
          project,
          current: undefined,
        })
      : null;
    const chat = await insertChat(tx, access.workspace, userId, {
      scope,
      project,
      sealedQueue: input.e2ee.sealedQueue,
      ...chatWorkerColumns(worker),
    });
    if (input.tools) await writeChatSelection(tx, chat, input.tools);
    await finishKeyedCreate(tx, chat, access.workspace, input.members ?? [], input.e2ee.keys);
    await linkChatFiles(tx, runtime.config, access.workspace.id, chat.id, input.e2ee.fileUrls, {
      sealed: true,
    });
    return chat.id;
  });
}

/**
 * Creates a keyed chat seeded with sealed history (a fork, Convex `ForkChat`): capsules of epoch
 * one and envelopes bound to them, in order. An optional sealed queue holds the prompt the
 * client continues with.
 */
export async function forkChat(
  runtime: Runtime,
  access: WorkspaceAccess,
  userId: string,
  input: z.output<typeof forkChatInput>,
): Promise<string> {
  const scope = input.scope ?? "personal";
  const { e2ee } = input;
  if (scope !== "shared" && input.members !== undefined) invalidSealedContent();
  if (e2ee.sealedQueue) validateChatBox(e2ee.sealedQueue, 1, MAX_QUEUE_BOX_BYTES);
  const capsuleIds = new Set<string>();
  for (const capsule of e2ee.capsules) {
    validateChatCapsule(capsule);
    if (capsule.chatEpoch !== 1 || capsuleIds.has(capsule.capsuleId)) invalidSealedContent();
    capsuleIds.add(capsule.capsuleId);
  }
  const messageIds = new Set<string>();
  for (const message of e2ee.messages) {
    if (messageIds.has(message.messageId) || !capsuleIds.has(message.capsuleId)) {
      invalidSealedContent();
    }
    validateMessageEnvelope(message.envelope, message.capsuleId);
    messageIds.add(message.messageId);
  }
  return await runtime.drivers.db.transaction(async (tx) => {
    const project = input.project ?? null;
    if (project) await requireWorkspaceProject(tx, project, access.workspace.id);
    const chat = await insertChat(tx, access.workspace, userId, {
      scope,
      project,
      sealedQueue: e2ee.sealedQueue ?? null,
      worker: null,
      workerSelection: null,
    });
    await finishKeyedCreate(tx, chat, access.workspace, input.members ?? [], e2ee.keys);
    if (e2ee.capsules.length > 0) {
      await tx
        .insert(e2eeCapsules)
        .values(e2ee.capsules.map((capsule) => ({ chat: chat.id, ...capsule })));
    }
    if (e2ee.messages.length > 0) {
      await tx.insert(chatMessages).values(
        e2ee.messages.map((message, position) => ({
          chat: chat.id,
          position,
          messageId: message.messageId,
          revision: 1,
          sealedCapsuleId: message.capsuleId,
          sealedEnvelope: message.envelope,
        })),
      );
    }
    await linkChatFiles(tx, runtime.config, access.workspace.id, chat.id, e2ee.fileUrls, {
      sealed: true,
    });
    return chat.id;
  });
}

async function insertChat(
  tx: Database,
  workspace: ChatWorkspace,
  userId: string,
  values: {
    scope: ChatScope;
    project: string | null;
    sealedQueue: SealedBox | null;
    worker: string | null;
    workerSelection: Chat["workerSelection"];
    lastInteractionAt?: Date;
  },
): Promise<Chat> {
  const [chat] = await tx
    .insert(chats)
    .values({
      userId,
      workspace: workspace.id,
      scope: values.scope,
      project: values.project,
      sealedQueueEpoch: values.sealedQueue?.epoch ?? null,
      sealedQueueBox: values.sealedQueue?.box ?? null,
      worker: values.worker,
      workerSelection: values.workerSelection,
      // Millisecond precision, so Home's keyset cursor (milliseconds on the wire) is exact.
      lastInteractionAt: values.lastInteractionAt ?? new Date(),
    })
    .returning();
  return chat!;
}

/**
 * The chat half of a new ACP session, in the ACP service's transaction (Convex
 * `insertAgentChat`): a keyed chat of `userId` with its members and epoch one, optionally with the
 * indexed session's sealed title and Home time. The caller inserts the `acp_sessions` row.
 */
export async function createAcpChat(
  tx: Database,
  workspace: ChatWorkspace,
  userId: string,
  values: {
    scope: ChatScope;
    members: string[];
    keys: ChatKeysSetup;
    project: string | null;
    sealedTitle?: SealedBox;
    lastInteractionAt?: Date;
  },
): Promise<Chat> {
  if (values.scope !== "shared" && values.members.length > 0) invalidSealedContent();
  if (values.project) await requireWorkspaceProject(tx, values.project, workspace.id);
  const chat = await insertChat(tx, workspace, userId, {
    scope: values.scope,
    project: values.project,
    sealedQueue: null,
    worker: null,
    workerSelection: null,
    lastInteractionAt: values.lastInteractionAt,
  });
  await setChatMembers(tx, chat, workspace, values.members);
  const keyed = await insertChatKeysSetup(tx, {
    chat,
    workspace,
    members: values.members,
    keys: values.keys,
  });
  if (values.sealedTitle) await saveSealedTitle(tx, keyed, values.sealedTitle);
  return keyed;
}

/** Members and epoch one of a new chat; the setup also marks the chat keyed. */
async function finishKeyedCreate(
  tx: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  members: string[],
  keys: ChatKeysSetup,
) {
  await setChatMembers(tx, chat, workspace, members);
  await insertChatKeysSetup(tx, { chat, workspace, members, keys });
}

// ---------------------------------------------------------------------------------------------
// Reads

/** Whether `chatId` has an active built-in run (it is replying). */
async function hasActiveRun(db: Database, chatId: string) {
  const [row] = await db
    .select({ id: chatRuns.id })
    .from(chatRuns)
    .where(and(eq(chatRuns.chat, chatId), eq(chatRuns.status, "active")));
  return row !== undefined;
}

function sealedBox(epoch: number | null, box: Uint8Array | null) {
  return epoch !== null && box !== null ? { epoch, box: toBase64Url(box) } : null;
}

/**
 * Chat metadata for a Session Tab, without history (Convex `GetChat`). `activeStream` is whether
 * a built-in run is active; `agent` is the ACP binding of an ACP chat.
 */
export async function getChat(db: Database, userId: string, chatId: string) {
  const { chat, workspace, canManage } = await requireChatAccess(db, userId, chatId);
  const [activeStream, bindings] = await Promise.all([
    hasActiveRun(db, chat.id),
    acpChatBindings(db, workspace.id, [chat.id]),
  ]);
  return {
    id: chat.id,
    workspace: workspace.id,
    scope: chat.scope,
    canManage,
    canManageScope: chat.userId === userId,
    title: chat.title,
    legacyContent: chat.legacyContent,
    e2eeId: chat.e2eeId,
    keyEpoch: chat.keyEpoch,
    rekey: chat.rekey,
    sealedTitle: sealedBox(chat.sealedTitleEpoch, chat.sealedTitleBox),
    sealedQueue: sealedBox(chat.sealedQueueEpoch, chat.sealedQueueBox),
    activeStream,
    interruption: chat.interruption,
    messagesQueue: chat.messagesQueue,
    worker: chatWorkerSelection(chat) ?? null,
    agent: bindings.get(chat.id) ?? null,
    project: chat.project,
  };
}

/**
 * A chat's full history and capsules for the open Session (Convex `GetChatMessages`), with
 * `activeStream` from the same moment so the client can tell whether a run was still going.
 */
export async function getChatMessages(db: Database, userId: string, chatId: string) {
  const { chat } = await requireChatAccess(db, userId, chatId);
  const [history, activeStream] = await Promise.all([
    readChatHistory(db, chat.id),
    hasActiveRun(db, chat.id),
  ]);
  return { ...history, activeStream };
}

/** One Home row. `canAct`: rename, pin, delete (managers, and everyone who sees an ACP chat). */
async function chatRows(db: Database, workspace: ChatWorkspace, userId: string, rows: Chat[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((chat) => chat.id);
  const [bindings, active, identity] = await Promise.all([
    acpChatBindings(db, workspace.id, ids),
    db
      .select({ chat: chatRuns.chat })
      .from(chatRuns)
      .where(and(inArray(chatRuns.chat, ids), eq(chatRuns.status, "active"))),
    rows.some((chat) => chat.e2eeId) ? activeIdentity(db, userId) : undefined,
  ]);
  const replying = new Set(active.map((row) => row.chat));
  return await Promise.all(
    rows.map(async (chat) => {
      const canManage =
        chat.userId === userId || (chat.scope === "workspace" && workspace.ownerId === userId);
      const titleEpoch = chat.sealedTitleEpoch ?? chat.keyEpoch;
      const wrap =
        chat.e2eeId && titleEpoch
          ? await callerTitleWrap(db, chat, titleEpoch, userId, identity?.keyId)
          : undefined;
      const agent = bindings.get(chat.id) ?? null;
      return {
        id: chat.id,
        title: chat.title,
        emoji: chat.emoji,
        legacyContent: chat.legacyContent,
        scope: chat.scope,
        e2ee: chat.e2eeId
          ? {
              e2eeId: chat.e2eeId,
              title: sealedBox(chat.sealedTitleEpoch, chat.sealedTitleBox),
              wrap: wrap
                ? {
                    chatEpoch: wrap.chatEpoch,
                    recipient: wrap.recipient,
                    userId: wrap.userId,
                    workspaceEpoch: wrap.workspaceEpoch,
                    recipientKeyId: wrap.recipientKeyId,
                    sealed: toBase64Url(wrap.sealed),
                  }
                : null,
            }
          : null,
        pinnedAt: chat.pinnedAt?.getTime() ?? null,
        lastInteractionAt: chat.lastInteractionAt.getTime(),
        activeStream: replying.has(chat.id),
        agent: agent
          ? { agentId: agent.agentId, profile: agent.profile, name: agent.name, worker: agent.worker }
          : null,
        canManage,
        canAct: agent !== null || canManage,
        project: chat.project,
      };
    }),
  );
}

/**
 * The Project filter of Home: `undefined` lists every chat, `null` chats without a Project. A
 * deleted Project lists nothing; another workspace's Project is `NOT_FOUND`.
 */
async function projectFilter(
  db: Database,
  workspace: string,
  project: string | null | undefined,
): Promise<{ empty: true } | { empty: false; where: SQL | undefined }> {
  if (project === undefined) return { empty: false, where: undefined };
  if (project === null) return { empty: false, where: isNull(chats.project) };
  const [row] = await db
    .select({ workspace: projects.workspace })
    .from(projects)
    .where(eq(projects.id, project));
  if (!row) return { empty: true };
  if (row.workspace !== workspace) throw new AppError("NOT_FOUND", "Project not found.");
  return { empty: false, where: eq(chats.project, project) };
}

function before(cursor: ChatCursor | null | undefined) {
  if (!cursor) return undefined;
  const at = new Date(cursor.at);
  return or(
    lt(chats.lastInteractionAt, at),
    and(eq(chats.lastInteractionAt, at), lt(chats.id, cursor.id)),
  );
}

/**
 * One page of the visible, unpinned chats in a workspace, most recent first (Convex `ListChats`),
 * paged by `(last_interaction_at, id)`. Three indexed reads, each at most one page: the caller's
 * own chats (`chats_owner_recent`), other users' workspace-scoped chats
 * (`chats_workspace_recent`), and shared chats the caller is a member of
 * (`chat_members_user_recent`). Workspace ownership never lists a member's personal or shared
 * chat, and filing under a Project never shares one.
 */
export async function listChats(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  input: { project?: string | null; cursor?: ChatCursor | null; limit: number },
) {
  const workspace = access.workspace;
  const filter = await projectFilter(db, workspace.id, input.project);
  if (filter.empty) return { page: [], nextCursor: null };
  const limit = Math.min(input.limit, MAX_CHAT_PAGE);
  const common = and(
    eq(chats.workspace, workspace.id),
    isNull(chats.pinnedAt),
    filter.where,
    before(input.cursor),
  );
  const order = [desc(chats.lastInteractionAt), desc(chats.id)];
  const [own, shared, member] = await Promise.all([
    db
      .select()
      .from(chats)
      .where(and(common, eq(chats.userId, userId)))
      .orderBy(...order)
      .limit(limit),
    db
      .select()
      .from(chats)
      .where(and(common, eq(chats.scope, "workspace"), ne(chats.userId, userId)))
      .orderBy(...order)
      .limit(limit),
    db
      .select({ chat: chats })
      .from(chatMembers)
      .innerJoin(chats, eq(chats.id, chatMembers.chat))
      .where(
        and(
          eq(chatMembers.workspace, workspace.id),
          eq(chatMembers.userId, userId),
          eq(chats.scope, "shared"),
          ne(chats.userId, userId),
          common,
        ),
      )
      .orderBy(desc(chatMembers.lastInteractionAt), desc(chatMembers.chat))
      .limit(limit),
  ]);
  const merged = [...own, ...shared, ...member.map((row) => row.chat)]
    .sort(
      (a, b) =>
        b.lastInteractionAt.getTime() - a.lastInteractionAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    .slice(0, limit);
  const last = merged.at(-1);
  return {
    page: await chatRows(db, workspace, userId, merged),
    nextCursor:
      merged.length === limit && last ? { at: last.lastInteractionAt.getTime(), id: last.id } : null,
  };
}

/** Every visible pinned chat (bounded) under the same filters, newest pin first. */
export async function listPinnedChats(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  input: { project?: string | null },
) {
  const workspace = access.workspace;
  const filter = await projectFilter(db, workspace.id, input.project);
  if (filter.empty) return [];
  const common = and(eq(chats.workspace, workspace.id), isNotNull(chats.pinnedAt), filter.where);
  const [own, shared, member] = await Promise.all([
    db
      .select()
      .from(chats)
      .where(and(common, eq(chats.userId, userId)))
      .orderBy(desc(chats.pinnedAt))
      .limit(MAX_PINNED),
    db
      .select()
      .from(chats)
      .where(and(common, eq(chats.scope, "workspace"), ne(chats.userId, userId)))
      .orderBy(desc(chats.pinnedAt))
      .limit(MAX_PINNED),
    db
      .select({ chat: chats })
      .from(chatMembers)
      .innerJoin(chats, eq(chats.id, chatMembers.chat))
      .where(
        and(
          eq(chatMembers.workspace, workspace.id),
          eq(chatMembers.userId, userId),
          eq(chats.scope, "shared"),
          ne(chats.userId, userId),
          common,
        ),
      )
      .orderBy(desc(chats.pinnedAt))
      .limit(MAX_PINNED),
  ]);
  const pinned = [...own, ...shared, ...member.map((row) => row.chat)].sort(
    (a, b) => b.pinnedAt!.getTime() - a.pinnedAt!.getTime(),
  );
  return await chatRows(db, workspace, userId, pinned);
}

// ---------------------------------------------------------------------------------------------
// Changes

/** Chat-level actions (rename, pin, delete): managers, and everyone who can see an ACP chat. */
async function requireChatActor(tx: Database, userId: string, chatId: string) {
  const access = await requireChatAccess(tx, userId, chatId, "update");
  const acp = await isAcpChat(tx, chatId);
  if (!acp && !access.canManage) throw new AppError("NOT_FOUND", "Chat not found.");
  return { ...access, acp };
}

/**
 * Stores a sealed title (and clears any historical plaintext one) in the caller's transaction:
 * the chat must be keyed and not waiting for a rekey, and the box sealed to its current epoch.
 * Browsers seal titles up to {@link MAX_TITLE_BOX_BYTES}; a Worker's ACP title box may be larger.
 */
export async function saveSealedTitle(
  tx: Database,
  chat: Chat,
  sealedTitle: SealedBox,
  maxBytes = MAX_TITLE_BOX_BYTES,
) {
  if (!chat.e2eeId || chat.rekey) invalidSealedContent();
  validateChatBox(sealedTitle, chat.keyEpoch!, maxBytes);
  await tx
    .update(chats)
    .set({
      sealedTitleEpoch: sealedTitle.epoch,
      sealedTitleBox: sealedTitle.box,
      title: null,
      emoji: null,
    })
    .where(eq(chats.id, chat.id));
}

/** Renames through a sealed box (Convex `RenameChat`); a user rename wins over agent titles. */
export async function renameChat(
  db: Database,
  userId: string,
  input: { chatId: string; sealedTitle: SealedBox },
) {
  await db.transaction(async (tx) => {
    const { chat, acp } = await requireChatActor(tx, userId, input.chatId);
    await saveSealedTitle(tx, chat, input.sealedTitle);
    if (acp) await markAcpChatUserTitled(tx, chat.id);
  });
}

export async function setChatPinned(
  db: Database,
  userId: string,
  input: { chatId: string; pinned: boolean },
) {
  await db.transaction(async (tx) => {
    const { chat } = await requireChatActor(tx, userId, input.chatId);
    await tx
      .update(chats)
      .set({ pinnedAt: input.pinned ? new Date() : null })
      .where(eq(chats.id, chat.id));
  });
}

/**
 * Files a chat under a Project of its workspace, or detaches it (Convex `SetChatProject`). A chat
 * with a Worker gets its directory re-derived for the new Project.
 */
export async function setChatProject(
  db: Database,
  kv: Kv,
  userId: string,
  input: { chatId: string; project: string | null },
) {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatManager(tx, userId, input.chatId, "update");
    if (input.project) await requireWorkspaceProject(tx, input.project, workspace.id);
    let worker = chatWorkerSelection(chat);
    if (
      worker?.workerId !== undefined &&
      (chat.project !== input.project || worker.directory === undefined)
    ) {
      worker = await rederiveChatWorkerDirectory(tx, kv, workspace.id, worker, input.project);
    }
    await tx
      .update(chats)
      .set({ project: input.project, ...chatWorkerColumns(worker ?? null) })
      .where(eq(chats.id, chat.id));
  });
}

/**
 * Changes a chat's visibility (Convex `SetChatScope`): creator only, with the key changes the new
 * audience needs (`../e2ee/chat-scope.ts`) and, for an ACP chat with a published binding, the
 * creator's re-signed binding (`acpBinding`), under the chat row lock.
 */
export async function setChatScope(
  db: Database,
  userId: string,
  input: z.output<typeof setChatScopeInput>,
) {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatAccess(tx, userId, input.chatId, "update");
    await changeChatScope(tx, chat, workspace, userId, input);
  });
  return { scope: input.scope };
}

/** Sets or clears a chat's Worker selection; workspace owner only (Convex `SetChatWorker`). */
export async function setChatWorker(
  db: Database,
  kv: Kv,
  userId: string,
  input: { chatId: string; selection: z.output<typeof workerRequestInput> | null },
) {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatManager(tx, userId, input.chatId, "update");
    if (await isAcpChat(tx, chat.id)) throw new AppError("CONFLICT", "ACP_IMMUTABLE_BINDING");
    if (workspace.ownerId !== userId) {
      throw new AppError("FORBIDDEN", "Only the workspace owner can configure a Worker for chats.");
    }
    const worker = input.selection
      ? await resolveChatWorkerSelection(tx, kv, {
          requested: input.selection,
          userId,
          workspace,
          project: chat.project,
          current: chatWorkerSelection(chat),
        })
      : null;
    await tx.update(chats).set(chatWorkerColumns(worker)).where(eq(chats.id, chat.id));
  });
}

/** Stores the owner's signed standing grant for the chat's current Worker selection. */
export async function setChatWorkerGrant(
  db: Database,
  userId: string,
  input: {
    chatId: string;
    workerId: string;
    directory: string;
    grant: z.output<typeof chatWorkerGrantInput>;
  },
) {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatManager(tx, userId, input.chatId, "update");
    if (await isAcpChat(tx, chat.id)) throw new AppError("CONFLICT", "ACP_IMMUTABLE_BINDING");
    if (workspace.ownerId !== userId) {
      throw new AppError("FORBIDDEN", "Only the workspace owner can configure a Worker for chats.");
    }
    const worker = attachChatWorkerGrant(chatWorkerSelection(chat), input);
    await tx.update(chats).set(chatWorkerColumns(worker)).where(eq(chats.id, chat.id));
  });
}

export const deleteChatInput = z.object({
  chatId: idInput,
  /** ACP chats: also delete the session in the agent, when it supports that. */
  deleteInAgent: z.boolean().optional(),
  /** ACP chats: the caller's signed `close`/`delete` command for the bound Worker. */
  acpCommand: signedCommandInput.optional(),
});

/**
 * Deletes a chat in one transaction (Convex `DeleteChat` + `cleanupChatContent`): messages,
 * members, keys, wraps, capsules, runs, tool overrides, file references and ACP session rows go
 * with it through foreign keys; the file objects are released by an outbox job. An ACP chat first
 * queues the caller's signed `close`/`delete` command for its Worker (`../acp/deletion.ts`), and
 * leaves the Worker's warm set after commit.
 */
export async function deleteChat(
  runtime: Runtime,
  userId: string,
  input: z.output<typeof deleteChatInput>,
) {
  const { jobs, acp } = await runtime.drivers.db.transaction(async (tx) => {
    const { chat } = await requireChatActor(tx, userId, input.chatId);
    const acp = await queueAcpChatDeletion(tx, chat, userId, {
      deleteInAgent: input.deleteInAgent,
      signed: input.acpCommand,
    });
    const released = await queueChatFileRelease(tx, chat.id);
    await tx.delete(chats).where(eq(chats.id, chat.id));
    return { jobs: released, acp };
  });
  if (acp) await removeWarm(runtime.drivers.kv, acp.worker, input.chatId);
  runtime.defer(dispatchJobs(runtime, jobs));
}

/**
 * Generates a title from the client-supplied first prompt and stores it sealed to the chat's
 * current key (Convex `regenerateTitle`). The prompt lives only in this call; provider errors are
 * reported generically because they may echo it.
 */
export async function regenerateChatTitle(
  runtime: Runtime,
  userId: string,
  input: { chatId: string; prompt: string },
) {
  const { db } = runtime.drivers;
  if (!input.prompt.trim() || input.prompt.length > MAX_TITLE_PROMPT) invalidSealedContent();
  const { chat, workspace } = await requireChatManager(db, userId, input.chatId);
  const target = await currentChatPublicKey(db, chat, workspace);
  if (!target || !chat.e2eeId) invalidSealedContent();
  const model = await titleModelFor(db, workspace.id);
  if (!model) throw new AppError("CONFLICT", "TITLE_MODEL_UNAVAILABLE");
  const provider = createInternalGatewayProvider(runtime, workspace.id, {}, {
    actor: userId,
    chatId: chat.id,
  });
  let title: { title: string; emoji: string };
  try {
    title = await generateChatTitle({ model: provider(model), initialUserMessage: input.prompt });
  } catch {
    throw new AppError("CONFLICT", "TITLE_GENERATION_FAILED");
  }
  const sealedTitle = await sealChatTitle(
    { workspace: workspace.id, e2eeId: chat.e2eeId, ...target },
    title,
  );
  await db.transaction(async (tx) => {
    const current = await requireChatManager(tx, userId, chat.id, "update");
    await saveSealedTitle(tx, current.chat, sealedTitle);
  });
}

/** Records the end (or start) of a chat interaction: Home order and the members' mirror. */
export async function touchChat(
  tx: Database,
  chatId: string,
  values: Partial<Pick<Chat, "interruption" | "sealedQueueEpoch" | "sealedQueueBox">> = {},
) {
  const at = new Date();
  await tx
    .update(chats)
    .set({ ...values, lastInteractionAt: at })
    .where(eq(chats.id, chatId));
  await touchChatMembers(tx, chatId, at);
}
