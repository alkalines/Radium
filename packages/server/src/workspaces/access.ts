import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { workspaceMembers, workspaces } from "./schema";

/** The caller's access to one workspace: its owner, or a direct member. */
export type WorkspaceAccess = {
  workspace: typeof workspaces.$inferSelect;
  role: "owner" | "member";
};

/**
 * Resolves `userId`'s access to `workspaceId` in one query. An archived or unknown workspace and
 * a workspace the user neither owns nor is a direct member of all give `null`, so callers answer
 * them the same way and never reveal which workspaces exist. Better Auth organizations are not
 * consulted.
 */
export async function workspaceAccess(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAccess | null> {
  const [row] = await db
    .select({ workspace: workspaces, memberId: workspaceMembers.id })
    .from(workspaces)
    .leftJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspace, workspaces.id), eq(workspaceMembers.userId, userId)),
    )
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.archivedAt)));

  if (!row) {
    return null;
  }
  if (row.workspace.ownerId === userId) {
    return { workspace: row.workspace, role: "owner" };
  }
  if (row.memberId !== null) {
    return { workspace: row.workspace, role: "member" };
  }
  return null;
}
