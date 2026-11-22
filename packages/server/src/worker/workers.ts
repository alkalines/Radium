import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { workers } from "./schema";

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
