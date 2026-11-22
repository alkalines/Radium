import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id, instant } from "../db/columns";

/**
 * Transactional outbox (`./outbox.ts`): work that must happen after a change commits, written in
 * the same transaction as the change. A finished job is deleted; one that exhausted its attempts
 * keeps `failed_at` and `last_error` for operators.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    /** Handler name in `./handlers.ts`. */
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    /** Earliest start; later on retry (backoff). */
    runAt: instant("run_at").notNull().defaultNow(),
    /** At most one queued job per key (debounce); the key frees once the job finishes. */
    dedupeKey: text("dedupe_key").unique(),
    attempts: integer("attempts").notNull().default(0),
    /** Claimed until then; a crashed runner's claim lapses and the sweep runs the job again. */
    lockedUntil: instant("locked_until"),
    lastError: text("last_error"),
    failedAt: instant("failed_at"),
    createdAt: createdAt(),
  },
  (table) => [
    // The sweep's claim: due jobs that have not failed, oldest first.
    index("jobs_due")
      .on(table.runAt)
      .where(sql`${table.failedAt} is null`),
  ],
);
