import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { acpAgents, acpSessions } from "./schema";

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
