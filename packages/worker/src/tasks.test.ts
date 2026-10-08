import { afterEach, expect, test, vi } from "vitest";
import type { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { getFunctionName } from "convex/server";
import { api } from "backend/convex/_generated/api";
import { consumeEditTasks } from "./tasks.js";
import type { WorkerEditRequest } from "backend/src/worker/edit-contract";
import type { WorkerBashRequest } from "backend/src/worker/bash-contract";

type Task = FunctionReturnType<typeof api.worker_tasks.assigned>[number];
function isClaim(fn: unknown) {
  return getFunctionName(fn as typeof api.worker_tasks.claimEdit) === "worker_tasks:claimEdit";
}
const task = {
  _id: "task",
  workspace: "workspace",
  workerId: "worker",
  operation: "edit",
  editOwnerId: "owner",
  status: "sent",
  revision: 0,
  editRequest: { sessionId: "session", action: { kind: "read", path: "file" } },
} as Task;

function fixture() {
  let notify!: (tasks: Task[]) => void;
  const unsubscribe = vi.fn();
  const mutation = vi.fn(async (fn: unknown, _args: unknown): Promise<Task | null> =>
    isClaim(fn) ? { ...task, revision: 1 } : { ...task, status: "success" },
  );
  const client = {
    mutation,
    onUpdate: (_fn: unknown, _args: unknown, callback: typeof notify) => {
      notify = callback;
      return unsubscribe;
    },
  } as unknown as ConvexClient;
  const executor = {
    execute: vi.fn(async (_request: WorkerEditRequest) => "output"),
    close: vi.fn(async () => {}),
  };
  const consumer = consumeEditTasks(client, executor);
  return { consumer, executor, mutation, unsubscribe, notify: (tasks: Task[]) => notify(tasks) };
}

afterEach(() => {
  vi.useRealTimers();
});

test("consumption waits for authority, serializes updates and retries only completion", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.notify([task]);
  expect(f.executor.execute).not.toHaveBeenCalled();
  let failOutput = true;
  f.mutation.mockImplementation(async (fn) => {
    if (isClaim(fn)) return { ...task, revision: 1 };
    if (failOutput) throw new Error("offline");
    return { ...task, status: "success" };
  });
  f.consumer.setAvailable(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(f.executor.execute.mock.calls[0]?.[0]).toMatchObject({
    sessionId: expect.stringMatching(/^[a-f0-9]{64}$/),
    action: task.editRequest!.action,
  });
  failOutput = false;
  f.notify([]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(f.mutation.mock.calls.filter(([fn]) => !isClaim(fn))).toHaveLength(2);
  await f.consumer.close();
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  expect(f.executor.close).toHaveBeenCalledTimes(1);
});

test("disconnect before a claim response never executes; shutdown cancels pending network waits", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: Task) => void;
  f.mutation.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.consumer.setAvailable(true);
  f.notify([task]);
  await vi.advanceTimersByTimeAsync(1);
  f.consumer.setAvailable(false);
  finish({ ...task, revision: 1 });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.executor.execute).not.toHaveBeenCalled();
  f.consumer.setAvailable(true);
  await f.consumer.close();
  expect(f.executor.execute).not.toHaveBeenCalled();
  expect(f.executor.close).toHaveBeenCalledTimes(1);
});

test("a competing consumer's claim never reaches the local editor", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.mutation.mockResolvedValue(null);
  f.consumer.setAvailable(true);
  f.notify([task]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.executor.execute).not.toHaveBeenCalled();
  await f.consumer.close();
});

test("native rejection is a failed task while preserving its actionable error context", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const output = JSON.stringify({
    ok: false,
    code: "EDIT_REJECTED",
    message: "Read the changed file again.",
  });
  f.executor.execute.mockResolvedValue(output);
  f.consumer.setAvailable(true);
  f.notify([task]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.mutation.mock.calls.at(-1)?.[1]).toMatchObject({
    result: { ok: false, code: "EDIT_REJECTED", output },
  });
  await f.consumer.close();
});

test("tool exceptions become sanitized failures and session keys separate chats", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.executor.execute.mockRejectedValueOnce(new Error("secret file contents"));
  f.consumer.setAvailable(true);
  f.notify([task]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.mutation.mock.calls.at(-1)?.[1]).toMatchObject({
    result: { ok: false, code: "EDIT_EXECUTION_FAILED" },
  });
  const firstSession = f.executor.execute.mock.calls[0]?.[0]?.sessionId;
  const otherTask = { ...task, _id: "other-task", chatId: "other-chat" } as Task;
  f.mutation.mockImplementation(async (fn) =>
    isClaim(fn) ? { ...otherTask, revision: 1 } : { ...otherTask, status: "success" },
  );
  f.notify([otherTask]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.executor.execute.mock.calls[1]?.[0]?.sessionId).not.toBe(firstSession);
  await f.consumer.close();
});

