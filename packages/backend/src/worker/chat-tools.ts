import { tool, type ToolSet, type ToolApprovalConfiguration } from "ai";
import { z } from "zod";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  chatWorkerSessionId,
  validChatWorkerDirectory,
  type ChatWorkerSelection,
} from "./chat-config";
import type { WorkerEditRequest, WorkerEditResult } from "./edit-contract";
import { WORKER_BASH_TIMEOUT_SECONDS } from "./bash-contract";

const WAIT_MS = 45_000;
const POLL_MS = 500;

type WorkerChatScope = {
  chatId: Id<"aisdk_chats">;
  workspaceId: Id<"workspaces">;
  userId: string;
  selection: ChatWorkerSelection;
};

/** Bind SDK approval signatures to this owner, chat, Worker, directory and tool selection. */
export async function workerChatApprovalSecret(issuerSecret: string, scope: WorkerChatScope) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(issuerSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const context = JSON.stringify([
    "radium-worker-chat-approval-v1",
    scope.userId,
    scope.workspaceId,
    scope.chatId,
    scope.selection.workerId,
    scope.selection.directory,
    [...scope.selection.tools].sort(),
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(context)));
}

/** AI SDK tools execute only through authorized Convex task coordination, never local filesystem APIs. */
export function buildWorkerChatTools(
  ctx: ActionCtx,
  scope: WorkerChatScope,
): {
  tools: ToolSet;
  toolApproval: ToolApprovalConfiguration<ToolSet, unknown>;
} {
  const { selection, chatId, userId } = scope;
  const directory = selection.directory;
  if (!directory || !validChatWorkerDirectory(directory)) {
    throw new Error(
      "Set an absolute Worker directory in the prompt's Worker menu before using Worker tools.",
    );
  }
  const tools: ToolSet = {};
  const toolApproval: ToolApprovalConfiguration<ToolSet, unknown> = {};
  let writesQueue: Promise<unknown> = Promise.resolve();

  async function executeStage(
    kind: "read" | "edit" | "create",
    toolCallId: string,
    stage: "read" | "preview" | "apply",
    action: WorkerEditRequest["action"],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) return { ok: false, code: "REQUEST_ABORTED" };
    const { taskId } = await ctx.runMutation(internal.worker_tasks.dispatchChatEdit, {
      chatId,
      userId,
      workerId: selection.workerId,
      directory: directory!,
      tool: kind,
      toolCallId,
      stage,
      request: {
        directory: directory!,
        sessionId: await chatWorkerSessionId(chatId, directory!),
        action,
      },
    });
    return waitForOutcome(taskId, signal);
  }

  async function waitForOutcome(
    taskId: Id<"worker_tasks">,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + WAIT_MS;
    while (!signal?.aborted && Date.now() < deadline) {
      const result: WorkerEditResult | null = await ctx.runQuery(
        internal.worker_tasks.chatEditOutcome,
        {
          chatId,
          userId,
          taskId,
        },
      );
      if (result) {
        if (result.output) {
          try {
            const output: unknown = JSON.parse(result.output);
            if (output && typeof output === "object" && !Array.isArray(output)) {
              return result.ok
                ? (output as Record<string, unknown>)
                : { ...output, ok: false, code: result.code };
            }
          } catch {
            /* A malformed receipt must never advance to apply. */
          }
        }
        return result.ok
          ? { ok: false, code: "INVALID_WORKER_OUTPUT" }
          : { ok: false, code: result.code };
      }
      if (signal?.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, POLL_MS);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    return {
      ok: false,
      code: "WORKER_OUTCOME_UNKNOWN",
      taskId,
      message:
        "The Worker did not return a result. It may be disconnected or the task may still run. Do not retry this operation; inspect its outcome first.",
    };
  }

  async function write(
    kind: "edit" | "create",
    patch: string,
    callId: string,
    signal?: AbortSignal,
  ) {
    // The native session permits one pending preview. Serialize approved writes
    // within this model turn, including concurrent SDK tool execution.
    const result = writesQueue.then(async () => {
      const preview = await executeStage(
        kind,
        callId,
        "preview",
        { kind: "preview", patch },
        signal,
      );
      if (preview.ok !== true || typeof preview.previewId !== "string") return preview;
      return executeStage(
        kind,
        callId,
        "apply",
        { kind: "apply", previewId: preview.previewId },
        signal,
      );
    });
    writesQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  if (selection.tools.includes("read")) {
    tools.worker_read = tool({
      description:
        "Read a text file relative to the selected Worker directory. Returns hashline snapshots and the exact edit grammar. Read before editing; use nextLine to continue truncated reads.",
      inputSchema: z.object({
        path: z.string().min(1).max(4096),
        startLine: z.number().int().positive().optional(),
        maxLines: z.number().int().min(1).max(5000).optional(),
      }),
      execute: ({ path, startLine, maxLines }, { toolCallId, abortSignal }) =>
        executeStage(
          "read",
          toolCallId,
          "read",
          { kind: "read", path, startLine, maxLines },
          abortSignal,
        ),
    });
  }
  if (selection.tools.includes("edit")) {
    tools.worker_edit = tool({
      description:
        "Edit existing text files using a hashline patch built from worker_read's snapshots and grammar (or an apply_patch Update File envelope). Requires user approval before staging and applying. Cannot create, delete or move files. Only paths inside the selected Worker directory are allowed. Never automatically retry an unknown or partial write outcome.",
      inputSchema: z.object({ patch: z.string().min(1).max(30_000) }),
      execute: ({ patch }, { toolCallId, abortSignal }) =>
        write("edit", patch, toolCallId, abortSignal),
    });
    toolApproval.worker_edit = "user-approval";
  }
  if (selection.tools.includes("create")) {
    tools.worker_create = tool({
      description:
        "Create a new UTF-8 text file relative to the selected Worker directory. Requires user approval before staging and applying. Refuses existing files; cannot modify existing files. Never automatically retry an unknown write outcome.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine((path) => !/[\r\n\0]/.test(path), "Path must be one line"),
        content: z
          .string()
          .max(24_000)
          .refine((content) => !content.includes("\0"), "Text only"),
      }),
      execute: ({ path, content }, { toolCallId, abortSignal }) => {
        const patch = `*** Begin Patch\n*** Add File: ${path}\n${content
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}\n*** End Patch`;
        return write("create", patch, toolCallId, abortSignal);
      },
    });
    toolApproval.worker_create = "user-approval";
  }
  if (selection.tools.includes("bash")) {
    tools.worker_bash = tool({
      description:
        "Run a foreground shell command on the selected Worker, starting in its configured directory. Requires user approval. Supports pipelines, redirection, builtins and installed executables. Runs with the Worker's OS permissions and environment; the directory is not a sandbox. Returns bounded combined output, exit status and timeout metadata. No managed background jobs, PTY or services. Never automatically retry an unknown outcome.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(16 * 1024)
          .refine(
            (value) => value.trim().length > 0 && !value.includes("\0"),
            "Command must be nonempty and contain no NUL",
          ),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(WORKER_BASH_TIMEOUT_SECONDS)
          .default(WORKER_BASH_TIMEOUT_SECONDS),
      }),
      execute: async ({ command, timeout }, { toolCallId, abortSignal }) => {
        if (abortSignal?.aborted) return { ok: false, code: "REQUEST_ABORTED" };
        const { taskId } = await ctx.runMutation(internal.worker_tasks.dispatchChatEdit, {
          chatId,
          userId,
          workerId: selection.workerId,
          directory: directory!,
          tool: "bash",
          toolCallId,
          stage: "execute",
          request: {
            directory: directory!,
            sessionId: await chatWorkerSessionId(chatId, directory!),
            command,
            timeoutSeconds: timeout,
          },
        });
        return waitForOutcome(taskId, abortSignal);
      },
    });
    toolApproval.worker_bash = "user-approval";
  }
  return { tools, toolApproval };
}
