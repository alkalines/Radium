import type { AcpCommandInfo, AcpConfig } from "contracts/acp/contract";
import { openLegacyContent, type SealedLegacyBox } from "./legacy-content";

/**
 * Browser readers for sealed historical relay data (ACP sessions and the agent session index).
 * Everything here is for display: a sidecar never carries a Worker or user signature, so none of
 * it can be turned back into a command, answer or task.
 */

/** Session fields the migration moved out of `acp_sessions`; they fill in only where live data is absent. */
export type HistoricalAcpSession = {
  error?: string;
  config?: AcpConfig;
  commands?: AcpCommandInfo[];
};

export function openHistoricalAcpSession(
  session: { _id: string; legacyContent: SealedLegacyBox },
  context: { workspace: string; chatId: string },
) {
  return openLegacyContent<HistoricalAcpSession>(session.legacyContent, {
    table: "acp_sessions",
    record: session._id,
    workspace: context.workspace,
    chatId: context.chatId,
  });
}

/** The owner-key sealed title of an agent session index row, or `undefined` for an untitled one. */
export async function openHistoricalAgentTitle(
  row: { _id: string; legacyContent: SealedLegacyBox },
  workspace: string,
): Promise<string | undefined> {
  const content = await openLegacyContent<{ title?: string }>(row.legacyContent, {
    table: "acp_agent_sessions",
    record: row._id,
    workspace,
  });
  return content.title?.trim() || undefined;
}
