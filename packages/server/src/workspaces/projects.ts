import { and, asc, count, eq, sql } from "drizzle-orm";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { Id } from "contracts/wire";
import { isTileColorName } from "contracts/workspaces/colors";
import { validChatWorkerDirectory } from "contracts/worker/chat-config";
import { z } from "zod";
import type { StoredJson } from "../db/columns";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { activeWorkspaceWorkers } from "../worker/workers";
import { workspaceAccess, type WorkspaceAccess } from "./access";
import { projectFolders, projects } from "./schema";

/**
 * Projects group chats inside a workspace. Any workspace member may read and create them; the
 * creator and the workspace owner manage them. A Project never changes chat visibility, and
 * deleting one only detaches its chats (`chats.project` is `on delete set null`). Names and icons
 * are sealed by clients (`./names.ts`); the stored `name` is the placeholder.
 */

/** Projects per workspace. */
export const MAX_PROJECTS = 200;
/** Worker folders per Project; one per Worker. */
export const MAX_PROJECT_FOLDERS = 20;
const PLACEHOLDER_NAME = "Project";

export const projectFolderInput = z.object({
  workerId: z.string().min(1).max(256),
  directory: z.string().max(4096),
});
export type ProjectFolder = z.output<typeof projectFolderInput>;

export type ProjectSummary = {
  id: Id<"projects">;
  name: string;
  color: string | null;
  icon: string | null;
  legacyContent: StoredJson<LegacyBox> | null;
  /** Worker folders in the owner's order; only for the workspace owner (they are host paths). */
  folders?: ProjectFolder[];
  defaultWorkerId?: string;
  canManage: boolean;
};

type Project = typeof projects.$inferSelect;
type WorkerFields = { folders: ProjectFolder[]; defaultWorkerId: string | null };

function requireColor(color: string | undefined) {
  if (color !== undefined && !isTileColorName(color)) {
    throw new AppError("BAD_REQUEST", "Unsupported Project color.");
  }
}

function canManage(project: Pick<Project, "userId">, access: WorkspaceAccess, userId: string) {
  return project.userId === userId || access.role === "owner";
}

/** The Project and its workspace access, for one the caller can see; else `NOT_FOUND`. */
async function projectAccess(db: Database, userId: string, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  const access = project ? await workspaceAccess(db, userId, project.workspace) : null;
  if (!project || !access) {
    throw new AppError("NOT_FOUND", "Project not found.");
  }
  return { project, access };
}

/**
 * A Project the caller may manage (creator or workspace owner). Workspace access is checked
 * first, so archived workspaces and removed members lose management even as creators.
 */
export async function requireManageableProject(db: Database, userId: string, projectId: string) {
  const found = await projectAccess(db, userId, projectId);
  if (!canManage(found.project, found.access, userId)) {
    throw new AppError(
      "FORBIDDEN",
      "Only the Project creator or workspace owner can change this Project.",
    );
  }
  return found;
}

/** The Project, which must belong to the already authorized `workspace` (filing a chat). */
export async function requireWorkspaceProject(
  db: Database,
  projectId: string,
  workspace: string,
): Promise<Project> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspace, workspace)));
  if (!project) {
    throw new AppError("NOT_FOUND", "Project not found.");
  }
  return project;
}

/**
 * The owner-set folder of `workerId` in Project `projectId` of `workspace` (a chat's Worker
 * directory), or undefined. A Project of another workspace never contributes a folder.
 */
export async function projectWorkerDirectory(
  db: Database,
  workspace: string,
  projectId: string,
  workerId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ directory: projectFolders.directory })
    .from(projectFolders)
    .innerJoin(projects, eq(projects.id, projectFolders.project))
    .where(
      and(
        eq(projectFolders.project, projectId),
        eq(projectFolders.worker, workerId),
        eq(projects.workspace, workspace),
      ),
    );
  return row?.directory;
}

/**
 * Every Worker folder of the workspace's Projects, oldest Project first, then in each Project's
 * own order (ACP: which Project an agent session's folder belongs to). Bounded by the Project and
 * folder limits.
 */
