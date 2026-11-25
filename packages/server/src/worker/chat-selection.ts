import { toBase64Url } from "radium-crypto";
import {
  grantedChatWorkerTools,
  validChatWorkerDirectory,
  validateChatWorkerSelection,
  type ChatWorkerTool,
} from "contracts/worker/chat-config";
import type { StoredJson } from "../db/columns";
import type { Database, Kv } from "../drivers/types";
import { AppError } from "../errors";
import { projectWorkerDirectory } from "../workspaces/projects";
import { workerPresence } from "./presence";
import { activeWorkspaceWorkers } from "./workers";

/** A chat's stored Worker selection (`chats.worker` + `chats.worker_selection`), grant as text. */
export type StoredChatWorkerSelection = {
  workerId?: string;
  directory?: string;
  tools: ChatWorkerTool[];
  grant?: StoredChatWorkerGrant;
};
export type StoredChatWorkerGrant = {
  tools: ChatWorkerTool[];
  issuedAt: number;
  /** Unpadded base64url of the 64-byte Ed25519 signature. */
  signature: string;
  signerKeyId: string;
};

/**
 * A chat's Worker directory is derived server-side (Convex `deriveChatWorkerDirectory`): the chat
 * Project's folder for that Worker, else the Worker's reported temp directory (presence), else
 * none, and Worker tools then say the Worker has no working directory.
 */
async function deriveChatWorkerDirectory(
  db: Database,
  kv: Kv,
  workspace: string,
  workerId: string,
  project: string | null,
): Promise<string | undefined> {
  if (project) {
    const folder = await projectWorkerDirectory(db, workspace, project, workerId);
    if (folder !== undefined) return folder;
  }
  const tempDirectory = (await workerPresence(kv, [workerId])).get(workerId)?.tempDirectory;
  return tempDirectory && validChatWorkerDirectory(tempDirectory) ? tempDirectory : undefined;
}

function storedSelection(
  tools: ChatWorkerTool[],
  workerId: string | undefined,
  directory: string | undefined,
): StoredChatWorkerSelection {
  return {
    tools,
    ...(workerId !== undefined ? { workerId } : {}),
    ...(directory !== undefined ? { directory } : {}),
  };
}

/**
 * Validates an owner's requested chat Worker selection and returns what to store (Convex
 * `resolveChatWorkerSelection`). A client-sent directory or grant is ignored. When the Worker is
 * unchanged and `current` has a directory, that directory is kept; otherwise it is derived for
 * the chat's Project. The stored grant survives only while it still names the same Worker,
 * directory and granted tools.
 */
export async function resolveChatWorkerSelection(
  db: Database,
  kv: Kv,
  args: {
    requested: { workerId?: string; tools: ChatWorkerTool[] };
    userId: string;
    workspace: { id: string; ownerId: string };
    project: string | null;
    current: StoredChatWorkerSelection | undefined;
  },
): Promise<StoredChatWorkerSelection> {
  const { workerId, tools } = args.requested;
  await validateSelection(db, { workerId, tools }, args.userId, args.workspace);
  if (workerId === undefined) return storedSelection(tools, undefined, undefined);

  if (args.current?.workerId === workerId && args.current.directory !== undefined) {
    const kept = storedSelection(tools, workerId, args.current.directory);
    const grant = args.current.grant;
    const granted = grantedChatWorkerTools(tools);
    if (
      grant &&
      grant.tools.length === granted.length &&
      grant.tools.every((tool, index) => tool === granted[index])
    ) {
      return { ...kept, grant };
    }
    return kept;
  }
  const directory = await deriveChatWorkerDirectory(
    db,
    kv,
    args.workspace.id,
    workerId,
    args.project,
  );
  return storedSelection(tools, workerId, directory);
}

/** The contracts selection rules, refusing as `AppError` instead of a plain error. */
async function validateSelection(
  db: Database,
  selection: { workerId?: string; tools: ChatWorkerTool[] },
  userId: string,
  workspace: { id: string; ownerId: string },
) {
  if (workspace.ownerId !== userId) {
    throw new AppError("FORBIDDEN", "Only the workspace owner can configure a Worker for chats.");
  }
  try {
    await validateChatWorkerSelection(selection, userId, workspace, async (workerId) =>
      (await activeWorkspaceWorkers(db, workspace.id, [workerId])).has(workerId)
        ? { workerId, workspaceId: workspace.id, status: "active" }
        : null,
    );
  } catch (error) {
    throw new AppError("BAD_REQUEST", error instanceof Error ? error.message : "Invalid input.");
  }
}

/**
 * Re-derives a stored selection's directory after the chat moved to `project`. Selections without
 * a Worker are returned unchanged; callers apply this only when the Project actually changed.
 */
export async function rederiveChatWorkerDirectory(
  db: Database,
  kv: Kv,
  workspace: string,
  selection: StoredChatWorkerSelection,
  project: string | null,
): Promise<StoredChatWorkerSelection> {
  if (selection.workerId === undefined) return selection;
  const directory = await deriveChatWorkerDirectory(db, kv, workspace, selection.workerId, project);
  return storedSelection(selection.tools, selection.workerId, directory);
}

/**
 * Attaches the owner's signed standing grant to the stored selection it was signed for. The
 * signer names the Worker and directory it saw, so a selection that changed meanwhile is refused.
 * Grants only move forward (`issuedAt` above the stored one). Workers verify the signature.
 */
export function attachChatWorkerGrant(
  selection: StoredChatWorkerSelection | undefined,
  signed: {
    workerId: string;
    directory: string;
    grant: { tools: ChatWorkerTool[]; issuedAt: number; signature: Uint8Array; signerKeyId: string };
  },
): StoredChatWorkerSelection {
  const { grant } = signed;
  const granted = grantedChatWorkerTools(selection?.tools ?? []);
  if (
    !selection ||
    selection.workerId !== signed.workerId ||
    selection.directory !== signed.directory ||
    granted.length === 0 ||
    grant.tools.length !== granted.length ||
    grant.tools.some((tool, index) => tool !== granted[index]) ||
    !Number.isSafeInteger(grant.issuedAt) ||
    grant.issuedAt <= (selection.grant?.issuedAt ?? 0) ||
    grant.signature.byteLength !== 64 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(grant.signerKeyId)
  ) {
    throw new AppError("CONFLICT", "The Worker selection changed; authorize it again.");
  }
  return { ...selection, grant: { ...grant, signature: toBase64Url(grant.signature) } };
}

/** Splits a stored selection into the `chats.worker` column and the `worker_selection` json. */
export function chatWorkerColumns(selection: StoredChatWorkerSelection | null) {
  if (!selection) return { worker: null, workerSelection: null };
  const { workerId, ...rest } = selection;
  return { worker: workerId ?? null, workerSelection: rest satisfies StoredJson<unknown> };
}

/** Joins the `chats.worker` column and the `worker_selection` json back into one selection. */
export function chatWorkerSelection(chat: {
  worker: string | null;
  workerSelection: Omit<StoredChatWorkerSelection, "workerId"> | null;
}): StoredChatWorkerSelection | undefined {
  if (!chat.workerSelection) return undefined;
  return { ...chat.workerSelection, ...(chat.worker ? { workerId: chat.worker } : {}) };
}
