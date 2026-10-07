import type { ConvexClient } from "convex/browser";
import { createHash } from "node:crypto";
import type { FunctionReturnType } from "convex/server";
import { api } from "backend/convex/_generated/api";
import {
  WORKER_EDIT_OUTPUT_BYTES,
  type WorkerEditRequest,
  type WorkerEditResult,
} from "backend/src/worker/edit-contract";

type Task = FunctionReturnType<typeof api.worker_tasks.assigned>[number];

export interface EditExecutor {
  execute(request: WorkerEditRequest): Promise<string>;
  close(): Promise<void>;
}

/** Serialize edit work and retry only result delivery, never filesystem execution. */
export function consumeEditTasks(client: ConvexClient, executor: EditExecutor) {
  const claimId = crypto.randomUUID();
  let available = false;
  let stopped = false;
  let assignments: Task[] = [];
  let running: Promise<void> | undefined;
  let changed = false;
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
  });
  const receipts = new Map<string, { task: Task; result: WorkerEditResult }>();
  const network = <T>(promise: Promise<T>) => Promise.race([promise, cancelled]);

  async function pump() {
    if (running || stopped || !available) return;
    changed = false;
    running = (async () => {
      for (const receipt of receipts.values()) {
        if (stopped || !available) return;
        try {
          const delivered = await network(
            client.mutation(api.worker_tasks.completeEdit, {
              taskId: receipt.task._id,
              claimId,
              expectedRevision: receipt.task.revision,
              result: receipt.result,
            }),
          );
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
        if (!assignment.editRequest || !assignment.editOwnerId || assignment.operation !== "edit")
          continue;
        let task: Task | null | undefined;
        try {
          task = await network(
            client.mutation(api.worker_tasks.claimEdit, { taskId: assignment._id, claimId }),
          );
        } catch {
          return;
        }
        if (!task || stopped || !available) continue;
        // Local native snapshots cannot cross a workspace, caller, or chat boundary.
        const sessionId = createHash("sha256")
          .update(
            JSON.stringify([
              task.workspace,
              task.editOwnerId,
              task.chatId ?? null,
              task.editRequest!.sessionId,
            ]),
          )
          .digest("hex");
        let result: WorkerEditResult;
        try {
          const output = await executor.execute({ ...task.editRequest!, sessionId });
          result = editResult(output);
        } catch {
          result = { ok: false, code: "EDIT_EXECUTION_FAILED" };
        }
        receipts.set(task._id, { task, result });
        if (stopped || !available) return;
        try {
          const delivered = await network(
            client.mutation(api.worker_tasks.completeEdit, {
              taskId: task._id,
              claimId,
              expectedRevision: task.revision,
              result,
            }),
          );
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

  const unsubscribe = client.onUpdate(
    api.worker_tasks.assigned,
    { status: "sent", operation: "edit" },
    (tasks) => {
      assignments = tasks;
      changed = true;
      void pump();
    },
    () => {
      available = false;
    },
  );
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
      await running;
      // Finish an already-running local edit before closing the transport. This is
      // a bounded best-effort flush; a crash/partition still has an unknown outcome.
      for (const receipt of receipts.values()) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 2_000);
          });
          const delivered = await Promise.race([
            client.mutation(api.worker_tasks.completeEdit, {
              taskId: receipt.task._id,
              claimId,
              expectedRevision: receipt.task.revision,
              result: receipt.result,
            }),
            timeout,
          ]);
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

function editResult(output: string): WorkerEditResult {
  if (new TextEncoder().encode(output).length > WORKER_EDIT_OUTPUT_BYTES)
    return { ok: false, code: "EDIT_OUTPUT_TOO_LARGE" };
  try {
    const response: unknown = JSON.parse(output);
    if (response && typeof response === "object" && "ok" in response && response.ok === false) {
      const code =
        "code" in response &&
        typeof response.code === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(response.code)
          ? response.code
          : "EDIT_EXECUTION_FAILED";
      return { ok: false, code, output };
    }
  } catch {
    /* Non-JSON executor output is still a bounded tool result. */
  }
  return { ok: true, output };
}