export async function workspaceProjectFolders(
  db: Database,
  workspace: string,
): Promise<{ project: string; worker: string; directory: string }[]> {
  return await db
    .select({
      project: projectFolders.project,
      worker: projectFolders.worker,
      directory: projectFolders.directory,
    })
    .from(projectFolders)
    .innerJoin(projects, eq(projects.id, projectFolders.project))
    .where(eq(projects.workspace, workspace))
    .orderBy(asc(projects.createdAt), asc(projects.id), asc(projectFolders.position))
    .limit(MAX_PROJECTS * MAX_PROJECT_FOLDERS);
}

/** A workspace's Projects for any owner or member, by name then age. */
export async function listProjects(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
): Promise<ProjectSummary[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspace, access.workspace.id))
    .orderBy(sql`lower(${projects.name})`, asc(projects.createdAt), asc(projects.id))
    .limit(MAX_PROJECTS);
  const isOwner = access.role === "owner";
  const folders = isOwner
    ? await db
        .select()
        .from(projectFolders)
        .innerJoin(projects, eq(projects.id, projectFolders.project))
        .where(eq(projects.workspace, access.workspace.id))
        .orderBy(asc(projectFolders.position))
    : [];
  return rows.map((project) => {
    const own = folders
      .filter((row) => row.project_folders.project === project.id)
      .map((row) => row.project_folders);
    const defaultFolder = own.find((folder) => folder.isDefault);
    return {
      id: project.id as Id<"projects">,
      name: project.name,
      color: project.color,
      icon: project.icon,
      legacyContent: project.legacyContent,
      ...(isOwner && own.length > 0
        ? {
            folders: own.map((folder) => ({
              workerId: folder.worker,
              directory: folder.directory,
            })),
          }
        : {}),
      ...(isOwner && defaultFolder ? { defaultWorkerId: defaultFolder.worker } : {}),
      canManage: canManage(project, access, userId),
    };
  });
}

/**
 * Validates an owner's change to a Project's Worker folders and default Worker and returns the
 * result. `folders` replaces the list (one folder per Worker, absolute paths); `defaultWorkerId:
 * null` clears the default, and a default must name one of the folders. A kept default whose
 * folder was removed is cleared. Folders identical to current ones skip the Worker check so one
 * revoked Worker does not block editing the others; new or changed ones need an active Worker of
 * this workspace.
 */
async function resolveWorkers(
  db: Database,
  access: WorkspaceAccess,
  change: { folders?: ProjectFolder[]; defaultWorkerId?: string | null },
  current: WorkerFields,
): Promise<WorkerFields> {
  if (access.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only the workspace owner can set a Project folder.");
  }
  const folders = change.folders ?? current.folders;
  if (change.folders !== undefined) {
    if (folders.length > MAX_PROJECT_FOLDERS) {
      throw new AppError("BAD_REQUEST", "Project folder limit reached.");
    }
    if (new Set(folders.map((folder) => folder.workerId)).size !== folders.length) {
      throw new AppError("BAD_REQUEST", "Each Worker can have only one Project folder.");
    }
    if (folders.some((folder) => !validChatWorkerDirectory(folder.directory))) {
      throw new AppError("BAD_REQUEST", "Worker directory must be an absolute path on the Worker.");
    }
    const changed = folders.filter(
      (folder) =>
        !current.folders.some(
          (entry) => entry.workerId === folder.workerId && entry.directory === folder.directory,
        ),
    );
    const active = await activeWorkspaceWorkers(
      db,
      access.workspace.id,
      changed.map((folder) => folder.workerId),
    );
    if (changed.some((folder) => !active.has(folder.workerId))) {
      throw new AppError("BAD_REQUEST", "Worker must be active in this workspace.");
    }
  }

  const hasFolder = (workerId: string) => folders.some((folder) => folder.workerId === workerId);
  let defaultWorkerId: string | null = null;
  if (typeof change.defaultWorkerId === "string") {
    if (!hasFolder(change.defaultWorkerId)) {
      throw new AppError("BAD_REQUEST", "The default Worker must have a Project folder.");
    }
    defaultWorkerId = change.defaultWorkerId;
  } else if (change.defaultWorkerId === undefined && current.defaultWorkerId !== null) {
    defaultWorkerId = hasFolder(current.defaultWorkerId) ? current.defaultWorkerId : null;
  }
  return {
    folders: folders.map(({ workerId, directory }) => ({ workerId, directory })),
    defaultWorkerId,
  };
}

