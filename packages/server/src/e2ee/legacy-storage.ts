import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { acpAgentSessions, acpInteractions, acpSessions } from "../acp/schema";
import { chatAccess } from "../chatroom/access";
import { chatFiles, chatMessages } from "../chatroom/schema";
import type { StoredJson } from "../db/columns";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { notifications } from "../notifications/schema";
import type { Runtime } from "../runtime";
import { requireVisibleRequest } from "../telemetry/reads";
import { telemetryBlobs, telemetryNodes } from "../telemetry/schema";
import { workerAgents, workerChatCalls, workers } from "../worker/schema";
import { workspaceAccess } from "../workspaces/access";
import { projects } from "../workspaces/schema";
import { legacyObjectKey } from "./legacy-tables";

/**
 * Historical `legacy_content` boxes too large for their row keep the envelope in the object store
 * (`files/<storageId>`), and the stored box says which object (Convex `e2ee_legacy.storageUrl`).
 * The caller names only a source row; the object is the one that row's own box points to, never a
 * key from the caller, and only for a row the caller may read like any other content of that
 * table. Unknown, foreign, archived and hidden rows are the same `NOT_FOUND`.
 *
 * `table` is the historical (Convex) table name, which is also the AAD of the box. Tables whose
 * rows no longer exist after the import (`chat_frames`, `acp_commands`, `worker_tasks`, legacy
 * traces, spans and payloads) are refused as unknown, as is `telemetry_sessions`, which the Convex
 * query never served.
 */

export const legacyStorageInput = z.object({
  table: z.string().min(1).max(64),
  record: z.string().min(1).max(256),
});
export type LegacyStorageInput = z.infer<typeof legacyStorageInput>;

const PRESIGNED_GET_SECONDS = 60;
/** Convex storage ids; anything else is not a usable object key. */
const STORAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Box = StoredJson<LegacyBox> | null;
/** The row's box when the user may read the row; `undefined` for an unknown or refused row. */
type Source = (db: Database, userId: string, record: string) => Promise<Box | undefined>;

async function isOwner(db: Database, userId: string, workspace: string) {
  return (await workspaceAccess(db, userId, workspace))?.role === "owner";
}

async function canSeeChat(db: Database, userId: string, chat: string) {
  return (await chatAccess(db, userId, chat)) !== null;
}

/** Rows that name their chat: the chat access function decides (personal-chat privacy). */
const chatBound =
  (load: (db: Database, record: string) => Promise<{ chat: string; box: Box } | undefined>): Source =>
  async (db, userId, record) => {
    const row = await load(db, record);
    return row && (await canSeeChat(db, userId, row.chat)) ? row.box : undefined;
  };

/** Rows of the workspace owner alone, whatever the member. */
const workspaceOwned =
  (load: (db: Database, record: string) => Promise<{ workspace: string; box: Box } | undefined>): Source =>
  async (db, userId, record) => {
    const row = await load(db, record);
    return row && (await isOwner(db, userId, row.workspace)) ? row.box : undefined;
  };

