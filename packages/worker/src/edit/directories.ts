import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validWorkerEditRequest, type WorkerEditRequest } from "backend/src/worker/edit-contract";
import type { WorkerEditService } from "./service.js";

interface DirectorySession {
  directory: string;
  service: WorkerEditService;
}

/** Backend-selected execution directories, bound to an edit session until close. */
export class WorkerDirectoryEdits {
  private sessions = new Map<string, DirectorySession>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  execute(request: WorkerEditRequest): Promise<string> {
    const result = this.queue.then(() => this.executeSerial(request));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeSerial(request: WorkerEditRequest): Promise<string> {
    if (this.closed) return failure("SERVICE_CLOSED");
    if (!request.directory) return failure("DIRECTORY_REQUIRED");
    if (!validWorkerEditRequest(request)) return failure("INVALID_REQUEST");
    if (!isAbsolute(request.directory)) return failure("DIRECTORY_INVALID");
    const existing = this.sessions.get(request.sessionId);
    // Disposal needs no filesystem access and remains possible after a directory is removed.
    if (request.action.kind === "close") {
      await existing?.service.close();
      this.sessions.delete(request.sessionId);
      return JSON.stringify({ ok: true, action: "close", closed: !!existing });
    }
    let directory: string;
    try {
      directory = await realpath(request.directory);
      if (!(await stat(directory)).isDirectory()) return failure("DIRECTORY_INVALID");
    } catch {
      return failure("DIRECTORY_INVALID");
    }
    if (existing && existing.directory !== directory) return failure("SESSION_DIRECTORY_CHANGED");
    if (!existing && request.action.kind === "apply") return failure("UNKNOWN_SESSION");
    if (!existing && this.sessions.size >= 64) return failure("SESSION_LIMIT");
    // Native code is loaded only when the backend assigns an actual directory.
    const session = existing ?? {
      directory,
      service: await (await import("./service.js")).WorkerEditService.create(directory),
    };
    this.sessions.set(request.sessionId, session);
    try {
      const output = await session.service.execute(request);
      const usage = [...this.sessions.values()].reduce(
        (bytes, entry) => bytes + entry.service.stagingUsage.bytes,
        0,
      );
      if (usage > session.service.stagingUsage.limit) {
        await session.service.close();
        this.sessions.delete(request.sessionId);
        return failure("STAGED_PREVIEW_TOO_LARGE");
      }
      if (!existing && JSON.parse(output).ok !== true) {
        await session.service.close();
        this.sessions.delete(request.sessionId);
      }
      return output;
    } catch (error) {
      if (!existing) {
        await session.service.close();
        this.sessions.delete(request.sessionId);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await Promise.all([...this.sessions.values()].map((session) => session.service.close()));
    this.sessions.clear();
  }
}

function failure(code: string): string {
  return JSON.stringify({ ok: false, code });
}
