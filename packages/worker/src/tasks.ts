import type { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { createHash } from "node:crypto";
import type { FunctionReturnType } from "convex/server";
import { api } from "backend/convex/_generated/api";
import {
  WORKER_EDIT_OUTPUT_BYTES,
  type WorkerEditRequest,
  type WorkerEditResult,
} from "backend/src/worker/edit-contract";
import { WORKER_BASH_OUTPUT_BYTES, type WorkerBashRequest } from "backend/src/worker/bash-contract";

type Task = FunctionReturnType<typeof api.worker_tasks.assigned>[number];

/** Executes Worker filesystem edit requests on the local machine. */
export interface EditExecutor {
  /** Execute one claimed edit and return its result text for receipt handling. */
  execute(request: WorkerEditRequest): Promise<string>;

  /** Release any local resources owned by the executor. */
  close(): Promise<void>;
}

/** Executes Worker Bash requests on the local machine. */
export interface BashExecutor {
  /** Execute one claimed Bash request and return its serialized result. */
  execute(request: WorkerBashRequest): Promise<string>;

  /** Abort active commands and release local shell resources. */
  close(): Promise<void>;
}

/**
 * Consume assigned edit tasks and, when supplied, Bash tasks on this Worker.
 *
 * The consumer claims each task before local execution. If receipt delivery fails,
 * it retains and retries the result without executing the task again. Shutdown
 * closes the Bash executor first, waits for local work, attempts a bounded receipt
 * flush, and then closes the edit executor. A process crash can leave an operation's
 * outcome unknown; receipts are in memory and are not replayed after restart.
 */
export function consumeEditTasks(
  client: ConvexClient,
  executor: EditExecutor,
  bashExecutor?: BashExecutor,
) {
  const claimId = crypto.randomUUID();
  let available = false;
  let stopped = false;
  let assignments: Task[] = [];
  let editAssignments: Task[] = [];
  let bashAssignments: Task[] = [];
  const healthyOperations = new Set<string>();
  let running: Promise<void> | undefined;
  let changed = false;
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
  });
  const receipts = new Map<string, { task: Task; result: WorkerEditResult }>();
  const network = <T>(promise: Promise<T>) => Promise.race([promise, cancelled]);

  async function completeReceipt(receipt: { task: Task; result: WorkerEditResult }) {
    try {
      return await client.mutation(api.worker_tasks.completeEdit, {
        taskId: receipt.task._id,
        claimId,
        expectedRevision: receipt.task.revision,
        result: receipt.result,
      });
    } catch (error) {
      if (isPermanentCompletionRejection(error)) return { receiptDiscarded: true as const };
      throw error;
    }
  }

  async function pump() {
    if (running || stopped || !available) return;
    changed = false;
    running = (async () => {
      for (const receipt of receipts.values()) {
        if (stopped || !available) return;
        try {
          const delivered = await network(completeReceipt(receipt));
          if (delivered) receipts.delete(receipt.task._id);
        } catch {
          // Retain the receipt for reconnection; never call execute again.
          return;
        }
      }
      // Do not accumulate execution results during an output transport outage.
      if (receipts.size) return;
      for (const assignment of assignments) {
        if (stopped || !available) return;
        if (!healthyOperations.has(assignment.operation)) continue;
        if (!assignment.editOwnerId) continue;
        if (assignment.operation === "edit") {
          if (!assignment.editRequest) continue;
        } else if (assignment.operation === "bash") {
          if (!assignment.bashRequest || !bashExecutor) continue;
        } else {
          continue;
        }
        let task: Task | null | undefined;
        try {
          task = await network(
            client.mutation(api.worker_tasks.claimEdit, { taskId: assignment._id, claimId }),
          );
        } catch {
          return;
        }
        if (!task) continue;
        if (stopped || !available) {
          receipts.set(task._id, { task, result: { ok: false, code: "NOT_EXECUTED" } });
          return;
        }
        // Local native snapshots cannot cross a workspace, caller, or chat boundary.
        const sessionId = createHash("sha256")
          .update(
            JSON.stringify([
              task.workspace,
              task.editOwnerId,
              task.chatId ?? null,
              (task.bashRequest ?? task.editRequest)!.sessionId,
            ]),
          )
          .digest("hex");
        let result: WorkerEditResult;
        try {
          const output =
            task.operation === "bash" && task.bashRequest && bashExecutor
              ? await bashExecutor.execute({ ...task.bashRequest, sessionId })
              : await executor.execute({ ...task.editRequest!, sessionId });
          result = executionResult(output, task.operation);
        } catch {
          result = {
            ok: false,
            code: task.operation === "bash" ? "BASH_EXECUTION_FAILED" : "EDIT_EXECUTION_FAILED",
          };
        }
        receipts.set(task._id, { task, result });
        if (stopped || !available) return;
        try {
          const delivered = await network(completeReceipt({ task, result }));
          if (delivered) receipts.delete(task._id);
          else return;
        } catch {
          return;
        }
      }
    })().finally(() => {
      running = undefined;
      if (changed) {
        changed = false;
        void pump();
      }
    });
    await running;
  }

  function subscribe(operation: "edit" | "bash") {
    return client.onUpdate(
      api.worker_tasks.assigned,
      { status: "sent", operation },
      (tasks) => {
        healthyOperations.add(operation);
        if (operation === "edit") editAssignments = tasks;
        else bashAssignments = tasks;
        assignments = [...editAssignments, ...bashAssignments];
        changed = true;
        void pump();
      },
      () => {
        healthyOperations.delete(operation);
        // Query health is independent of control authority and the other stream.
        // Drop stale assignments for this operation until its subscription recovers.
        if (operation === "edit") editAssignments = [];
        else bashAssignments = [];
        assignments = [...editAssignments, ...bashAssignments];
        changed = true;
        void pump();
      },
    );
  }
  // Keep both reads indexed: metadata-only legacy assignments must not starve execution.
  const unsubscribe = subscribe("edit");
  const unsubscribeBash = bashExecutor ? subscribe("bash") : undefined;
  const retry = setInterval(() => {
    void pump();
  }, 5_000);

  return {
    setAvailable(value: boolean) {
      available = value;
      changed = true;
      if (value) void pump();
    },
    async close() {
      if (stopped) return;
      stopped = true;
      cancel();
      clearInterval(retry);
      unsubscribe();
      unsubscribeBash?.();
      await bashExecutor?.close();
      await running;
      // Finish an already-running local edit before closing the transport. This is
      // a bounded best-effort flush; a crash/partition still has an unknown outcome.
      for (const receipt of receipts.values()) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 2_000);
          });
          const delivered = await Promise.race([completeReceipt(receipt), timeout]);
          if (delivered) receipts.delete(receipt.task._id);
        } catch {
          // No replay on a later process; the processing task must be inspected.
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      await executor.close();
    },
  };
}

/** Identify completion rejections that cannot be fixed by retrying the receipt. */
function isPermanentCompletionRejection(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    (data.code === "WORKER_TASK_DENIED" || data.code === "WORKER_TASK_STALE_REVISION")
  );
}

function executionResult(output: string, operation: string): WorkerEditResult {
  const bash = operation === "bash";
  if (
    new TextEncoder().encode(output).length >
    (bash ? WORKER_BASH_OUTPUT_BYTES : WORKER_EDIT_OUTPUT_BYTES)
  )
    return { ok: false, code: bash ? "BASH_OUTPUT_TOO_LARGE" : "EDIT_OUTPUT_TOO_LARGE" };
  try {
    const response: unknown = JSON.parse(output);
    if (response && typeof response === "object" && "ok" in response && response.ok === false) {
      const fallbackCode = bash ? "BASH_EXECUTION_FAILED" : "EDIT_EXECUTION_FAILED";
      const code =
        "code" in response &&
        typeof response.code === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(response.code)
          ? response.code
          : fallbackCode;
      return { ok: false, code, output };
    }
  } catch {
    /* Non-JSON executor output is still a bounded tool result. */
  }
  return { ok: true, output };
}
