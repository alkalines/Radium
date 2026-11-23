import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as z from "zod";
import {
  BUILTIN_TOOL_SETS,
  enabledBuiltinToolSets,
  storedBuiltinToolSets,
} from "contracts/chatroom/tools";
import type { Database } from "../drivers/types";
import { readWorkspaceSettings, updateWorkspaceSettings } from "../workspaces/settings";
import { workspaceMcpServers } from "../workspaces/schema";
import { chatMcpServers, chats, mcpServers } from "./schema";

/**
 * Workspace tool selections: which built-in tool sets and MCP servers are active for workspace
 * defaults and per-chat overrides. Defaults live in `workspace_settings` (built-in columns) and
 * `workspace_mcp_servers`; a chat override in the `chats` columns and `chat_mcp_servers`. Callers
 * authorize the workspace or chat first.
 */

const VALID_BUILTIN_IDS = new Set<string>(BUILTIN_TOOL_SETS.map((toolSet) => toolSet.id));

/** Bound on MCP servers in one selection. */
export const MAX_SELECTED_MCP_SERVERS = 200;

/**
 * Built-in tool set ids plus workspace MCP server ids, as clients send them: the complete list
 * of enabled sets, including default-on ones. Storage converts it with {@link storedSelection}.
 */
export const toolSelectionInput = z.object({
  builtinToolSets: z.array(z.string().max(64)).max(64),
  mcpServers: z.array(z.string().min(1).max(256)).max(MAX_SELECTED_MCP_SERVERS),
});

/** A complete selection of enabled built-in set ids and workspace MCP server ids. */
export type WorkspaceToolSelection = {
  builtinToolSets: string[];
  mcpServers: string[];
};

/** A selection as stored: opt-in ids for ordinary sets, opt-out ids for default-on sets. */
export type StoredToolSelection = {
  builtinToolSets: string[];
  disabledBuiltinToolSets: string[];
  mcpServers: string[];
};

/**
 * Sanitise a selection against the workspace: unknown built-in ids, duplicates and MCP servers
 * that are not this workspace's are dropped silently. With `lock`, the kept server rows are
 * share-locked for the transaction so a concurrent server delete cannot slip between this check
 * and the write that references them.
 */
async function sanitizeSelection(
  db: Database,
  workspace: string,
  selection: WorkspaceToolSelection,
  lock?: "share",
): Promise<WorkspaceToolSelection> {
  const builtinToolSets = selection.builtinToolSets.filter((id) => VALID_BUILTIN_IDS.has(id));
  const requested = [...new Set(selection.mcpServers)];
  if (requested.length === 0) return { builtinToolSets, mcpServers: [] };

  let query = db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.workspace, workspace), inArray(mcpServers.id, requested)))
    .$dynamic();
  if (lock) query = query.for(lock);
  const existing = new Set((await query).map((row) => row.id));
  return { builtinToolSets, mcpServers: requested.filter((id) => existing.has(id)) };
}

/** The effective selection of a stored one: default-on sets count unless switched off. */
export function effectiveSelection(stored: StoredToolSelection): WorkspaceToolSelection {
  return {
    builtinToolSets: enabledBuiltinToolSets(stored),
    mcpServers: stored.mcpServers,
  };
}

/** The workspace defaults as stored; every column at its default when no settings row exists. */
export async function readWorkspaceStoredSelection(
  db: Database,
  workspace: string,
): Promise<StoredToolSelection> {
  const [settings, servers] = await Promise.all([
    readWorkspaceSettings(db, workspace),
    db
      .select({ id: workspaceMcpServers.mcpServer })
      .from(workspaceMcpServers)
      .where(eq(workspaceMcpServers.workspace, workspace))
      .orderBy(asc(workspaceMcpServers.createdAt), asc(workspaceMcpServers.id)),
  ]);
  return {
    builtinToolSets: settings?.builtinToolSets ?? [],
    disabledBuiltinToolSets: settings?.disabledBuiltinToolSets ?? [],
    mcpServers: servers.map((row) => row.id),
  };
}