async function currentWorkers(tx: Database, projectId: string): Promise<WorkerFields> {
  const rows = await tx
    .select()
    .from(projectFolders)
    .where(eq(projectFolders.project, projectId))
    .orderBy(asc(projectFolders.position));
  return {
    folders: rows.map((row) => ({ workerId: row.worker, directory: row.directory })),
    defaultWorkerId: rows.find((row) => row.isDefault)?.worker ?? null,
  };
}

async function writeWorkers(tx: Database, projectId: string, fields: WorkerFields) {
  await tx.delete(projectFolders).where(eq(projectFolders.project, projectId));
  if (fields.folders.length > 0) {
    await tx.insert(projectFolders).values(
      fields.folders.map((folder, position) => ({
        project: projectId,
        worker: folder.workerId,
        directory: folder.directory,
        position,
        isDefault: folder.workerId === fields.defaultWorkerId,
      })),
    );
  }
}

/**
 * Creates a Project owned by the caller with the placeholder name; the client seals the real one
 * next. Any member may create one; folders and a default Worker are owner-only.
 */
export async function createProject(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  input: { color?: string; folders?: ProjectFolder[]; defaultWorkerId?: string },
): Promise<Id<"projects">> {
  requireColor(input.color);
  return await db.transaction(async (tx) => {
    // Serializes creation per workspace so the Project limit holds.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`projects:${access.workspace.id}`}, 0))`,
    );
    const [existing] = await tx
      .select({ count: count() })
      .from(projects)
      .where(eq(projects.workspace, access.workspace.id));
    if (existing!.count >= MAX_PROJECTS) {
      throw new AppError("BAD_REQUEST", "Project limit reached.");
    }
    const workers =
      input.folders !== undefined || input.defaultWorkerId !== undefined
        ? await resolveWorkers(tx, access, input, { folders: [], defaultWorkerId: null })
        : null;
    const [row] = await tx
      .insert(projects)
      .values({
        workspace: access.workspace.id,
        userId,
        name: PLACEHOLDER_NAME,
        color: input.color ?? null,
      })
      .returning({ id: projects.id });
    if (workers) {
      await writeWorkers(tx, row!.id, workers);
    }
    return row!.id as Id<"projects">;
  });
}

/**
 * Updates a Project's color, Worker folders or default Worker (creator or workspace owner;
 * folders and the default are owner-only). Omitted fields are kept; `folders: []` clears the
 * list and `defaultWorkerId: null` clears the default.
 */
export async function updateProject(
  db: Database,
  userId: string,
  projectId: string,
  input: { color?: string; folders?: ProjectFolder[]; defaultWorkerId?: string | null },
): Promise<void> {
  requireColor(input.color);
  const { project, access } = await requireManageableProject(db, userId, projectId);
  await db.transaction(async (tx) => {
    // Serializes folder edits of this Project; the row may be gone by now.
    const [locked] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id))
      .for("update");
    if (!locked) {
      throw new AppError("NOT_FOUND", "Project not found.");
    }
    if (input.color !== undefined) {
      await tx.update(projects).set({ color: input.color }).where(eq(projects.id, project.id));
    }
    if (input.folders !== undefined || input.defaultWorkerId !== undefined) {
      const workers = await resolveWorkers(tx, access, input, await currentWorkers(tx, project.id));
      await writeWorkers(tx, project.id, workers);
    }
  });
}

/** Deletes a Project (creator or workspace owner); its chats are detached, never deleted. */
export async function removeProject(db: Database, userId: string, projectId: string) {
  const { project } = await requireManageableProject(db, userId, projectId);
  await db.delete(projects).where(eq(projects.id, project.id));
}

/** The current sealed name of a Project the caller can see, for read-modify-write. */
export async function projectSealedName(db: Database, userId: string, projectId: string) {
  const { project } = await projectAccess(db, userId, projectId);
  return {
    workspace: project.workspace as Id<"workspaces">,
    name: project.name,
    icon: project.icon,
    legacyContent: project.legacyContent,
  };
}
