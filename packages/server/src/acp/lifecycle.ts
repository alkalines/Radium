import { and, eq, ne } from "drizzle-orm";
import {
  ACP_SEALED_ERROR_TEXT,
  ACP_SEALED_SHORT_BYTES,
  validAcpToken,
  type AcpSessionStatus,
  type AcpStopReason,
  type AcpTurnReport,
  type AcpTurnUsage,
  type AcpUsage,
} from "contracts/acp/contract";
import type { NotificationKind } from "contracts/notifications/contract";
import { toBase64Url } from "radium-crypto";
import { chatWithWorkspace, type Chat, type ChatWorkspace } from "../chatroom/access";
import { saveSealedTitle, touchChat } from "../chatroom/chats";
import type { Database } from "../drivers/types";
import { chatKeyIsStale } from "../e2ee/chat-keys";
import { notify } from "../notifications/notify";
import { recordAcpTurn } from "../usage/agent-turns";
import { acpError, type AcpSession, type SealedShort } from "./policy";
import { acpAgentSessions, acpSessions } from "./schema";

/*
 * Durable ACP session lifecycle (Convex `applySessionPatch`): the bound Worker's status, usage,
 * session id and sealed title/error boundaries, mirrored onto the chat (Home order, interruption)
 * and the agent session index, with the turn's usage record and the notifications its end owes.
 */

/**
 * A lifecycle patch from the bound Worker of a keyed workspace. There is no free text: titles and
 * errors are sealed (`sealedTitle` to the chat key with the `chats` title AAD, `sealedError` to the
 * chat key with the `acp_sessions` error AAD, null clears it, `indexTitle` to the owner key), and
 * every new `sessionId` comes with the Worker's `sessionProof` signature.
 */
export type SessionPatch = {
  status?: AcpSessionStatus;
  stopReason?: AcpStopReason;
  /** Only `null` (clear the error); text is refused at the boundary. */
  error?: null;
  usage?: AcpUsage;
  turnUsage?: AcpTurnUsage;
  history?: "full" | "resumed" | "none";
  sessionId?: string;
  sealedTitle?: SealedShort;
  sealedError?: SealedShort | null;
  indexTitle?: SealedShort & { tag: string };
  sessionProof?: Uint8Array;
  /** Usage facts of the turn this patch ends; recorded once per prompt command. */
  turn?: AcpTurnReport;
};

/** E2EE facts a paired Worker verifies before acting on a chat. */
export async function chatE2ee(db: Database, session: AcpSession, chat: Chat, workspace: ChatWorkspace) {
  if (!chat.e2eeId) return null;
  return {
    e2eeId: chat.e2eeId,
    keyEpoch: chat.keyEpoch,
    rekey: await chatKeyIsStale(db, chat, workspace),
    creatorUserId: chat.userId,
    binding: session.binding,
    sessionProof: session.sessionProof,
  };
}

/**
 * A Worker-sealed title or error box addressed to the chat's current key epoch. A stale epoch
 * (revoked reader or rotated workspace key) is refused: the chat must rotate first.
 */
async function requireChatBox(
  db: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  value: SealedShort,
) {
  if (
    !chat.e2eeId ||
    value.epoch !== chat.keyEpoch ||
    value.box.byteLength === 0 ||
    value.box.byteLength > ACP_SEALED_SHORT_BYTES ||
    (await chatKeyIsStale(db, chat, workspace))
  )
    acpError("ACP_INVALID_SEALED");
}

/**
 * Applies `patch` to `session` (locked by the caller) in the caller's transaction. Returns the
 * outbox jobs (turn pricing, notification sealing and push) to dispatch after commit.
 */
