import type { AcpStopReason, AcpTurnReport, AcpTurnUsage } from "contracts/acp/contract";
import type { acpSessions } from "../acp/schema";
import { promptCommandIssuer } from "../acp/sessions";
import type { Database } from "../drivers/types";
import { enqueueJob } from "../jobs/outbox";
import { PRICE_TURN_JOB } from "./prices";
import { acpUsage } from "./schema";

/** The fields of an ACP session row a turn record needs. */
export type TurnSession = Pick<
  typeof acpSessions.$inferSelect,
  "chat" | "workspace" | "worker" | "agentId" | "profile"
>;

/**
 * Outcome of {@link recordAcpTurn}: `recorded` with the pricing job to dispatch after commit;
 * `duplicate` for a retried report of a command already recorded; `ignored` for a Gateway-profile
 * session or a report naming another chat's, a non-prompt or an unknown command; `failed` when
 * the insert failed (logged, rolled back to a savepoint, the caller's transaction intact).
 */
export type AcpTurnRecord =
  | { status: "recorded"; turn: string; job: string | null }
  | { status: "duplicate" | "ignored" | "failed" };

/**
 * Record one finished prompt turn from the bound Worker's turn-end patch (slice 6 calls this in
 * the `updateSession` transaction, then `dispatchJobs` with `job` after commit). Pricing runs in
 * the queued job, so workspace provider reads never slow or fail the lifecycle write, and usage
 * never rejects the turn's state transition: everything runs under a savepoint. Idempotent per
 * prompt command through the `(chat, command)` unique index, since the Worker retries patches
 * whose receipt it lost.
 */
export async function recordAcpTurn(
  tx: Database,
  session: TurnSession,
  report: AcpTurnReport,
  tokens: AcpTurnUsage | undefined,
  stopReason: AcpStopReason | undefined,
  now = Date.now(),
): Promise<AcpTurnRecord> {
  // Gateway completions are the billing record, even for agents that send no session id.
  if (session.profile === "gateway") return { status: "ignored" };
  try {
    return await tx.transaction(async (sp): Promise<AcpTurnRecord> => {
      const userId = await promptCommandIssuer(sp, session.chat, report.command);
      if (userId === null) return { status: "ignored" };

      const agentCost =
        report.cost && Number.isFinite(report.cost.amount) && report.cost.amount >= 0
          ? { amount: report.cost.amount, currency: report.cost.currency.slice(0, 8) }
          : null;
      const [row] = await sp
        .insert(acpUsage)
        .values({
          workspace: session.workspace,
          chat: session.chat,
          worker: session.worker,
          agentId: session.agentId,
          command: report.command,
          userId,
          startedAt: new Date(Math.min(report.startedAt, now)),
          endedAt: new Date(now),
          stopReason: stopReason ?? null,
          // Bounded: the strings are the agent's own labels and only identify the model.
          modelId: report.model ? report.model.id.slice(0, 200) : null,
          modelName: report.model ? report.model.name.slice(0, 200) : null,
          modelDescription: report.model?.description
            ? report.model.description.slice(0, 500)
            : null,
          tokens: tokens ?? null,
          agentCostAmount: agentCost?.amount ?? null,
          agentCostCurrency: agentCost?.currency ?? null,
          pricing: { status: "pending" },
        })
        .onConflictDoNothing({ target: [acpUsage.chat, acpUsage.command] })
        .returning({ id: acpUsage.id });
      if (!row) return { status: "duplicate" };
      const job = await enqueueJob(sp, { kind: PRICE_TURN_JOB, payload: { turn: row.id } });
      return { status: "recorded", turn: row.id, job };
    });
  } catch {
    console.error("usage.acp_turn_record_failed");
    return { status: "failed" };
  }
}
