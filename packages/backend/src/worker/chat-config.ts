import { v, type Infer } from "convex/values";

export const chatWorkerToolValidator = v.union(
  v.literal("read"),
  v.literal("edit"),
  v.literal("create"),
  v.literal("bash"),
);

/** A Worker capability that can be enabled for a chat or preselected as a workspace default. */
export type ChatWorkerTool = Infer<typeof chatWorkerToolValidator>;

/**
 * Owner-selected Worker tools for a chat. `workerId` is optional so tools can be chosen before a
 * Worker is; dispatch requires one. `directory` is derived server-side (Project folder, then the
 * Worker's reported temp directory) and never accepted from clients.
 */
export const chatWorkerSelectionValidator = v.object({
  workerId: v.optional(v.string()),
  directory: v.optional(v.string()),
  tools: v.array(chatWorkerToolValidator),
});

/** Stored chat Worker selection; execution requires both `workerId` and `directory`. */
export type ChatWorkerSelection = Infer<typeof chatWorkerSelectionValidator>;

/** A selection that names a Worker, as required before building or dispatching Worker tools. */
export type ChatWorkerTarget = ChatWorkerSelection & { workerId: string };

/** Accept an absolute POSIX/Windows path without depending on the backend host OS. */
export function validChatWorkerDirectory(directory: string): boolean {
  return (
    directory.length <= 4096 &&
    !directory.includes("\0") &&
    /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(directory)
  );
}

/** Changing the configured root starts a new native session rather than switching a live one. */
export async function chatWorkerSessionId(chatId: string, directory: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(directory));
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `${chatId}_${suffix}`;
}

/** Identity-component metadata needed to authorize a Worker as an execution target. */
export type WorkerTargetMetadata = {
  workerId: string;
  workspaceId: string;
  status: "active" | "revoked";
};

/** Look up identity metadata for a Worker in an already-selected workspace. */
export type WorkerMetadataLookup = (workerId: string) => Promise<WorkerTargetMetadata | null>;

/**
 * Require the Worker identity to be active in the given workspace. Callers check owner authority
 * first. Identity lookup failures are treated as an invalid target and fail closed.
 */
export async function requireActiveWorkspaceWorker(
  workerId: string,
  workspaceId: string,
  getWorkerMetadata: WorkerMetadataLookup,
): Promise<void> {
  let worker: WorkerTargetMetadata | null;
  try {
    worker = await getWorkerMetadata(workerId);
  } catch {
    // The identity component reports missing and foreign-workspace Workers as
    // errors; treat either as an invalid selection and fail closed.
    worker = null;
  }

  if (
    !worker ||
    worker.workerId !== workerId ||
    worker.workspaceId !== workspaceId ||
    worker.status !== "active"
  ) {
    throw new Error("Worker must be active in this workspace.");
  }
}

/**
 * Validate owner authority, unique tools, a well-formed stored directory, and, when a Worker is
 * named, that it is active in the same workspace. A selection without `workerId` only records
 * tool choices. Identity lookup failures are treated as an invalid selection; the input is
 * returned unchanged.
 */
export async function validateChatWorkerSelection(
  selection: ChatWorkerSelection,
  userId: string,
  workspace: { id: string; ownerId: string },
  getWorkerMetadata: WorkerMetadataLookup,
): Promise<ChatWorkerSelection> {
  if (workspace.ownerId !== userId) {
    throw new Error("Only the workspace owner can configure a Worker for chats.");
  }

  if (new Set(selection.tools).size !== selection.tools.length) {
    throw new Error("Worker tools must be unique.");
  }
  if (selection.directory !== undefined && !validChatWorkerDirectory(selection.directory)) {
    throw new Error("Worker directory must be an absolute path on the Worker.");
  }

  if (selection.workerId !== undefined) {
    await requireActiveWorkspaceWorker(selection.workerId, workspace.id, getWorkerMetadata);
  }

  return selection;
}
