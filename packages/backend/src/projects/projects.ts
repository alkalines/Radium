import { v } from "convex/values";
import { internal } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { workspaceMutation, workspaceQuery } from "../../convex/helpers";
import { requireWorkspaceAccessForUser } from "../../convex/workspaces";
import { requireActiveWorkspaceWorker, validChatWorkerDirectory } from "../worker/chat-config";
import { workspaceWorkerMetadata } from "../worker/chat-selection";
import { MAX_PROJECT_FOLDERS, projectFolderValidator, type ProjectFolder } from "./validators";
import { isTileColorName } from "../workspaces/colors";
import { isWorkspaceIconName } from "../workspaces/icons";
import { normalizeDisplayName } from "../workspaces/names";
import { canManageProject } from "../workspaces/policy";

/**
 * Projects group chats inside a workspace. Any workspace member may read and create them; the
 * creator and the workspace owner manage them. A Project never changes chat visibility: chat
 * lists still apply the per-chat privacy rules, and deleting a Project only detaches its chats.
 */

const MAX_PROJECTS_PER_WORKSPACE = 200;
// Chats detached per transaction when a Project is removed; larger Projects continue in a
// scheduled mutation so a single delete stays within Convex read/write limits.
const DETACH_BATCH_SIZE = 256;

const projectSummaryValidator = v.object({
  _id: v.id("projects"),
  _creationTime: v.number(),
  name: v.string(),
  color: v.optional(v.string()),
  icon: v.optional(v.string()),
  folders: v.optional(v.array(projectFolderValidator)),
  defaultWorkerId: v.optional(v.string()),
  canManage: v.boolean(),
});

function validateProjectAppearance(appearance: { color?: string; icon?: string }) {
  if (appearance.color !== undefined && !isTileColorName(appearance.color)) {
    throw new Error("Unsupported Project color.");
  }
  if (appearance.icon !== undefined && !isWorkspaceIconName(appearance.icon)) {
    throw new Error("Unsupported Project icon.");
  }
}

// Folders name execution targets on Worker hosts, and Worker configuration is owner-only, so
// changing folders or the default Worker is reserved for the workspace owner even when members
// manage the Project.
function requireProjectFolderAuthority(
  workspace: Pick<Doc<"workspaces">, "ownerId">,
  userId: string,
) {
  if (workspace.ownerId !== userId) {
    throw new Error("Only the workspace owner can set a Project folder.");
  }
}

type ProjectWorkerFields = Pick<Doc<"projects">, "folders" | "defaultWorkerId">;

/**
 * Validate an owner's change to a Project's Worker folders and default Worker and return the
 * fields to store. `folders` replaces the list (at most one folder per Worker, absolute paths);
 * `defaultWorkerId: null` clears the default, and a default must name one of the folders. A kept
 * default whose folder was removed is cleared. Folders identical to the current ones skip the
 * Worker check so one revoked Worker does not block editing the others; new or changed folders
 * need an active Worker in the workspace.
 */
async function resolveProjectWorkers(
  ctx: MutationCtx,
  args: {
    folders: ProjectFolder[] | undefined;
    defaultWorkerId: string | null | undefined;
    current: ProjectWorkerFields;
    workspace: Pick<Doc<"workspaces">, "_id" | "ownerId">;
    userId: string;
  },
): Promise<ProjectWorkerFields> {
  requireProjectFolderAuthority(args.workspace, args.userId);

  const currentFolders = args.current.folders ?? [];
  const folders = args.folders ?? currentFolders;

  if (args.folders !== undefined) {
    if (folders.length > MAX_PROJECT_FOLDERS) throw new Error("Project folder limit reached.");

    const workerIds = new Set(folders.map((folder) => folder.workerId));
    if (workerIds.size !== folders.length) {
      throw new Error("Each Worker can have only one Project folder.");
    }

    const getWorkerMetadata = workspaceWorkerMetadata(ctx, args.workspace._id);
    for (const folder of folders) {
      if (!validChatWorkerDirectory(folder.directory)) {
        throw new Error("Worker directory must be an absolute path on the Worker.");
      }
      const unchanged = currentFolders.some(
        (entry) => entry.workerId === folder.workerId && entry.directory === folder.directory,
      );
      if (!unchanged) {
        await requireActiveWorkspaceWorker(folder.workerId, args.workspace._id, getWorkerMetadata);
      }
    }
  }

  const hasFolder = (workerId: string) => folders.some((folder) => folder.workerId === workerId);
  let defaultWorkerId: string | undefined;
  if (typeof args.defaultWorkerId === "string") {
    if (!hasFolder(args.defaultWorkerId)) {
      throw new Error("The default Worker must have a Project folder.");
    }
    defaultWorkerId = args.defaultWorkerId;
  } else if (args.defaultWorkerId === undefined && args.current.defaultWorkerId !== undefined) {
    defaultWorkerId = hasFolder(args.current.defaultWorkerId)
      ? args.current.defaultWorkerId
      : undefined;
  }

  return {
    folders:
      folders.length > 0
        ? folders.map(({ workerId, directory }) => ({ workerId, directory }))
        : undefined,
    defaultWorkerId,
  };
}

/**
 * Load a Project that must belong to an already-authorized workspace, e.g. before filing a chat
 * under it. Missing and foreign-workspace Projects fail identically.
 */
export async function requireWorkspaceProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"projects">> {
  const project = await ctx.db.get("projects", projectId);
  if (!project || project.workspace !== workspaceId) throw new Error("Project not found.");
  return project;
}

/**
 * Load a Project for a Better Auth caller who still has access to its workspace and may manage
 * it. Workspace access is checked first so archived workspaces and removed members lose
 * management even as creators.
 */
