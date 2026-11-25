import { sql } from "drizzle-orm";
import {
  ACP_COMMAND_EXPIRY_MS,
  ACP_COMMAND_RETENTION_MS,
  ACP_INTERACTION_RETENTION_MS,
} from "contracts/acp/contract";
import type { Database } from "../drivers/types";
import { applySessionPatch } from "./lifecycle";
import { findSession } from "./policy";
import { acpCommands, acpInteractions } from "./schema";

/*
 * ACP retention (Convex `acp.prune`). Chat-scoped rows go with their chat through foreign keys;
 * terminal receipts, commands that outlive their chat (`close`/`delete`, agent-level kinds) and
 * abandoned intent need a policy here.
 */

/** Retention: finished command receipts older than five minutes. */
export async function pruneAcpCommands(db: Database, now: number, batch: number) {
  const cutoff = new Date(now - ACP_COMMAND_RETENTION_MS);
  const deleted = await db
    .delete(acpCommands)
    .where(
      sql`${acpCommands.id} in (select ${acpCommands.id} from ${acpCommands} where ${acpCommands.finishedAt} < ${cutoff} limit ${batch})`,
    )
    .returning({ id: acpCommands.id });
  return deleted.length;
}

/** Retention: resolved or cancelled interactions older than ten minutes. */
export async function pruneAcpInteractions(db: Database, now: number, batch: number) {
  const cutoff = new Date(now - ACP_INTERACTION_RETENTION_MS);
  const deleted = await db
    .delete(acpInteractions)
    .where(
      sql`${acpInteractions.id} in (select ${acpInteractions.id} from ${acpInteractions} where ${acpInteractions.resolvedAt} < ${cutoff} limit ${batch})`,
    )
    .returning({ id: acpInteractions.id });
  return deleted.length;
}

/**
 * Retention: abandoned intent, pending commands never claimed within seven days. A prompt or fork
 * whose session never started fails that session (generic error), as a claimed-then-lost one would.
 */
export async function expireAcpCommands(db: Database, now: number, batch: number) {
  const cutoff = new Date(now - ACP_COMMAND_EXPIRY_MS);
  return await db.transaction(async (tx) => {
    const expired = await tx
      .delete(acpCommands)
      .where(
        sql`${acpCommands.id} in (select ${acpCommands.id} from ${acpCommands} where ${acpCommands.status} = 'pending' and ${acpCommands.createdAt} < ${cutoff} limit ${batch} for update skip locked)`,
      )
      .returning({ kind: acpCommands.kind, chat: acpCommands.chat, result: acpCommands.result });
    for (const row of expired) {
      if (row.kind !== "prompt" && row.kind !== "fork") continue;
      // A signed fork has no readable payload; its receipt names the target chat.
      const target = row.kind === "fork" ? row.result : row.chat;
      const session = target ? await findSession(tx, target, true) : undefined;
      if (session?.status === "starting") {
        // Jobs it queues (the failure notification) are left to the outbox sweep.
        await applySessionPatch(tx, session, { status: "failed", sealedError: null });
      }
    }
    return expired.length;
  });
}
