import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { Id } from "contracts/wire";
import { isTileColorName } from "contracts/workspaces/colors";
import { workspaceHasChats } from "../chatroom/chats";
import type { StoredJson } from "../db/columns";
import type { Database, Kv } from "../drivers/types";
import { AppError } from "../errors";
import { invalidateWorkspaceKeys } from "../gateway/keys";
import { workspaceMembers, workspaces } from "./schema";

/**
 * Workspaces: personal-user ownership, explicit members, archive and restore. Callers pass a
 * workspace already authorized by `../trpc/init.ts` (`workspaceProcedure`,
 * `ownedWorkspaceProcedure`) where one is named; functions taking only a user id authorize by
 * ownership themselves.
 */

export type Workspace = typeof workspaces.$inferSelect;

/** One accessible workspace as clients list it. Names and icons may be sealed in `legacyContent`. */
export type WorkspaceSummary = {
  id: Id<"workspaces">;
  name: string;
  icon: string | null;
  color: string | null;
  legacyContent: StoredJson<LegacyBox> | null;
  role: "owner" | "member";
};

/** Active plus archived workspaces one user may own, and memberships listed per user. */
export const MAX_WORKSPACES = 100;
/** Explicit members per workspace; the signed roster lists at most this many. */
export const MAX_MEMBERS = 200;

const DEFAULT_NAME = "Workspace";

function summary(workspace: Workspace, role: WorkspaceSummary["role"]): WorkspaceSummary {
  return {
    id: workspace.id as Id<"workspaces">,
    name: workspace.name,
    icon: workspace.icon,
    color: workspace.color,
    legacyContent: workspace.legacyContent,
    role,
  };
}

/**
 * Serializes one user's workspace creation and archiving until the transaction ends, so the
 * "one personal workspace", "at most 100" and "keep one active" checks hold under concurrency.
 */
async function lockOwner(tx: Database, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspaces:${userId}`}, 0))`);
}

/**
 * The workspace row locked for the rest of the transaction (`for no key update`: concurrent
 * inserts that reference it still proceed). Serializes key epochs, membership and sealed-name
 * changes of one workspace. An archived or missing workspace is `NOT_FOUND`.
 */
export async function lockWorkspace(tx: Database, workspaceId: string): Promise<Workspace> {
  const [row] = await tx
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.archivedAt)))
    .for("no key update");
  if (!row) {
    throw new AppError("NOT_FOUND", "Workspace not found.");
  }
  return row;
}

/** Owned and explicitly shared active workspaces of `userId`, oldest first. */
export async function listWorkspaces(db: Database, userId: string): Promise<WorkspaceSummary[]> {
  const [owned, shared] = await Promise.all([
    db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.ownerId, userId), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(MAX_WORKSPACES),
    db
      .select({ workspace: workspaces })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspace))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(MAX_WORKSPACES),
  ]);
  return [
    ...owned.map((workspace) => ({ workspace, role: "owner" as const })),
    ...shared.map(({ workspace }) => ({ workspace, role: "member" as const })),
  ]
    .sort(
      (a, b) =>
        a.workspace.createdAt.getTime() - b.workspace.createdAt.getTime() ||
        (a.workspace.id < b.workspace.id ? -1 : 1),
    )
    .slice(0, MAX_WORKSPACES)
    .map(({ workspace, role }) => summary(workspace, role));
}

/** Archived workspaces `userId` owns; members never see archived workspaces. */
export async function listArchivedWorkspaces(
  db: Database,
  userId: string,
): Promise<WorkspaceSummary[]> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.ownerId, userId), isNotNull(workspaces.archivedAt)))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(MAX_WORKSPACES);
  return rows.map((workspace) => summary(workspace, "owner"));
}

/**
 * The user's first active owned workspace, creating one when they have none (first sign-in).
 * Concurrent calls from several tabs create exactly one.
 */
