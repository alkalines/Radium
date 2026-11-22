import { eq } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { workspaceSettings } from "./schema";

/** A workspace's settings row; `null` until the first owner change (every column at its default). */
export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;

/** Settings columns another domain may change through {@link updateWorkspaceSettings}. */
export type WorkspaceSettingsChange = Partial<
  Omit<WorkspaceSettingsRow, "id" | "workspace" | "createdAt">
>;

/** The workspace's settings row, or `null` when none exists yet (read it as the defaults). */
export async function readWorkspaceSettings(
  db: Database,
  workspace: string,
): Promise<WorkspaceSettingsRow | null> {
  const [row] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspace, workspace));
  return row ?? null;
}

/**
 * Writes `change` into the workspace's settings, creating the row on first use. One upsert
 * statement on the unique `workspace`, so concurrent first writes cannot create two rows and
 * each change applies to the columns it names only. Authorization is the caller's.
 */
export async function updateWorkspaceSettings(
  db: Database,
  workspace: string,
  change: WorkspaceSettingsChange,
) {
  await db
    .insert(workspaceSettings)
    .values({ workspace, ...change })
    .onConflictDoUpdate({ target: workspaceSettings.workspace, set: change });
}