test("shutdown drains the result of an in-flight edit before closing its session", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (output: string) => void;
  f.executor.execute.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.consumer.setAvailable(true);
  f.notify([task]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  const closing = f.consumer.close();
  expect(f.executor.close).not.toHaveBeenCalled();
  finish("applied");
  await closing;
  expect(f.mutation.mock.calls.at(-1)?.[1]).toMatchObject({
    result: { ok: true, output: "applied" },
  });
  expect(f.executor.close).toHaveBeenCalledTimes(1);
});

test("shutdown's completion flush has a deadline during transport loss", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.mutation.mockImplementation(async (fn) =>
    isClaim(fn) ? { ...task, revision: 1 } : new Promise(() => {}),
  );
  f.consumer.setAvailable(true);
  f.notify([task]);
  await vi.advanceTimersByTimeAsync(1);
  const closing = f.consumer.close();
  await vi.advanceTimersByTimeAsync(2_000);
  await closing;
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(f.executor.close).toHaveBeenCalledTimes(1);
});

test("Bash is claimed once, separated by chat scope, and only receipt delivery retries", async () => {
  vi.useFakeTimers();
  let notify!: (tasks: Task[]) => void;
  const bashTask = {
    ...task,
    operation: "bash",
    editRequest: undefined,
    chatId: "chat-1",
    bashRequest: {
      sessionId: "session",
      directory: "/project",
      command: "printf done",
      timeoutSeconds: 5,
    },
  } as Task;
  let offline = true;
  const mutation = vi.fn(async (fn: unknown) => {
    if (isClaim(fn)) return { ...bashTask, revision: 1 };
    if (offline) throw new Error("offline");
    return { receiptAcknowledged: true };
  });
  const client = {
    mutation,
    onUpdate: (_fn: unknown, args: unknown, callback: typeof notify) => {
      expect(args).toMatchObject({ status: "sent" });
      if ((args as { operation: string }).operation === "bash") notify = callback;
      return () => {};
    },
  } as unknown as ConvexClient;
  const editor = { execute: vi.fn(async () => "unused"), close: vi.fn(async () => {}) };
  const bash = {
    execute: vi.fn(async (_request: WorkerBashRequest) =>
      JSON.stringify({ ok: true, exitCode: 0, output: "done" }),
    ),
    close: vi.fn(async () => {}),
  };
  const consumer = consumeEditTasks(client, editor, bash);
  notify([bashTask]);
  expect(bash.execute).not.toHaveBeenCalled();
  consumer.setAvailable(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.execute).not.toHaveBeenCalled();
  expect(bash.execute).toHaveBeenCalledTimes(1);
  const session = bash.execute.mock.calls[0]![0].sessionId;
  expect(session).toMatch(/^[a-f0-9]{64}$/);
  notify([]);
  offline = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(bash.execute).toHaveBeenCalledTimes(1);
  expect(mutation.mock.calls.filter(([fn]) => isClaim(fn))).toHaveLength(1);
  expect(mutation.mock.calls.filter(([fn]) => !isClaim(fn)).length).toBeGreaterThanOrEqual(2);
  const deliveredCalls = mutation.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(mutation.mock.calls).toHaveLength(deliveredCalls);
  await consumer.close();
  expect(bash.close).toHaveBeenCalledTimes(1);
});