export async function ensurePersonalWorkspace(
  db: Database,
  userId: string,
): Promise<Id<"workspaces">> {
  return await db.transaction(async (tx) => {
    await lockOwner(tx, userId);
    const [existing] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.ownerId, userId), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(1);
    if (existing) {
      return existing.id as Id<"workspaces">;
    }
    return await insertWorkspace(tx, userId);
  });
}

/**
 * Adds another personal workspace. It starts with the placeholder name; clients seal the real
 * name with the workspace's key once it has one (`./names.ts`), so the server never stores it.
 */
export async function createWorkspace(db: Database, userId: string): Promise<Id<"workspaces">> {
  return await db.transaction(async (tx) => {
    await lockOwner(tx, userId);
    const [owned] = await tx
      .select({ count: count() })
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId));
    if (owned!.count >= MAX_WORKSPACES) {
      throw new AppError("BAD_REQUEST", "Workspace limit reached.");
    }
    return await insertWorkspace(tx, userId);
  });
}

async function insertWorkspace(tx: Database, userId: string): Promise<Id<"workspaces">> {
  const [row] = await tx
    .insert(workspaces)
    .values({ ownerId: userId, name: DEFAULT_NAME })
    .returning({ id: workspaces.id });
  return row!.id as Id<"workspaces">;
}

/** Sets the tile color of an owned workspace; only supported color names. */
export async function setWorkspaceColor(db: Database, workspace: Workspace, color: string) {
  if (!isTileColorName(color)) {
    throw new AppError("BAD_REQUEST", "Unsupported workspace color.");
  }
  await db.update(workspaces).set({ color }).where(eq(workspaces.id, workspace.id));
}

/**
 * Archives an owned workspace that holds no chats, keeping its records. The owner keeps at least
 * one active workspace. Archived workspaces refuse every request until restored; their Gateway
 * keys stop resolving at once (the key cache is invalidated after commit).
 */
export async function archiveWorkspace(db: Database, kv: Kv, workspace: Workspace) {
  await db.transaction(async (tx) => {
    await lockOwner(tx, workspace.ownerId);
    const [active] = await tx
      .select({ count: count() })
      .from(workspaces)
      .where(and(eq(workspaces.ownerId, workspace.ownerId), isNull(workspaces.archivedAt)));
    const [current] = await tx
      .select({ archivedAt: workspaces.archivedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id));
    if (current?.archivedAt) {
      return;
    }
    if (active!.count <= 1) {
      throw new AppError("BAD_REQUEST", "Keep at least one active workspace.");
    }
    if (await workspaceHasChats(tx, workspace.id)) {
      throw new AppError("BAD_REQUEST", "Delete or move this workspace's chats first.");
    }
    await tx
      .update(workspaces)
      .set({ archivedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
  });
  await invalidateWorkspaceKeys(db, kv, workspace.id);
}

/** Restores an archived workspace `userId` owns; its members regain access. */
export async function restoreWorkspace(db: Database, userId: string, workspaceId: string) {
  const restored = await db
    .update(workspaces)
    .set({ archivedAt: null })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)))
    .returning({ id: workspaces.id });
  if (restored.length === 0) {
    throw new AppError("NOT_FOUND", "Workspace not found.");
  }
}

/**
 * The owner and explicit members of a workspace (the roster's audience). More than
 * {@link MAX_MEMBERS} members cannot be listed in a roster, so callers treat that as invalid.
 */
export async function workspaceUserIds(db: Database, workspace: Workspace): Promise<string[]> {
  const members = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspace, workspace.id))
    .limit(MAX_MEMBERS + 1);
  return [workspace.ownerId, ...members.map((row) => row.userId)];
}

/**
 * The owner of an active workspace, or `null` when it is archived or gone: the audience of
 * owner-only notifications, which archived workspaces do not send.
 */
export async function activeWorkspaceOwner(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.archivedAt)));
  return row?.ownerId ?? null;
}

/** Records the workspace's current key epoch; called by `../e2ee/workspace-keys.ts` only. */
export async function setWorkspaceKeyEpoch(tx: Database, workspaceId: string, epoch: number) {
  await tx.update(workspaces).set({ keyEpoch: epoch }).where(eq(workspaces.id, workspaceId));
}
