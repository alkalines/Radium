import { components } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import {
  validChatWorkerDirectory,
  validateChatWorkerSelection,
  type ChatWorkerSelection,
  type WorkerMetadataLookup,
} from "./chat-config";

/** Look up Worker identity metadata scoped to one workspace through the identity component. */
export function workspaceWorkerMetadata(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): WorkerMetadataLookup {
  return (workerId) =>
    ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId,
      workerId,
    });
}

/** Read one Worker's latest heartbeat row, if it has ever reported presence. */
export async function findWorkerPresence(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  workerId: string,
): Promise<Doc<"worker_presence"> | null> {
  return await ctx.db
    .query("worker_presence")
    .withIndex("by_workspace_and_workerId", (q) =>
      q.eq("workspace", workspaceId).eq("workerId", workerId),
    )
    .unique();
}

/**
 * Derive a chat's Worker directory server-side: the chat Project's folder for that Worker, else
 * the Worker's reported temp directory, else none (Worker tools then report that the Worker has
 * no working directory). Foreign-workspace Projects never contribute a folder.
 */
export async function deriveChatWorkerDirectory(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  workerId: string,
  projectId: Id<"projects"> | undefined,
): Promise<string | undefined> {
  if (projectId) {
    const project = await ctx.db.get("projects", projectId);
    if (project?.workspace === workspaceId) {
      const folder = project.folders?.find((entry) => entry.workerId === workerId);
      if (folder) return folder.directory;
    }
  }

  const presence = await findWorkerPresence(ctx, workspaceId, workerId);
  const tempDirectory = presence?.tempDirectory;
  if (tempDirectory && validChatWorkerDirectory(tempDirectory)) return tempDirectory;
  return undefined;
}

/** Build the stored selection, omitting absent optional fields. */
function storedSelection(
  tools: ChatWorkerSelection["tools"],
  workerId: string | undefined,
  directory: string | undefined,
): ChatWorkerSelection {
  return {
    tools,
    ...(workerId !== undefined ? { workerId } : {}),
    ...(directory !== undefined ? { directory } : {}),
  };
}

/**
 * Validate an owner's requested chat Worker selection and return what to store. A client-sent
 * `directory` is ignored. When the Worker is unchanged and `current` already has a directory
 * (e.g. only tools were toggled) that directory is kept; otherwise it is derived with
 * {@link deriveChatWorkerDirectory} for the chat's Project.
 */
export async function resolveChatWorkerSelection(
  ctx: MutationCtx,
  args: {
    requested: ChatWorkerSelection;
    userId: string;
    workspace: Pick<Doc<"workspaces">, "_id" | "ownerId">;
    project: Id<"projects"> | undefined;
    current: ChatWorkerSelection | undefined;
  },
): Promise<ChatWorkerSelection> {
  const { workerId, tools } = args.requested;
  await validateChatWorkerSelection(
    { workerId, tools },
    args.userId,
    { id: args.workspace._id, ownerId: args.workspace.ownerId },
    workspaceWorkerMetadata(ctx, args.workspace._id),
  );

  if (workerId === undefined) return storedSelection(tools, undefined, undefined);

  if (args.current?.workerId === workerId && args.current.directory !== undefined) {
    return storedSelection(tools, workerId, args.current.directory);
  }

  const directory = await deriveChatWorkerDirectory(
    ctx,
    args.workspace._id,
    workerId,
    args.project,
  );
  return storedSelection(tools, workerId, directory);
}

/**
 * Re-derive a stored selection's directory after the chat moved to `project`. Selections without
 * a Worker are returned unchanged; callers apply this only when the Project actually changed.
 */
export async function rederiveChatWorkerDirectory(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  selection: ChatWorkerSelection,
  project: Id<"projects"> | undefined,
): Promise<ChatWorkerSelection> {
  if (selection.workerId === undefined) return selection;

  const directory = await deriveChatWorkerDirectory(ctx, workspaceId, selection.workerId, project);
  return storedSelection(selection.tools, selection.workerId, directory);
}
