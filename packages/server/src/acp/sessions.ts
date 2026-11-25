import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { acpAgentSessions, acpAgents, acpCommands, acpSessions } from "./schema";

/** The agent binding of an ACP chat, as the Chatroom shows it (no conversation content). */
export type AcpChatBinding = {
  agentId: string;
  agentVersion: string;
  profile: (typeof acpSessions.$inferSelect)["profile"];
  worker: string;
  cwd: string;
  /** The workspace definition's configured name, else the agent id. */
  name: string;
};

/**
 * The ACP bindings of `chatIds` in `workspace`, by chat; chats without one are built-in chats.
 * One query; callers authorized every chat first.
 */
export async function acpChatBindings(
  db: Database,
  workspace: string,
  chatIds: string[],
): Promise<Map<string, AcpChatBinding>> {
  if (chatIds.length === 0) return new Map();
  const rows = await db
    .select({
      chat: acpSessions.chat,
      agentId: acpSessions.agentId,
      agentVersion: acpSessions.agentVersion,
      profile: acpSessions.profile,
      worker: acpSessions.worker,
      cwd: acpSessions.cwd,
      name: acpAgents.name,
    })
    .from(acpSessions)
    .leftJoin(
      acpAgents,
      and(eq(acpAgents.workspace, acpSessions.workspace), eq(acpAgents.agentId, acpSessions.agentId)),
    )
    .where(and(eq(acpSessions.workspace, workspace), inArray(acpSessions.chat, chatIds)));
  return new Map(
    rows.map(({ chat, name, ...binding }) => [chat, { ...binding, name: name ?? binding.agentId }]),
  );
}

/** Whether `chat` is an ACP chat (has a session row). */
export async function isAcpChat(db: Database, chat: string): Promise<boolean> {
  const [row] = await db
    .select({ id: acpSessions.id })
    .from(acpSessions)
    .where(eq(acpSessions.chat, chat))
    .limit(1);
  return row !== undefined;
}

/** Marks an ACP chat as user-titled, so later agent-reported titles do not replace the rename. */
export async function markAcpChatUserTitled(tx: Database, chat: string): Promise<void> {
  await tx.update(acpSessions).set({ userTitled: true }).where(eq(acpSessions.chat, chat));
}

/** The agent session id and Worker of each ACP chat of `chatIds` that has a session id bound. */
export async function acpChatSessionIds(
  db: Database,
  workspace: string,
  chatIds: string[],
): Promise<Map<string, { sessionId: string; worker: string }>> {
  if (chatIds.length === 0) return new Map();
  const rows = await db
    .select({ chat: acpSessions.chat, sessionId: acpSessions.sessionId, worker: acpSessions.worker })
    .from(acpSessions)
    .where(
      and(
        eq(acpSessions.workspace, workspace),
        inArray(acpSessions.chat, chatIds),
        isNotNull(acpSessions.sessionId),
      ),
    );
  return new Map(rows.map((row) => [row.chat, { sessionId: row.sessionId!, worker: row.worker }]));
}

/**
 * Chats bound to the agent session ids `sessionIds` in `workspace` (usage attribution), oldest
 * binding first. One query on `acp_sessions_session`.
 */
export async function acpSessionsBySessionId(db: Database, workspace: string, sessionIds: string[]) {
  if (sessionIds.length === 0) return [];
  const rows = await db
    .select({
      chat: acpSessions.chat,
      worker: acpSessions.worker,
      agentId: acpSessions.agentId,
      sessionId: acpSessions.sessionId,
    })
    .from(acpSessions)
    .where(and(eq(acpSessions.workspace, workspace), inArray(acpSessions.sessionId, sessionIds)))
    .orderBy(asc(acpSessions.createdAt), asc(acpSessions.id));
  return rows.map((row) => ({ ...row, sessionId: row.sessionId! }));
}

/**
 * Agent session index entries (`session/list`) with the session ids `sessionIds` in `workspace`
 * (usage attribution: their agent, folder and opened chat), oldest first.
 */
export async function agentSessionsBySessionId(
  db: Database,
  workspace: string,
  sessionIds: string[],
) {
  if (sessionIds.length === 0) return [];
  return await db
    .select({
      chat: acpAgentSessions.chat,
      worker: acpAgentSessions.worker,
      agentId: acpAgentSessions.agentId,
      sessionId: acpAgentSessions.sessionId,
      cwd: acpAgentSessions.cwd,
    })
    .from(acpAgentSessions)
    .where(
      and(eq(acpAgentSessions.workspace, workspace), inArray(acpAgentSessions.sessionId, sessionIds)),
    )
    .orderBy(asc(acpAgentSessions.createdAt), asc(acpAgentSessions.id));
}

/** The first `limit` agent definitions of a workspace by agent id: id, name and command. */
export async function acpAgentDefinitions(db: Database, workspace: string, limit: number) {
  return await db
    .select({ agentId: acpAgents.agentId, name: acpAgents.name, command: acpAgents.command })
    .from(acpAgents)
    .where(eq(acpAgents.workspace, workspace))
    .orderBy(asc(acpAgents.agentId))
    .limit(limit);
}

/** Configured names of the agent definitions `agentIds` in `workspace`, by agent id. */
export async function acpAgentNames(
  db: Database,
  workspace: string,
  agentIds: string[],
): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({ agentId: acpAgents.agentId, name: acpAgents.name })
    .from(acpAgents)
    .where(and(eq(acpAgents.workspace, workspace), inArray(acpAgents.agentId, agentIds)));
  return new Map(rows.map((row) => [row.agentId, row.name]));
}

/**
 * Who issued `command` when it is a prompt command of `chat` (a turn report's idempotency key),
 * else `null`: another chat's command, another kind, or an unknown or pruned id.
 */
export async function promptCommandIssuer(
  db: Database,
  chat: string,
  command: string,
): Promise<string | null> {
  const [row] = await db
    .select({ issuedBy: acpCommands.issuedBy })
    .from(acpCommands)
    .where(
      and(eq(acpCommands.id, command), eq(acpCommands.chat, chat), eq(acpCommands.kind, "prompt")),
    );
  return row?.issuedBy ?? null;
}
