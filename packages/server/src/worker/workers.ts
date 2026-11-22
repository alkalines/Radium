import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { workerGateway, workers } from "./schema";

/**
 * Which of `workerIds` are active (not revoked) Workers of `workspace`. Unknown ids and other
 * workspaces' Workers are simply absent, so callers fail closed on anything not returned.
 */
export async function activeWorkspaceWorkers(
  db: Database,
  workspace: string,
  workerIds: readonly string[],
): Promise<Set<string>> {
  if (workerIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: workers.id })
    .from(workers)
    .where(
      and(
        eq(workers.workspace, workspace),
        eq(workers.status, "active"),
        inArray(workers.id, [...workerIds]),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** Names of the given Workers of `workspace`, by id (revoked Workers included). */
export async function workerNames(
  db: Database,
  workspace: string,
  workerIds: readonly string[],
): Promise<Map<string, string>> {
  if (workerIds.length === 0) return new Map();
  const rows = await db
    .select({ id: workers.id, name: workers.name })
    .from(workers)
    .where(and(eq(workers.workspace, workspace), inArray(workers.id, [...workerIds])));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * A Worker's Gateway key was deleted by the owner: its access becomes `missing` (the owner can
 * issue a new key in Settings → Workers). Runs in the deleting transaction.
 */
export async function releaseWorkerGatewayKey(db: Database, apiKey: string) {
  await db
    .update(workerGateway)
    .set({ access: "missing", apiKey: null, updatedAt: new Date() })
    .where(eq(workerGateway.apiKey, apiKey));
}
