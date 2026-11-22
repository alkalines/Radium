import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { ACP_BUSY_STATUSES, ACP_SEALED_ERROR_TEXT, isPersistedAcpErrorCode } from "contracts/acp/contract";
import { workerChatTaskRequestId } from "contracts/worker/task-contract";
import { activeLegacyRecipient } from "./legacy-crypto";
import { deleteLegacySidecar, type LegacyAdapter } from "./migration-contract";

type Context = QueryCtx | MutationCtx;
type RelayRow = {
  [field: string]: unknown;
  workspace?: Id<"workspaces">;
  chat?: Id<"aisdk_chats">;
  chatId?: Id<"aisdk_chats">;
  taskId?: Id<"worker_tasks">;
  by?: string;
  editOwnerId?: string;
  kind?: string;
  status: string;
  warm?: boolean;
  toolCallId?: string;
  stage?: "read" | "preview" | "apply" | "execute";
  sealedError?: unknown;
  sessionsSync?: { error?: string; status: string; at: number };
};

/** Who may read a row's history and which writes must be quiet before it is sealed. */
type Ownership = {
  workspace: Id<"workspaces"> | undefined;
  chatId: Id<"aisdk_chats"> | undefined;
  chat: Doc<"aisdk_chats"> | null | undefined;
  userId: string | undefined;
  ownerOnly: boolean;
  requiresQuietChat: boolean;
};

const TASK_TERMINAL = ["success", "failed"];

/**
 * Resolve the audience of one relay row without reading its content. Missing chats and shared chats
 * without keys stay custodial rather than broadening a formerly private audience to an owner.
 */
async function ownership(ctx: Context, table: string, row: RelayRow): Promise<Ownership> {
  let workspace = row.workspace;
  const chatId = row.chat ?? row.chatId;
  let chat: Doc<"aisdk_chats"> | null | undefined;
  if (chatId) {
    chat = await ctx.db.get(chatId);
    if (chat && workspace && chat.workspace !== workspace)
      throw new Error("LEGACY_RELAY_OWNERSHIP_CONFLICT");
    workspace ??= chat?.workspace;
  }
  const result: Ownership = {
    workspace,
    chatId,
    chat,
    userId: undefined,
    ownerOnly: false,
    requiresQuietChat: false,
  };
  switch (table) {
    case "chat_frames":
    case "acp_sessions":
      result.requiresQuietChat = true;
      break;
    case "acp_commands":
      // Agent-level and deleted-chat commands belong to their issuer, never to all workspace members.
      if (!chat) result.userId = row.by;
      break;
    case "worker_tasks":
      if (!chat) result.userId = row.editOwnerId;
      break;
    case "acp_agent_sessions":
    case "worker_agents":
      result.ownerOnly = true;
      break;
    case "acp_interactions":
    case "worker_chat_calls":
      break;
    default:
      throw new Error("LEGACY_RELAY_UNKNOWN_TABLE");
  }
  return result;
}

async function recipientFor(ctx: Context, owner: Ownership) {
  const { chat, chatId, workspace, userId, ownerOnly } = owner;
  if (!workspace) throw new Error("LEGACY_RELAY_MISSING_WORKSPACE");
  // A deleted chat has no key audience; its history stays in custody.
  if (chatId && !chat && !ownerOnly) return undefined;
  if (ownerOnly) return activeLegacyRecipient(ctx, { workspace, purpose: "owner" });
  if (chat) return activeLegacyRecipient(ctx, { chat: chat._id, workspace });
  if (userId) return activeLegacyRecipient(ctx, { userId });
  return activeLegacyRecipient(ctx, { workspace, purpose: "owner" });
}

type Extraction = { value: Record<string, unknown>; patch: Record<string, unknown> };

/**
 * The formerly plaintext fields of one relay row and the values that replace them. Fixed Worker
 * codes, native sealed bytes, receipts and identifiers are never content. Pure and content-free
 * about status: the quiesce rules live in `ACTIVE_WORK`.
 */
async function extractPlaintext(ctx: Context, table: string, row: RelayRow): Promise<Extraction> {
  const value: Record<string, unknown> = {};
  const patch: Record<string, unknown> = {};
  const extract = (field: string, replacement: unknown = undefined) => {
    if (row[field] === undefined) return;
    value[field] = row[field];
    patch[field] = replacement;
  };
  switch (table) {
    case "chat_frames":
      // `payload` is bytes for native sealed frames; the placeholder is empty once extracted.
      if (typeof row.payload === "string" && !(row.legacyContent && row.payload === ""))
        extract("payload", "");
      break;
    case "acp_sessions":
      if (!(row.sealedError && row.error === ACP_SEALED_ERROR_TEXT)) extract("error");
      for (const field of ["config", "commands", "draft"]) extract(field);
      break;
    case "acp_commands":
      extract("payload");
      // Fixed codes (Worker-reported or backend-written, e.g. a cancellation) are metadata, never sealed.
      if (!isPersistedAcpErrorCode(row.error)) extract("error");
      // A fork receipt names its target chat, which is an identifier, not content.
      if (
        !(
          row.kind === "fork" &&
          typeof row.result === "string" &&
          ctx.db.normalizeId("aisdk_chats", row.result)
        )
      )
        extract("result");
      break;
    case "acp_agent_sessions":
      extract("title");
      break;
    case "acp_interactions":
      extract("request");
      extract("answer");
      break;
    case "worker_tasks":
      for (const field of ["editRequest", "bashRequest", "result"]) extract(field);
      break;
    case "worker_chat_calls": {
      extract("result");
      // Legacy canonical request keys embed input paths/patches/commands; native request IDs do not.
      const nativeKey =
        row.chatId && row.toolCallId && row.stage
          ? await workerChatTaskRequestId(row.chatId, row.toolCallId, row.stage)
          : undefined;
      if (row.requestKey !== nativeKey && !(row.legacyContent && row.requestKey === ""))
        extract("requestKey", "");
      break;
    }
    case "worker_agents":
      // Diagnostic free text only. Status, capabilities, defaults and auth methods are routing and
      // availability metadata and stay operational; fixed error codes are metadata too.
      if (!isPersistedAcpErrorCode(row.error)) extract("error");
      if (row.sessionsSync?.error !== undefined && !isPersistedAcpErrorCode(row.sessionsSync.error)) {
        value.sessionsSync = row.sessionsSync;
        const { error: _error, ...routing } = row.sessionsSync;
        patch.sessionsSync = routing;
      }
      break;
    default:
      throw new Error("LEGACY_RELAY_UNKNOWN_TABLE");
  }
  return { value, patch };
}

