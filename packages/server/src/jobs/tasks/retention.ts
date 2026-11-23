import { defineTask } from "nitro/task";
import type { Database } from "../../drivers/types";
import { pruneLimitEvents } from "../../gateway/limits/events";
import { pruneChatRuns } from "../../chatroom/run";
import { useProcessRuntime } from "../../runtime";
import { claimLease } from "../lease";

/** Rows deleted per policy and run; a backlog drains over the following runs. */
const RETENTION_BATCH = 500;

type RetentionPolicy = {
  table: string;
  /** Deletes up to `batch` expired rows; returns how many. */
  prune(db: Database, now: number, batch: number): Promise<number>;
};

/**
 * One bounded delete per table that expires rows by age. A domain adds its policy here when it
 * is ported, keeping its own cutoff and delete next to its table.
 */
const policies: RetentionPolicy[] = [
  { table: "limit_events", prune: pruneLimitEvents },
  { table: "chat_runs", prune: pruneChatRuns },
];

/**
 * Runs every five minutes (`nitro.config.ts`): applies each retention policy once. The lease
 * lets one replica run each interval.
 */
export default defineTask<{ pruned: Record<string, number> } | { skipped: true }>({
  meta: { name: "retention", description: "Delete rows past their retention period" },
  async run() {
    const runtime = await useProcessRuntime();
    if (!(await claimLease(runtime.drivers.kv, "retention", 270_000))) {
      return { result: { skipped: true } };
    }
    const pruned: Record<string, number> = {};
    for (const policy of policies) {
      pruned[policy.table] = await policy.prune(runtime.drivers.db, Date.now(), RETENTION_BATCH);
    }
    return { result: { pruned } };
  },
});
