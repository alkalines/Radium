import type { Kv } from "../drivers/types";
import { kvSet } from "../kv";

/**
 * Lets one replica run a scheduled task per interval. Each replica's scheduler fires the task;
 * the first to set the fixed key `lease:<task>` runs it, the rest skip. The lease is never
 * released: it expires on its own a little before the next interval, so a replica whose clock
 * fires slightly later still sees it. Keying the lease by time slot instead double-ran when
 * replicas fired on either side of a slot boundary (task 14, Phase 0).
 *
 * @param ttlMs shorter than the task's interval, longer than the clock skew between replicas.
 * @returns whether this replica holds the lease and should run the task.
 */
export async function claimLease(kv: Kv, task: string, ttlMs: number): Promise<boolean> {
  return await kvSet(kv, `lease:${task}`, crypto.randomUUID(), { ttlMs, onlyIfAbsent: true });
}
