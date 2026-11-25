import { and, desc, eq, sql } from "drizzle-orm";
import { isTurnCovered, utcDay } from "contracts/usage/local_contract";
import { acpChatSessionIds } from "../acp/sessions";
import { requireChatAccess } from "../chatroom/access";
import type { Database } from "../drivers/types";
import { isGatewayCompletionWithoutChat } from "./completions";
import { acpUsage, chatCompletions, localUsage } from "./schema";

/** Rows read per source of one Session's cost. */
const SOURCE_LIMIT = 1000;

/** A Session's estimated total and how much of it is missing. */
export type ChatCost = {
  /** USD estimate of what was summed. */
  cost: number;
  /** Completions, local model rows and turns summed. */
  steps: number;
  /** Steps without a price. */
  unknown: number;
  /** Steps waiting for their first models.dev lookup. */
  pending: number;
};

/**
 * Estimated total cost of one Session, built-in or ACP, for anyone who can open it (Convex
 * `agent_usage.GetChatCost`; the same audience as the per-message Gateway cost). An unknown or
 * invisible chat is `NOT_FOUND`, so a workspace owner never learns a member's personal-chat cost.
 *
 * Built-in Sessions sum their Gateway completions. ACP Sessions sum the direct Gateway calls
 * their agent tagged with its session id, then, for days without such calls, the local rows
 * ccusage read for that session id, plus the priced turns those rows do not cover yet
 * (`isTurnCovered`), so an agent ccusage cannot read still has a total. Bounded to the newest
 * 1,000 rows of each source; the chat's own completions are summed in SQL.
 */
export async function getChatCost(db: Database, userId: string, chatId: string): Promise<ChatCost> {
  const { chat, workspace } = await requireChatAccess(db, userId, chatId);

  const recent = db
    .select({ cost: chatCompletions.cost })
    .from(chatCompletions)
    .where(eq(chatCompletions.chat, chat.id))
    .orderBy(desc(chatCompletions.createdAt), desc(chatCompletions.id))
    .limit(SOURCE_LIMIT)
    .as("recent");
  const [binding, [own]] = await Promise.all([
    acpChatSessionIds(db, workspace.id, [chat.id]).then((bindings) => bindings.get(chat.id)),
    db
      .select({
        steps: sql<number>`count(*)::int`,
        unknown: sql<number>`(count(*) filter (where ${recent.cost} is null))::int`,
        cost: sql<number>`coalesce(sum(${recent.cost}), 0)::float8`,
      })
      .from(recent),
  ]);
  const summary: ChatCost = {
    cost: Number(own?.cost ?? 0),
    steps: Number(own?.steps ?? 0),
    unknown: Number(own?.unknown ?? 0),
    pending: 0,
  };

  const [gatewayCalls, localRows, turns] = await Promise.all([
    binding
      ? db
          .select({
            createdAt: chatCompletions.createdAt,
            cost: chatCompletions.cost,
            chat: chatCompletions.chat,
            userId: chatCompletions.userId,
            apiKey: chatCompletions.apiKey,
          })
          .from(chatCompletions)
          .where(
            and(
              eq(chatCompletions.workspace, workspace.id),
              eq(chatCompletions.clientSession, binding.sessionId),
            ),
          )
          .orderBy(desc(chatCompletions.createdAt), desc(chatCompletions.id))
          .limit(SOURCE_LIMIT)
      : [],
    binding
      ? db
          .select({
            day: localUsage.day,
            syncedAt: localUsage.syncedAt,
            models: localUsage.models,
            priceKey: localUsage.priceKey,
          })
          .from(localUsage)
          .where(
            and(
              eq(localUsage.workspace, workspace.id),
              eq(localUsage.worker, binding.worker),
              eq(localUsage.sessionId, binding.sessionId),
            ),
          )
          .orderBy(desc(localUsage.day), desc(localUsage.id))
          .limit(SOURCE_LIMIT)
      : [],
    db
      .select({ endedAt: acpUsage.endedAt, pricing: acpUsage.pricing })
      .from(acpUsage)
      .where(eq(acpUsage.chat, chat.id))
      .orderBy(desc(acpUsage.createdAt), desc(acpUsage.id))
      .limit(SOURCE_LIMIT),
  ]);

  // Exact Gateway figures replace the agent's own records for the days they cover.
  const gatewayDays = new Set<string>();
  for (const completion of gatewayCalls) {
    if (!isGatewayCompletionWithoutChat(completion)) continue;
    gatewayDays.add(utcDay(completion.createdAt.getTime()));
    summary.steps += 1;
    if (completion.cost === null) summary.unknown += 1;
    summary.cost += completion.cost ?? 0;
  }

  const covering: Array<{ day: string; syncedAt: number }> = [];
  for (const row of localRows) {
    covering.push({ day: row.day, syncedAt: row.syncedAt.getTime() });
    if (gatewayDays.has(row.day)) continue;
    for (const model of row.models) {
      summary.steps += 1;
      const cost = model.cost ?? model.estimatedCost;
      if (cost === undefined && row.priceKey !== null) summary.pending += 1;
      else if (cost === undefined) summary.unknown += 1;
      summary.cost += cost ?? 0;
    }
  }

  for (const turn of turns) {
    const endedAt = turn.endedAt.getTime();
    if (isTurnCovered(covering, endedAt) || gatewayDays.has(utcDay(endedAt))) continue;
    summary.steps += 1;
    if (turn.pricing.status === "pending") summary.pending += 1;
    else if (turn.pricing.cost === undefined) summary.unknown += 1;
    summary.cost += turn.pricing.cost ?? 0;
  }
  return summary;
}