/** Unfinished work that plaintext rows of these tables could still make a Worker perform. */
const ACTIVE_WORK = {
  acp_commands: {
    error: "LEGACY_RELAY_QUIESCE_COMMAND",
    active: (status: string) => status === "pending" || status === "claimed",
  },
  acp_interactions: {
    error: "LEGACY_RELAY_QUIESCE_INTERACTION",
    active: (status: string) => status === "pending" || status === "answered",
  },
  worker_tasks: {
    error: "LEGACY_RELAY_QUIESCE_TASK",
    active: (status: string) => !TASK_TERMINAL.includes(status),
  },
} as const;

type ActiveTable = keyof typeof ACTIVE_WORK;

function isActiveTable(table: string): table is ActiveTable {
  return Object.hasOwn(ACTIVE_WORK, table);
}

/**
 * The table of a plaintext-bearing command, interaction or task that is still unfinished, which
 * blocks sealing because sealing would hide work a Worker could still execute. Null for sealed
 * rows, finished rows and rows without plaintext. Used by sealing and by operator discovery, so
 * both always agree on what blocks.
 */
export async function activeWorkBlocker(
  ctx: Context,
  table: string,
  input: Record<string, unknown>,
): Promise<ActiveTable | null> {
  const row = input as RelayRow;
  if (!isActiveTable(table) || row.legacyContent || !ACTIVE_WORK[table].active(row.status))
    return null;
  const { value } = await extractPlaintext(ctx, table, row);
  return Object.keys(value).length ? table : null;
}

/**
 * Historical relay data is extracted into a sidecar and never acquires a Worker/user signature or
 * live command authority. Active plaintext work (pending/claimed commands, open interactions,
 * unfinished tasks, warm or busy sessions) blocks instead of being replayed, cancelled or sealed
 * under a fake signature. Native signed ciphertext, receipts and fixed Worker error codes are never
 * touched.
 */
export const domain = {
  tables: [
    "chat_frames",
    "acp_sessions",
    "acp_commands",
    "acp_agent_sessions",
    "acp_interactions",
    "worker_tasks",
    "worker_chat_calls",
    "worker_agents",
  ] as const,

  async inspect(ctx: Context, table: string, input: Record<string, unknown>) {
    const row = input as RelayRow;
    const owner = await ownership(ctx, table, row);
    const { value, patch } = await extractPlaintext(ctx, table, row);

    if (Object.keys(value).length) {
      if (isActiveTable(table) && ACTIVE_WORK[table].active(row.status))
        throw new Error(ACTIVE_WORK[table].error);
      if (table === "worker_chat_calls") {
        const task = row.taskId ? await ctx.db.get(row.taskId) : null;
        if (task && !TASK_TERMINAL.includes(task.status))
          throw new Error("LEGACY_RELAY_QUIESCE_TASK");
      }
    }

    if (!Object.keys(value).length) return null;
    if (row.legacyContent) throw new Error("LEGACY_RELAY_SIDECAR_CONFLICT");
    if (!owner.workspace) throw new Error("LEGACY_RELAY_MISSING_WORKSPACE");
    if (owner.requiresQuietChat && owner.chat) {
      const chatId = owner.chat._id;
      const session =
        table === "acp_sessions"
          ? row
          : await ctx.db
              .query("acp_sessions")
              .withIndex("by_chat", (q) => q.eq("chat", chatId))
              .unique();
      if (session && (session.warm || ACP_BUSY_STATUSES.some((status) => status === session.status)))
        throw new Error("LEGACY_RELAY_QUIESCE_SESSION");
    }
    return {
      value,
      patch,
      workspace: owner.workspace,
      userId: owner.userId,
      recipient: await recipientFor(ctx, owner),
    };
  },

  /** The exact current key audience of a custodial row; undefined keeps custody. */
  async releaseRecipient(ctx: Context, table: string, input: Record<string, unknown>) {
    return recipientFor(ctx, await ownership(ctx, table, input as RelayRow));
  },
} satisfies LegacyAdapter;

/**
 * Delete one relay row together with its historical sidecar storage and custody registration.
 * Every relay deletion path (retention, cleanup, replacement) uses it so encrypted envelopes in
 * File Storage never outlive their row.
 */
export async function deleteRelayRow<Table extends (typeof domain.tables)[number]>(
  ctx: MutationCtx,
  table: Table,
  row: { _id: Id<Table>; legacyContent?: unknown },
) {
  if (row.legacyContent) await deleteLegacySidecar(ctx, { table, record: row._id });
  await ctx.db.delete(table, row._id);
}