/** The effective workspace default selection. */
export async function readWorkspaceSelection(db: Database, workspace: string) {
  return effectiveSelection(await readWorkspaceStoredSelection(db, workspace));
}

/** The chat's own override as stored, or `null` when it inherits the workspace defaults. */
export async function readChatStoredSelection(
  db: Database,
  chat: Pick<typeof chats.$inferSelect, "id" | "builtinToolSets" | "disabledBuiltinToolSets">,
): Promise<StoredToolSelection | null> {
  if (chat.builtinToolSets === null || chat.disabledBuiltinToolSets === null) return null;
  const servers = await db
    .select({ id: chatMcpServers.mcpServer })
    .from(chatMcpServers)
    .where(eq(chatMcpServers.chat, chat.id))
    .orderBy(asc(chatMcpServers.createdAt), asc(chatMcpServers.id));
  return {
    builtinToolSets: chat.builtinToolSets,
    disabledBuiltinToolSets: chat.disabledBuiltinToolSets,
    mcpServers: servers.map((row) => row.id),
  };
}

/** A chat's effective selection and where it comes from. */
export async function readChatSelection(
  db: Database,
  chat: Pick<typeof chats.$inferSelect, "id" | "workspace" | "builtinToolSets" | "disabledBuiltinToolSets">,
): Promise<WorkspaceToolSelection & { source: "chat" | "defaults" }> {
  const own = await readChatStoredSelection(db, chat);
  if (own) return { ...effectiveSelection(own), source: "chat" };
  return { ...(await readWorkspaceSelection(db, chat.workspace)), source: "defaults" };
}

/**
 * Sanitise a client selection and convert it to its stored form, recording switched-off
 * default-on sets as opt-outs. Use for every write of defaults or a chat override.
 */
export async function storedSelection(
  db: Database,
  workspace: string,
  selection: WorkspaceToolSelection,
  lock?: "share",
): Promise<StoredToolSelection> {
  const sanitized = await sanitizeSelection(db, workspace, selection, lock);
  return {
    ...storedBuiltinToolSets(sanitized.builtinToolSets),
    mcpServers: sanitized.mcpServers,
  };
}

/**
 * Replaces the workspace default selection. One transaction: concurrent replacements serialize
 * (the last one wins whole), and a server deleted meanwhile cannot be referenced.
 */
export async function writeWorkspaceSelection(
  db: Database,
  workspace: string,
  selection: WorkspaceToolSelection,
) {
  await db.transaction(async (tx) => {
    await lockSelection(tx, `tools:${workspace}`);
    const stored = await storedSelection(tx, workspace, selection, "share");
    await updateWorkspaceSettings(tx, workspace, {
      builtinToolSets: stored.builtinToolSets,
      disabledBuiltinToolSets: stored.disabledBuiltinToolSets,
    });
    await tx.delete(workspaceMcpServers).where(eq(workspaceMcpServers.workspace, workspace));
    if (stored.mcpServers.length > 0) {
      await tx
        .insert(workspaceMcpServers)
        .values(stored.mcpServers.map((mcpServer) => ({ workspace, mcpServer })));
    }
  });
}

/**
 * Replaces a chat's override. The caller holds the chat row lock (`requireChatManager(…,
 * "update")`) inside `tx`, which serializes concurrent overrides of one chat.
 */
export async function writeChatSelection(
  tx: Database,
  chat: { id: string; workspace: string },
  selection: WorkspaceToolSelection,
) {
  const stored = await storedSelection(tx, chat.workspace, selection, "share");
  await tx
    .update(chats)
    .set({
      builtinToolSets: stored.builtinToolSets,
      disabledBuiltinToolSets: stored.disabledBuiltinToolSets,
    })
    .where(eq(chats.id, chat.id));
  await tx.delete(chatMcpServers).where(eq(chatMcpServers.chat, chat.id));
  if (stored.mcpServers.length > 0) {
    await tx
      .insert(chatMcpServers)
      .values(
        stored.mcpServers.map((mcpServer) => ({ chat: chat.id, workspace: chat.workspace, mcpServer })),
      );
  }
}

async function lockSelection(tx: Database, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