test("shutdown aborts an in-flight Bash command before flushing its receipt", async () => {
  vi.useFakeTimers();
  let notify!: (tasks: Task[]) => void;
  let finish!: (output: string) => void;
  const bashTask = {
    ...task,
    operation: "bash",
    editRequest: undefined,
    bashRequest: {
      sessionId: "session",
      directory: "/project",
      command: "sleep 20",
      timeoutSeconds: 30,
    },
  } as Task;
  const mutation = vi.fn(async (fn: unknown, _args: unknown) =>
    isClaim(fn) ? { ...bashTask, revision: 1 } : { ...bashTask, status: "failed" },
  );
  const client = {
    mutation,
    onUpdate: (_fn: unknown, args: { operation: string }, callback: typeof notify) => {
      if (args.operation === "bash") notify = callback;
      return () => {};
    },
  } as unknown as ConvexClient;
  const editor = { execute: vi.fn(async () => "unused"), close: vi.fn(async () => {}) };
  const bash = {
    execute: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
    close: vi.fn(async () => {
      finish(JSON.stringify({ ok: false, code: "BASH_ABORTED", output: "" }));
    }),
  };
  const consumer = consumeEditTasks(client, editor, bash);
  consumer.setAvailable(true);
  notify([bashTask]);
  await vi.advanceTimersByTimeAsync(1);
  await consumer.close();
  expect(bash.close).toHaveBeenCalledTimes(1);
  expect(bash.execute).toHaveBeenCalledTimes(1);
  expect(mutation.mock.calls.at(-1)![1]).toMatchObject({
    result: { ok: false, code: "BASH_ABORTED" },
  });
  expect(editor.close).toHaveBeenCalledTimes(1);
});

test("an oversized Bash receipt becomes a deliverable failure instead of blocking the queue", async () => {
  vi.useFakeTimers();
  let notify!: (tasks: Task[]) => void;
  const bashTask = {
    ...task,
    operation: "bash",
    editRequest: undefined,
    bashRequest: {
      sessionId: "session",
      directory: "/project",
      command: "printf output",
      timeoutSeconds: 5,
    },
  } as Task;
  const mutation = vi.fn(async (fn: unknown, _args: unknown) =>
    isClaim(fn) ? { ...bashTask, revision: 1 } : { ...bashTask, status: "failed" },
  );
  const client = {
    mutation,
    onUpdate: (_fn: unknown, args: { operation: string }, callback: typeof notify) => {
      if (args.operation === "bash") notify = callback;
      return () => {};
    },
  } as unknown as ConvexClient;
  const editor = { execute: vi.fn(async () => "unused"), close: vi.fn(async () => {}) };
  const bash = {
    execute: vi.fn(async () => "x".repeat(32 * 1024 + 1)),
    close: vi.fn(async () => {}),
  };
  const consumer = consumeEditTasks(client, editor, bash);
  consumer.setAvailable(true);
  notify([bashTask]);
  await vi.advanceTimersByTimeAsync(1);
  expect(mutation.mock.calls.at(-1)![1]).toMatchObject({
    result: { ok: false, code: "BASH_OUTPUT_TOO_LARGE" },
  });
  notify([]);
  const deliveredCalls = mutation.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(mutation.mock.calls).toHaveLength(deliveredCalls);
  await consumer.close();
});

test("task subscription failures are isolated and recover without a control transition", async () => {
  vi.useFakeTimers();
  const streams = new Map<string, { notify: (tasks: Task[]) => void; error: () => void }>();
  const bashTask = {
    ...task,
    _id: "bash-task",
    operation: "bash",
    editRequest: undefined,
    bashRequest: {
      sessionId: "session",
      directory: "/project",
      command: "printf done",
      timeoutSeconds: 5,
    },
  } as Task;
  const claimed = new Set<string>();
  const client = {
    mutation: vi.fn(async (fn: unknown, args: { taskId: string }) => {
      if (!isClaim(fn)) return { receiptAcknowledged: true };
      if (claimed.has(args.taskId)) return null;
      claimed.add(args.taskId);
      return { ...(args.taskId === bashTask._id ? bashTask : task), revision: 1 };
    }),
    onUpdate: (
      _fn: unknown,
      args: { operation: string },
      notify: (tasks: Task[]) => void,
      error: () => void,
    ) => {
      streams.set(args.operation, { notify, error });
      return () => {};
    },
  } as unknown as ConvexClient;
  const editor = { execute: vi.fn(async () => "output"), close: vi.fn(async () => {}) };
  const bash = {
    execute: vi.fn(async () => JSON.stringify({ ok: true, exitCode: 0, output: "done" })),
    close: vi.fn(async () => {}),
  };
  const consumer = consumeEditTasks(client, editor, bash);
  expect([...streams.keys()]).toEqual(["edit", "bash"]);
  streams.get("bash")!.notify([bashTask]);
  streams.get("bash")!.error();
  streams.get("edit")!.notify([task]);
  consumer.setAvailable(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.execute).toHaveBeenCalledTimes(1);
  expect(bash.execute).not.toHaveBeenCalled();
  streams.get("edit")!.notify([]);
  streams.get("bash")!.notify([bashTask]);
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.execute).toHaveBeenCalledTimes(1);
  expect(bash.execute).toHaveBeenCalledTimes(1);
  await consumer.close();
});
