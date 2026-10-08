import { v, type Infer } from "convex/values";

export const chatWorkerToolValidator = v.union(
  v.literal("read"),
  v.literal("edit"),
  v.literal("create"),
  v.literal("bash"),
);

/** Owner-selected execution root and Worker tools for a chat. */
export const chatWorkerSelectionValidator = v.object({
  workerId: v.string(),
  directory: v.optional(v.string()),
  tools: v.array(chatWorkerToolValidator),
});

/** Directory is optional for legacy selections; execution requires it. */
export type ChatWorkerSelection = Infer<typeof chatWorkerSelectionValidator>;

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

type ChatWorkerMetadata = {
  workerId: string;
  workspaceId: string;
  status: "active" | "revoked";
};

/** Validate owner authority, a unique tool selection, and an active workspace Worker. */
export async function validateChatWorkerSelection(
  selection: ChatWorkerSelection,
  userId: string,
  workspace: { id: string; ownerId: string },
  getWorkerMetadata: () => Promise<ChatWorkerMetadata | null>,
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

  let worker: ChatWorkerMetadata | null;
  try {
    worker = await getWorkerMetadata();
  } catch {
    // The identity component reports missing and foreign-workspace Workers as
    // errors; treat either as an invalid selection and fail closed.
    worker = null;
  }

  if (
    !worker ||
    worker.workerId !== selection.workerId ||
    worker.workspaceId !== workspace.id ||
    worker.status !== "active"
  ) {
    throw new Error("Worker must be active in this workspace.");
  }

  return selection;
}
