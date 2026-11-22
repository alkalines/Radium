import { and, count, eq } from "drizzle-orm";
import type { Id } from "contracts/wire";
import { findUserByEmail, findUsers } from "../auth/users";
import { detachWorkspaceMember } from "../chatroom/chats";
import type { Database } from "../drivers/types";
import {
  clearWorkspaceJoins,
  insertWorkspaceEpoch,
  invalidKeys,
  type WorkspaceKeysInput,
} from "../e2ee/workspace-keys";
import { AppError } from "../errors";
import { workspaceMembers } from "./schema";
import { lockWorkspace, MAX_MEMBERS, type Workspace } from "./workspaces";

/**
 * Explicit workspace members. Membership is direct access for an existing account, managed by
 * the owner; there is no invitation acceptance. Key distribution to a new member is separate
 * (access links, key requests in `../e2ee`); removal rotates the workspace keys atomically.
 */

export type WorkspaceMember = {
  userId: string;
  email: string;
  name: string;
  role: "owner" | "member";
};

/** The owner and explicit members of an owned workspace, owner first. */
export async function listMembers(db: Database, workspace: Workspace): Promise<WorkspaceMember[]> {
  const memberships = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspace, workspace.id))
    .orderBy(workspaceMembers.createdAt, workspaceMembers.id)
    .limit(MAX_MEMBERS);
  const ids = memberships.map((row) => row.userId);
  const profiles = new Map(
    (await findUsers(db, [workspace.ownerId, ...ids])).map((profile) => [profile.id, profile]),
  );
  const members: WorkspaceMember[] = [];
  for (const [index, userId] of [workspace.ownerId, ...ids].entries()) {
    const profile = profiles.get(userId);
    if (profile) {
      members.push({
        userId,
        email: profile.email,
        name: profile.name,
        role: index === 0 ? "owner" : "member",
      });
    }
  }
  return members;
}

async function requireMemberAccount(db: Database, workspace: Workspace, email: string) {
  if (!email.trim()) {
    throw new AppError("BAD_REQUEST", "Member email is required.");
  }
  const account = await findUserByEmail(db, email);
  if (!account) {
    throw new AppError("NOT_FOUND", "User not found.");
  }
  if (account.id === workspace.ownerId) {
    throw new AppError("BAD_REQUEST", "The workspace owner is implicit.");
  }
  return account;
}

/**
 * Adds the existing account with `email` to an owned workspace; adding a current member again
 * returns the same membership. A workspace holds at most {@link MAX_MEMBERS} members, the most a
 * signed roster can list.
 */
export async function addMember(
  db: Database,
  workspace: Workspace,
  email: string,
): Promise<Id<"workspace_members">> {
  const account = await requireMemberAccount(db, workspace, email);
  return await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspace.id);
    const membership = and(
      eq(workspaceMembers.workspace, workspace.id),
      eq(workspaceMembers.userId, account.id),
    );
    const [existing] = await tx
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(membership);
    if (existing) {
      return existing.id as Id<"workspace_members">;
    }
    const [members] = await tx
      .select({ count: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspace, workspace.id));
    if (members!.count >= MAX_MEMBERS) {
      throw new AppError("BAD_REQUEST", "Member limit reached.");
    }
    const [row] = await tx
      .insert(workspaceMembers)
      .values({ workspace: workspace.id, userId: account.id, role: "member" })
      .returning({ id: workspaceMembers.id });
    return row!.id as Id<"workspace_members">;
  });
}

/**
 * Removes the account with `email` from an owned workspace, in one transaction:
 *
 * - its membership row, its `chat_members` rows (those chats and the `shared` chats it created
 *   are flagged for a new chat key epoch);
 * - every pending access link and join request, which were made for the old keys;
 * - for a keyed workspace, the next key epoch (`rotation`), whose grants and roster no longer
 *   include the removed member. A keyed workspace requires it and a keyless one refuses it.
 *
 * Removing an account that is not a member still clears its chat access and rotates, so a
 * retried removal converges.
 */
export async function removeMember(
  db: Database,
  workspace: Workspace,
  email: string,
  rotation: WorkspaceKeysInput | undefined,
): Promise<void> {
  const account = await requireMemberAccount(db, workspace, email);
  await db.transaction(async (tx) => {
    // The locked row carries the current key epoch; a rotation racing this one waits here.
    const current = await lockWorkspace(tx, workspace.id);
    if (Boolean(current.keyEpoch) !== Boolean(rotation)) {
      invalidKeys();
    }
    await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspace, current.id),
          eq(workspaceMembers.userId, account.id),
        ),
      );
    await detachWorkspaceMember(tx, current.id, account.id);
    await clearWorkspaceJoins(tx, current.id);
    if (rotation) {
      await insertWorkspaceEpoch(tx, current, rotation);
    }
  });
}
