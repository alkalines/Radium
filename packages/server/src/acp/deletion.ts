import { and, eq } from "drizzle-orm";
import type { Chat } from "../chatroom/access";
import type { Database } from "../drivers/types";
import {
  findAgent,
  findSession,
  insertSignedCommand,
  verifySignedCommand,
  type SignedCommand,
} from "./policy";
import { epochStreamPath } from "./live";
import { acpAgentSessions } from "./schema";

/**
 * Chat deletion hook, in the deleting transaction before the chat row goes: tells the bound
 * Worker through the caller's signed `close`/`delete` command (kind per `deleteInAgent` and the
 * agent's `delete` capability; statement chat = this chat), stored with a snapshot of the chat's
 * binding so the Worker can authorize it once the chat is gone. Nothing is queued without a
 * signed command, a published binding or a proven session id, since a paired Worker would refuse
 * it anyway. Deleting in the agent also drops the session's index entry. Returns the Worker whose
 * warm set must drop the chat after commit and the open epoch's stream to delete with the chat,
 * or null for a built-in chat.
 */
export async function queueAcpChatDeletion(
  tx: Database,
  chat: Chat,
  userId: string,
  options: { deleteInAgent?: boolean; signed?: SignedCommand },
): Promise<{ worker: string; streams: string[] } | null> {
  const session = await findSession(tx, chat.id, true);
  if (!session) return null;
  if (session.sessionId) {
    const agent = await findAgent(tx, session.worker, session.agentId);
    const kind = options.deleteInAgent && agent?.capabilities.delete ? "delete" : "close";
    if (kind === "delete") {
      await tx
        .delete(acpAgentSessions)
        .where(
          and(
            eq(acpAgentSessions.worker, session.worker),
            eq(acpAgentSessions.agentId, session.agentId),
            eq(acpAgentSessions.sessionId, session.sessionId),
          ),
        );
    }
    if (options.signed && session.binding && session.sessionProof && chat.e2eeId) {
      await verifySignedCommand(tx, {
        workspace: session.workspace,
        worker: session.worker,
        chat: chat.id,
        kind,
        userId,
        signed: options.signed,
      });
      await insertSignedCommand(tx, {
        workspace: session.workspace,
        worker: session.worker,
        issuedBy: userId,
        kind,
        signed: options.signed,
        agentId: session.agentId,
        target: {
          chat: chat.id,
          e2eeId: chat.e2eeId,
          creatorUserId: chat.userId,
          agentId: session.agentId,
          profile: session.profile,
          cwd: session.cwd,
          sessionId: session.sessionId,
          binding: session.binding,
          sessionProof: session.sessionProof,
        },
      });
    }
  }
  // A cooled epoch's stream is already deleted; superseded ones have their own deletion jobs.
  const open = session.epoch > 0 && session.epoch > (session.cooledEpoch ?? 0);
  return { worker: session.worker, streams: open ? [epochStreamPath(chat.id, session.epoch)] : [] };
}