async function requireManageableProject(ctx: MutationCtx, projectId: Id<"projects">) {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");

  const project = await ctx.db.get("projects", projectId);
  if (!project) throw new Error("Project not found.");

  const workspace = await requireWorkspaceAccessForUser(ctx, project.workspace, identity._id);
  if (!canManageProject(project, workspace, identity._id)) {
    throw new Error("Only the Project creator or workspace owner can change this Project.");
  }

  return { project, workspace, userId: identity._id };
}

/**
 * Detach one bounded batch of chats from a (possibly already deleted) Project and schedule the
 * next batch when the batch was full. Chats are never deleted here.
 */
async function detachProjectChats(ctx: MutationCtx, projectId: Id<"projects">): Promise<void> {
  const chats = await ctx.db
    .query("aisdk_chats")
    .withIndex("by_project_and_lastInteractionAt", (q) => q.eq("project", projectId))
    .take(DETACH_BATCH_SIZE);

  for (const chat of chats) {
    await ctx.db.patch("aisdk_chats", chat._id, { project: undefined });
  }

  if (chats.length === DETACH_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.projects.detachChats, { project: projectId });
  }
}

/**
 * List a workspace's Projects sorted by name for any owner or member. `folders` and
 * `defaultWorkerId` are returned only to the workspace owner because they expose Worker host
 * paths; `canManage` reflects creator-or-owner management.
 */
export const list = workspaceQuery({
  args: {},
  returns: v.array(projectSummaryValidator),
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) => q.eq("workspace", ctx.workspace._id))
      .take(MAX_PROJECTS_PER_WORKSPACE);
    const isOwner = ctx.workspace.ownerId === ctx.identity._id;

    projects.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a._creationTime - b._creationTime,
    );

    return projects.map((project) => ({
      _id: project._id,
      _creationTime: project._creationTime,
      name: project.name,
      color: project.color,
      icon: project.icon,
      ...(isOwner && project.folders ? { folders: project.folders } : {}),
      ...(isOwner && project.defaultWorkerId ? { defaultWorkerId: project.defaultWorkerId } : {}),
      canManage: canManageProject(project, ctx.workspace, ctx.identity._id),
    }));
  },
});

/**
 * Create a Project owned by the caller. Any workspace member may create one; `folders` and
 * `defaultWorkerId` require the workspace owner and active Workers in this workspace. Names are
 * normalized to one line of at most 80 characters; workspaces hold at most 200 Projects.
 */
export const create = workspaceMutation({
  args: {
    name: v.string(),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    folders: v.optional(v.array(projectFolderValidator)),
    defaultWorkerId: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, args): Promise<Id<"projects">> => {
    const name = normalizeDisplayName(args.name, "Project");
    validateProjectAppearance(args);

    const existing = await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) => q.eq("workspace", ctx.workspace._id))
      .take(MAX_PROJECTS_PER_WORKSPACE);
    if (existing.length >= MAX_PROJECTS_PER_WORKSPACE) throw new Error("Project limit reached.");

    let workers: ProjectWorkerFields = {};
    if (args.folders !== undefined || args.defaultWorkerId !== undefined) {
      workers = await resolveProjectWorkers(ctx, {
        folders: args.folders,
        defaultWorkerId: args.defaultWorkerId,
        current: {},
        workspace: ctx.workspace,
        userId: ctx.identity._id,
      });
    }

    return await ctx.db.insert("projects", {
      workspace: ctx.workspace._id,
      userId: ctx.identity._id,
      name,
      color: args.color,
      icon: args.icon,
      ...workers,
    });
  },
});

/**
 * Update a Project's name, appearance, Worker folders, or default Worker. Creator or workspace
 * owner; omitted fields are kept. `folders` replaces the list (`[]` clears it) and
 * `defaultWorkerId: null` clears the default; either change is workspace-owner only.
 */
export const update = mutation({
  args: {
    project: v.id("projects"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    folders: v.optional(v.array(projectFolderValidator)),
    defaultWorkerId: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { project, workspace, userId } = await requireManageableProject(ctx, args.project);
    validateProjectAppearance(args);

    const patch: Partial<Pick<Doc<"projects">, "name" | "color" | "icon">> & ProjectWorkerFields =
      {};
    if (args.name !== undefined) patch.name = normalizeDisplayName(args.name, "Project");
    if (args.color !== undefined) patch.color = args.color;
    if (args.icon !== undefined) patch.icon = args.icon;

    if (args.folders !== undefined || args.defaultWorkerId !== undefined) {
      const workers = await resolveProjectWorkers(ctx, {
        folders: args.folders,
        defaultWorkerId: args.defaultWorkerId,
        current: project,
        workspace,
        userId,
      });
      // Assign both keys explicitly so a cleared value removes the stored field.
      patch.folders = workers.folders;
      patch.defaultWorkerId = workers.defaultWorkerId;
    }

    await ctx.db.patch("projects", project._id, patch);
    return null;
  },
});

/**
 * Delete a Project. Creator or workspace owner. Its chats are detached (project unset) in
 * bounded batches, continuing in scheduled mutations; chats are never deleted.
 */
export const remove = mutation({
  args: { project: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { project } = await requireManageableProject(ctx, args.project);

    await ctx.db.delete("projects", project._id);
    await detachProjectChats(ctx, project._id);
    return null;
  },
});

/** Scheduled continuation of {@link remove}; idempotent and safe to re-run after the delete. */
export const detachChats = internalMutation({
  args: { project: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await detachProjectChats(ctx, args.project);
    return null;
  },
});