export async function applySessionPatch(
  tx: Database,
  session: AcpSession,
  patch: SessionPatch,
): Promise<(string | null)[]> {
  const found = await chatWithWorkspace(tx, session.chat);
  if (!found) acpError("ACP_DENIED");
  const { chat, workspace } = found;
  const now = new Date();
  const jobs: (string | null)[] = [];
  const updates: Partial<typeof acpSessions.$inferInsert> = { updatedAt: now };
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.stopReason !== undefined) updates.stopReason = patch.stopReason;
  if (patch.usage !== undefined) updates.usage = patch.usage;
  if (patch.turnUsage !== undefined) updates.turnUsage = patch.turnUsage;
  if (patch.history !== undefined) updates.history = patch.history;
  if (patch.error === null || patch.sealedError === null) {
    updates.error = null;
    updates.sealedErrorEpoch = null;
    updates.sealedErrorBox = null;
  } else if (patch.sealedError) {
    await requireChatBox(tx, chat, workspace, patch.sealedError);
    updates.sealedErrorEpoch = patch.sealedError.epoch;
    updates.sealedErrorBox = patch.sealedError.box;
    updates.error = ACP_SEALED_ERROR_TEXT;
  }

  const { sessionId } = patch;
  if (sessionId !== undefined) {
    if (!validAcpToken(sessionId)) acpError("ACP_INVALID_SESSION_ID");
    if (session.sessionId && session.sessionId !== sessionId) acpError("ACP_SESSION_BOUND");
    if (!session.sessionId) {
      const [bound] = await tx
        .select({ chat: acpSessions.chat })
        .from(acpSessions)
        .where(
          and(
            eq(acpSessions.worker, session.worker),
            eq(acpSessions.agentId, session.agentId),
            eq(acpSessions.sessionId, sessionId),
            ne(acpSessions.chat, session.chat),
          ),
        );
      if (bound) acpError("ACP_SESSION_BOUND");
    }
    updates.sessionId = sessionId;
  }
  // A paired Worker proves each session id it binds; Workers verify the proof before reopening.
  if (patch.sessionProof) {
    if (!(sessionId ?? session.sessionId) || patch.sessionProof.byteLength !== 64)
      acpError("ACP_INVALID_SESSION_ID");
    if (!session.sessionProof || sessionId !== undefined)
      updates.sessionProof = { kind: "worker", signature: toBase64Url(patch.sessionProof) };
  }

  if (patch.sealedTitle) {
    await requireChatBox(tx, chat, workspace, patch.sealedTitle);
    if (!session.userTitled) await saveSealedTitle(tx, chat, patch.sealedTitle, ACP_SEALED_SHORT_BYTES);
  }
  if (
    patch.indexTitle &&
    (patch.indexTitle.box.byteLength === 0 ||
      patch.indexTitle.box.byteLength > ACP_SEALED_SHORT_BYTES ||
      patch.indexTitle.tag.length > 64)
  )
    acpError("ACP_INVALID_SEALED");
  const indexedSessionId = sessionId ?? session.sessionId;
  if (indexedSessionId && (sessionId !== undefined || patch.indexTitle !== undefined)) {
    // Keyed chats keep only the Worker's owner-sealed index title.
    const title = patch.indexTitle
      ? {
          title: null,
          sealedTitleEpoch: patch.indexTitle.epoch,
          sealedTitleBox: patch.indexTitle.box,
          titleTag: patch.indexTitle.tag,
        }
      : {};
    await tx
      .insert(acpAgentSessions)
      .values({
        workspace: session.workspace,
        worker: session.worker,
        agentId: session.agentId,
        sessionId: indexedSessionId,
        cwd: session.cwd,
        ...title,
        updatedAt: now,
        chat: chat.id,
      })
      .onConflictDoUpdate({
        target: [acpAgentSessions.worker, acpAgentSessions.agentId, acpAgentSessions.sessionId],
        set: { chat: chat.id, ...title },
      });
  }

  let notification: NotificationKind | undefined;
  if (patch.status === "running") {
    updates.draft = null;
    if (session.status !== "running") await touchChat(tx, chat.id, { interruption: null });
  } else if (patch.status === "idle") {
    const stopReason = patch.stopReason ?? session.stopReason;
    await touchChat(tx, chat.id, {
      interruption: stopReason === "cancelled" ? { kind: "interrupted" } : null,
    });
    if (
      stopReason === "end_turn" &&
      (session.status === "running" || session.status === "awaiting")
    )
      notification = "session_finished";
  } else if (patch.status === "failed") {
    // Raw agent error text never reaches the chat row: it keeps only the generic kind.
    await touchChat(tx, chat.id, { interruption: { kind: "failed" } });
    if (session.status !== "failed") notification = "session_failed";
  }
  await tx.update(acpSessions).set(updates).where(eq(acpSessions.id, session.id));

  if (patch.turn && (patch.status === "idle" || patch.status === "failed")) {
    // Usage never rejects the turn's state transition (savepoint inside `recordAcpTurn`).
    const turn = await recordAcpTurn(tx, session, patch.turn, patch.turnUsage, patch.stopReason);
    if (turn.status === "recorded") jobs.push(turn.job);
  }
  if (notification && session.turnBy) {
    await notify(
      tx,
      { userId: session.turnBy, workspace: session.workspace, kind: notification, chat: chat.id },
      jobs,
    );
  }
  return jobs;
}
