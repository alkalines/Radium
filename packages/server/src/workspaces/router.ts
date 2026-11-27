import { z } from "zod";
import { workspaceKeysInput } from "../e2ee/workspace-keys";
import { findUserByEmail } from "../auth/users";
import type { Runtime } from "../runtime";
import { deferEvent, userEvents } from "../streams/events";
import {
  ownedWorkspaceProcedure,
  router,
  sessionProcedure,
  workspaceProcedure,
} from "../trpc/init";
import { addMember, listMembers, removeMember } from "./members";
import { expectedNameInput, sealedNameInput, setSealedName } from "./names";
import { getModelPreferences, MAX_MODEL_SLUG_LENGTH, setModelPreference } from "./preferences";
import {
  createProject,
  listProjects,
  projectFolderInput,
  projectSealedName,
  removeProject,
  requireManageableProject,
  updateProject,
} from "./projects";
import {
  archiveWorkspace,
  createWorkspace,
  ensurePersonalWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  restoreWorkspace,
  setWorkspaceColor,
} from "./workspaces";

const idInput = z.string().min(1).max(256);
const emailInput = z.string().max(320);
const nameChange = z.object({ content: sealedNameInput, expected: expectedNameInput });

export const workspacesRouter = router({
  /** Owned and shared active workspaces, oldest first. */
  list: sessionProcedure.query(({ ctx }) => listWorkspaces(ctx.runtime.drivers.db, ctx.user.id)),
  /** Archived workspaces the caller owns. */
  listArchived: sessionProcedure.query(({ ctx }) =>
    listArchivedWorkspaces(ctx.runtime.drivers.db, ctx.user.id),
  ),
  /** The first active owned workspace, created on first use. */
  ensurePersonal: sessionProcedure.mutation(({ ctx }) =>
    ensurePersonalWorkspace(ctx.runtime.drivers.db, ctx.user.id),
  ),
  /** A new personal workspace with the placeholder name; the client seals its name next. */
  create: sessionProcedure.mutation(({ ctx }) =>
    createWorkspace(ctx.runtime.drivers.db, ctx.user.id),
  ),
  setColor: ownedWorkspaceProcedure
    .input(z.object({ color: z.string().max(32) }))
    .mutation(({ ctx, input }) =>
      setWorkspaceColor(ctx.runtime.drivers.db, ctx.access.workspace, input.color),
    ),
  archive: ownedWorkspaceProcedure.mutation(({ ctx }) =>
    archiveWorkspace(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.access.workspace),
  ),
  /** Not a workspace procedure: archived workspaces refuse those. Ownership is checked inside. */
  restore: sessionProcedure
    .input(z.object({ workspace: idInput }))
    .mutation(({ ctx, input }) =>
      restoreWorkspace(ctx.runtime.drivers.db, ctx.user.id, input.workspace),
    ),
  /** The workspace's current sealed name, for read-modify-write by an unlocked client. */
  sealedName: workspaceProcedure.query(({ ctx }) => ({
    workspace: ctx.access.workspace.id,
    name: ctx.access.workspace.name,
    icon: ctx.access.workspace.icon,
    legacyContent: ctx.access.workspace.legacyContent,
  })),
  setName: ownedWorkspaceProcedure
    .input(nameChange)
    .mutation(({ ctx, input }) =>
      setSealedName(
        ctx.runtime.drivers.db,
        {
          table: "workspaces",
          id: ctx.access.workspace.id,
          workspace: ctx.access.workspace.id,
        },
        input.content,
        input.expected,
      ),
    ),
  listMembers: ownedWorkspaceProcedure.query(({ ctx }) =>
    listMembers(ctx.runtime.drivers.db, ctx.access.workspace),
  ),
  addMember: ownedWorkspaceProcedure
    .input(z.object({ email: emailInput }))
    .mutation(async ({ ctx, input }) => {
      const membership = await addMember(ctx.runtime.drivers.db, ctx.access.workspace, input.email);
      await tellAccount(ctx.runtime, input.email);
      return membership;
    }),
  /** Removes a member; a keyed workspace must send the next key epoch in `rotation`. */
  removeMember: ownedWorkspaceProcedure
    .input(z.object({ email: emailInput, rotation: workspaceKeysInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      await removeMember(ctx.runtime.drivers.db, ctx.access.workspace, input.email, input.rotation);
      await tellAccount(ctx.runtime, input.email);
    }),
});

/**
 * The account a membership change is about learns it on its own stream (its workspace list),
 * since the workspace stream no longer or not yet reaches it.
 */
async function tellAccount(runtime: Runtime, email: string) {
  const account = await findUserByEmail(runtime.drivers.db, email);
  if (account) deferEvent(runtime, [userEvents(account.id)], { topic: "workspaces" });
}

const projectWorkers = {
  color: z.string().max(32).optional(),
  folders: z.array(projectFolderInput).max(100).optional(),
};

export const projectsRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    listProjects(ctx.runtime.drivers.db, ctx.access, ctx.user.id),
  ),
  create: workspaceProcedure
    .input(z.object({ ...projectWorkers, defaultWorkerId: idInput.optional() }))
    .mutation(({ ctx, input }) =>
      createProject(ctx.runtime.drivers.db, ctx.access, ctx.user.id, input),
    ),
  update: sessionProcedure
    .input(
      z.object({ project: idInput, ...projectWorkers, defaultWorkerId: idInput.nullish() }),
    )
    .mutation(({ ctx, input: { project, ...change } }) =>
      updateProject(ctx.runtime.drivers.db, ctx.user.id, project, change),
    ),
  remove: sessionProcedure
    .input(z.object({ project: idInput }))
    .mutation(({ ctx, input }) => removeProject(ctx.runtime.drivers.db, ctx.user.id, input.project)),
  sealedName: sessionProcedure
    .input(z.object({ project: idInput }))
    .query(({ ctx, input }) =>
      projectSealedName(ctx.runtime.drivers.db, ctx.user.id, input.project),
    ),
  setName: sessionProcedure
    .input(nameChange.extend({ project: idInput }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.runtime.drivers.db;
      const { project } = await requireManageableProject(db, ctx.user.id, input.project);
      await setSealedName(
        db,
        { table: "projects", id: project.id, workspace: project.workspace },
        input.content,
        input.expected,
      );
    }),
});

const modelPreferenceInput = z.object({ model: z.string().max(MAX_MODEL_SLUG_LENGTH) });

export const preferencesRouter = router({
  /** The caller's pinned and hidden model slugs. */
  get: sessionProcedure.query(({ ctx }) =>
    getModelPreferences(ctx.runtime.drivers.db, ctx.user.id),
  ),
  /** Pins or unpins a model slug; pinning also un-hides it. */
  setModelPinned: sessionProcedure
    .input(modelPreferenceInput.extend({ pinned: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setModelPreference(
        ctx.runtime.drivers.db,
        ctx.user.id,
        input.model,
        "pinnedModels",
        input.pinned,
      ),
    ),
  /** Hides or unhides a model slug; hiding also un-pins it. */
  setModelHidden: sessionProcedure
    .input(modelPreferenceInput.extend({ hidden: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setModelPreference(
        ctx.runtime.drivers.db,
        ctx.user.id,
        input.model,
        "hiddenModels",
        input.hidden,
      ),
    ),
});