const SOURCES: Record<string, Source> = {
  workspaces: async (db, userId, record) =>
    (await workspaceAccess(db, userId, record))?.workspace.legacyContent,

  projects: async (db, userId, record) => {
    const [row] = await db
      .select({ workspace: projects.workspace, box: projects.legacyContent })
      .from(projects)
      .where(eq(projects.id, record));
    return row && (await workspaceAccess(db, userId, row.workspace)) ? row.box : undefined;
  },

  aisdk_chats: async (db, userId, record) =>
    (await chatAccess(db, userId, record))?.chat.legacyContent,

  chat_messages: chatBound(async (db, record) => {
    const [row] = await db
      .select({ chat: chatMessages.chat, box: chatMessages.legacyContent })
      .from(chatMessages)
      .where(eq(chatMessages.id, record));
    return row;
  }),

  // An attachment of a chat follows the chat; a pending one is its uploader's.
  chat_files: async (db, userId, record) => {
    const [row] = await db
      .select({
        chat: chatFiles.chat,
        workspace: chatFiles.workspace,
        owner: chatFiles.userId,
        box: chatFiles.legacyContent,
      })
      .from(chatFiles)
      .where(eq(chatFiles.id, record));
    if (!row) return undefined;
    const allowed = row.chat
      ? await canSeeChat(db, userId, row.chat)
      : row.owner === userId && (await workspaceAccess(db, userId, row.workspace)) !== null;
    return allowed ? row.box : undefined;
  },

  acp_sessions: chatBound(async (db, record) => {
    const [row] = await db
      .select({ chat: acpSessions.chat, box: acpSessions.legacyContent })
      .from(acpSessions)
      .where(eq(acpSessions.id, record));
    return row;
  }),

  acp_interactions: chatBound(async (db, record) => {
    const [row] = await db
      .select({ chat: acpInteractions.chat, box: acpInteractions.legacyContent })
      .from(acpInteractions)
      .where(eq(acpInteractions.id, record));
    return row;
  }),

  worker_chat_calls: chatBound(async (db, record) => {
    const [row] = await db
      .select({ chat: workerChatCalls.chat, box: workerChatCalls.legacyContent })
      .from(workerChatCalls)
      .where(eq(workerChatCalls.id, record));
    return row;
  }),

  // The workspace owner's catalog, narrowed by the chat it was started from, if any.
  acp_agent_sessions: async (db, userId, record) => {
    const [row] = await db
      .select({
        workspace: acpAgentSessions.workspace,
        chat: acpAgentSessions.chat,
        box: acpAgentSessions.legacyContent,
      })
      .from(acpAgentSessions)
      .where(eq(acpAgentSessions.id, record));
    if (!row) return undefined;
    if (row.chat && !(await canSeeChat(db, userId, row.chat))) return undefined;
    return (await isOwner(db, userId, row.workspace)) ? row.box : undefined;
  },

  worker_agents: workspaceOwned(async (db, record) => {
    const [row] = await db
      .select({ workspace: workers.workspace, box: workerAgents.legacyContent })
      .from(workerAgents)
      .innerJoin(workers, eq(workers.id, workerAgents.worker))
      .where(eq(workerAgents.id, record));
    return row;
  }),

  telemetry_blobs: workspaceOwned(async (db, record) => {
    const [row] = await db
      .select({ workspace: telemetryBlobs.workspace, box: telemetryBlobs.legacyContent })
      .from(telemetryBlobs)
      .where(eq(telemetryBlobs.id, record));
    return row;
  }),

  telemetry_nodes: workspaceOwned(async (db, record) => {
    const [row] = await db
      .select({ workspace: telemetryNodes.workspace, box: telemetryNodes.legacyContent })
      .from(telemetryNodes)
      .where(eq(telemetryNodes.id, record));
    return row;
  }),

  // The owner, and never beyond what the owner sees in Chatroom (private chats stay hidden).
  telemetry_requests: async (db, userId, record) => {
    try {
      return (await requireVisibleRequest(db, userId, record)).request.legacyContent;
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  },

  notifications: async (db, userId, record) => {
    const [row] = await db
      .select({ owner: notifications.userId, box: notifications.legacyContent })
      .from(notifications)
      .where(eq(notifications.id, record));
    return row?.owner === userId ? row.box : undefined;
  },
};

/**
 * The object key of the envelope the box of `input.record` points to, for a row `userId` may
 * read; `null` when that row's box keeps its envelope inline.
 */
export async function legacyStorageKey(
  db: Database,
  userId: string,
  input: LegacyStorageInput,
): Promise<string | null> {
  if (!Object.hasOwn(SOURCES, input.table)) {
    throw new AppError("BAD_REQUEST", "Invalid historical table.");
  }
  const box = await SOURCES[input.table]!(db, userId, input.record);
  if (box === undefined) throw new AppError("NOT_FOUND", "Historical content not found.");
  const storageId = box?.storageId;
  return storageId && STORAGE_ID.test(storageId) ? legacyObjectKey(storageId) : null;
}

/**
 * A URL that serves the authorized envelope: a short-lived presigned GET, or, on a store that
 * cannot presign (local disk), the authenticated `GET /api/files/legacy` route of the same
 * origin. `null` when the box keeps its envelope inline.
 */
export async function legacyStorageUrl(
  runtime: Pick<Runtime, "drivers">,
  userId: string,
  input: LegacyStorageInput,
): Promise<string | null> {
  const { db, objects } = runtime.drivers;
  const key = await legacyStorageKey(db, userId, input);
  if (!key) return null;
  return (
    objects.presignGet(key, { expiresInSeconds: PRESIGNED_GET_SECONDS }) ??
    `/api/files/legacy?${new URLSearchParams({ table: input.table, record: input.record })}`
  );
}
