import { v, type Infer } from "convex/values";
import { validChatWorkerDirectory } from "./chat-config";

/** Foreground commands have a deadline shorter than the Chatroom receipt wait. */
export const WORKER_BASH_TIMEOUT_SECONDS = 30;
export const WORKER_BASH_OUTPUT_BYTES = 32 * 1024;
export const workerBashRequest = v.object({
  directory: v.string(),
  sessionId: v.string(),
  command: v.string(),
  timeoutSeconds: v.number(),
});
export type WorkerBashRequest = Infer<typeof workerBashRequest>;

export function validWorkerBashRequest(request: WorkerBashRequest): boolean {
  return (
    validChatWorkerDirectory(request.directory) &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(request.sessionId) &&
    request.command.trim().length > 0 &&
    !request.command.includes("\0") &&
    new TextEncoder().encode(request.command).length <= 16 * 1024 &&
    Number.isInteger(request.timeoutSeconds) &&
    request.timeoutSeconds >= 1 &&
    request.timeoutSeconds <= WORKER_BASH_TIMEOUT_SECONDS
  );
}

/** Stable dispatch identity; a changed approved command cannot reuse its receipt. */
export async function workerBashRequestKey(request: WorkerBashRequest): Promise<string> {
  const canonical = JSON.stringify([
    request.sessionId,
    request.directory,
    request.command,
    request.timeoutSeconds,
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
