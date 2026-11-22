import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { AcpCommandInfo, AcpConfig, AcpDraftConfig } from "contracts/acp/contract";
import type { AcpFrame } from "contracts/acp/fold";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { FunctionArgs } from "convex/server";
import { cryptoClient } from "./runtime";
import { openLegacyContent } from "./legacy-content";

/**
 * Browser readers for sealed historical relay data (ACP, Worker and index rows). Everything here is
 * for display or export: a sidecar never carries a Worker or user signature, so none of it can be
 * turned back into a command, answer or task.
 */

/** Opens a commands, interactions, tasks, receipts, presence or catalog sidecar for display. */
export async function openHistoricalRelayContent(
  record: FunctionArgs<typeof api.e2ee_legacy_relay.HistoricalRelayContent>["record"],
) {
  const row = await cryptoClient().query(api.e2ee_legacy_relay.HistoricalRelayContent, { record });
  if (!row) return null;
  const value = await openLegacyContent<Record<string, unknown>>(row.legacyContent, {
    table: row.table,
    record: row.record,
    workspace: row.workspace,
    chatId: row.chatId,
  });
  return { historical: true as const, value };
}

/** Session fields the migration moved out of `acp_sessions`; they fill in only where live data is absent. */
export type HistoricalAcpSession = {
  error?: string;
  config?: AcpConfig;
  commands?: AcpCommandInfo[];
  draft?: AcpDraftConfig;
};

export function openHistoricalAcpSession(
  session: { _id: Id<"acp_sessions">; legacyContent: LegacyBox },
  context: { workspace: Id<"workspaces">; chatId: Id<"aisdk_chats"> },
) {
  return openLegacyContent<HistoricalAcpSession>(session.legacyContent, {
    table: "acp_sessions",
    record: session._id,
    workspace: context.workspace,
    chatId: context.chatId,
  });
}

/** A `chatroom.LiveFrames` row whose JSON payload was sealed into a historical sidecar. */
export type HistoricalFrameRow = {
  _id: Id<"chat_frames">;
  seqFrom: number;
  seqTo: number;
  kind: AcpFrame["kind"];
  legacyContent: LegacyBox;
};

/** Narrows any frame row to its historical form, keeping the row's other fields. */
export function isHistoricalFrame<
  Row extends { _id?: Id<"chat_frames">; legacyContent?: LegacyBox },
>(row: Row): row is Row & { _id: Id<"chat_frames">; legacyContent: LegacyBox } {
  return row._id !== undefined && row.legacyContent !== undefined;
}

/** Opens sealed frames into plain frames. Any unreadable frame fails the batch, never a partial fold. */
export function openHistoricalAcpFrames(
  rows: readonly HistoricalFrameRow[],
  context: { workspace: Id<"workspaces">; chatId: Id<"aisdk_chats"> },
): Promise<AcpFrame[]> {
  return Promise.all(
    rows.map(async (row) => {
      const content = await openLegacyContent<{ payload?: unknown }>(row.legacyContent, {
        table: "chat_frames",
        record: row._id,
        workspace: context.workspace,
        chatId: context.chatId,
      });
      if (typeof content.payload !== "string")
        throw new Error("A historical agent frame has no readable content.");
      return { seqFrom: row.seqFrom, seqTo: row.seqTo, kind: row.kind, payload: content.payload };
    }),
  );
}

/** The owner-key sealed title of an agent session index row, or `undefined` for an untitled one. */
export async function openHistoricalAgentTitle(
  row: { _id: Id<"acp_agent_sessions">; legacyContent: LegacyBox },
  workspace: Id<"workspaces">,
): Promise<string | undefined> {
  const content = await openLegacyContent<{ title?: string }>(row.legacyContent, {
    table: "acp_agent_sessions",
    record: row._id,
    workspace,
  });
  return content.title?.trim() || undefined;
}
