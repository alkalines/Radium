/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { register } from "worker-component/test";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";
import { chatWorkerSessionId } from "../src/worker/chat-config";
import { WORKER_TASK_RETENTION_MS } from "../src/worker/task-contract";

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: async (ctx: QueryCtx) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity || identity.kind === "worker") throw new Error("Not logged in");
      return { _id: identity.subject };
    },
  },
  createAuth: vi.fn(),
}));

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.invalid");
  const t = convexTest(schema, modules);
  register(t);
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Chat Worker",
    }),
  );

  async function enroll(name: string) {
    const tokenHash = await tokenDigest(name.padEnd(43, "_"));
    const pair = await generateKeyPair("ES256", { extractable: true });
    const publicKey = await normalizeWorkerKey(await exportJWK(pair.publicKey));
    await t.run((ctx) =>
      ctx.runMutation(components.workerIdentity.enrollment.createEnrollment, {
        workspaceId: workspace,
        name: tokenHash,
        tokenHash,
        expiresAt: Date.now() + 60_000,
        capabilities: [],
      }),
    );
    const identity = await t.run((ctx) =>
      ctx.runMutation(components.workerIdentity.enrollment.completeEnrollment, {
        workspaceId: workspace,
        tokenHash,
        requestId: tokenHash,
        publicKey,
      }),
    );
    return {
      identity,
      machine: t.withIdentity({
        ...identity,
        subject: identity.workerId,
        kind: "worker",
        issuer: workerIssuer("https://backend.example.invalid"),
      }),
    };
  }

  const first = await enroll("chat-worker-1");
  const second = await enroll("chat-worker-2");
  const worker = {
    workerId: first.identity.workerId,
    directory: "/worker/project",
    tools: ["read", "edit", "create"],
  } as const;
  const chatId = await t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "workspace",
      worker: worker as never,
    }),
  );
  const owner = t.withIdentity({ subject: "owner" });

  async function dispatch(overrides: Record<string, unknown> = {}) {
    const result = await owner.mutation(internal.worker_tasks.dispatchChatEdit, {
      chatId,
      userId: "owner",
      workerId: first.identity.workerId,
      directory: worker.directory,
      tool: "read",
      toolCallId: "call-1",
      stage: "read",
      request: {
        sessionId: "untrusted-session",
        directory: worker.directory,
        action: { kind: "read" as const, path: "src/file.ts" },
      },
      ...overrides,
    } as never);
    return result.taskId;
  }

  return { t, workspace, first, second, worker, chatId, owner, dispatch };
}

test("Bash dispatch enforces owner/chat/Worker configuration and retains one-shot receipts", async () => {
  const f = await fixture();
  const args = {
    chatId: f.chatId,
    userId: "owner",
    workerId: f.first.identity.workerId,
    directory: f.worker.directory,
    tool: "bash" as const,
    stage: "execute" as const,
    toolCallId: "bash-1",
    request: {
      sessionId: "untrusted",
      directory: f.worker.directory,
      command: "printf done",
      timeoutSeconds: 5,
    },
  };
  const dispatch = (overrides = {}) =>
    f.owner.mutation(internal.worker_tasks.dispatchChatEdit, { ...args, ...overrides });
  await expect(dispatch()).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.patch(f.chatId, { worker: { ...f.worker, tools: ["bash"] } }));
  await expect(dispatch({ userId: "member" })).rejects.toThrow();
  const privateChatId = await f.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace: f.workspace,
      userId: "member",
      scope: "personal",
      worker: { ...f.worker, tools: ["bash"] },
    }),
  );
  await expect(dispatch({ chatId: privateChatId })).rejects.toThrow();
  await expect(dispatch({ workerId: f.second.identity.workerId })).rejects.toThrow();
  await expect(dispatch({ directory: "/different" })).rejects.toThrow();
  await expect(dispatch({ stage: "preview" })).rejects.toThrow();
  await expect(dispatch({ request: { ...args.request, timeoutSeconds: 0 } })).rejects.toThrow();
  const { taskId } = await dispatch();
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 4; i++)
      await ctx.db.insert("worker_tasks", {
        workspace: f.workspace,
        workerId: f.first.identity.workerId,
        requestId: `legacy-${i}`,
        operation: "aaa-metadata",
        status: "sent",
        revision: 0,
        attempt: 0,
        updatedAt: Date.now(),
      });
  });
  expect(
    await f.first.machine.query(api.worker_tasks.assigned, { status: "sent", operation: "bash" }),
  ).toEqual([expect.objectContaining({ _id: taskId })]);
  const call = await f.t.run((ctx) =>
    ctx.db
      .query("worker_chat_calls")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .unique(),
  );
  expect(call!.requestKey).toMatch(/^[a-f0-9]{64}$/);
  const stored = await f.t.run((ctx) => ctx.db.get(taskId));
  expect(stored).toMatchObject({
    operation: "bash",
    bashRequest: {
      sessionId: await chatWorkerSessionId(f.chatId, f.worker.directory),
      command: "printf done",
    },
  });
  await expect(
    f.second.machine.mutation(api.worker_tasks.claimEdit, { taskId, claimId: "wrong-worker" }),
  ).rejects.toThrow();
  await expect(
    f.first.machine.mutation(api.worker_tasks.updateStatus, {
      taskId,
      expectedRevision: 0,
      status: "processing",
    }),
  ).rejects.toThrow();
  const claimed = await f.first.machine.mutation(api.worker_tasks.claimEdit, {
    taskId,
    claimId: "bash-claim",
  });
  expect(claimed).not.toBeNull();
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      taskId,
      claimId: "bash-claim",
      expectedRevision: claimed!.revision,
      result: { ok: true, output: "x".repeat(32 * 1024 + 1) },
    }),
  ).rejects.toThrow();
  const result = {
    ok: true as const,
    output: JSON.stringify({ ok: true, exitCode: 0, output: "done" }),
  };
  await f.first.machine.mutation(api.worker_tasks.completeEdit, {
    taskId,
    claimId: "bash-claim",
    expectedRevision: claimed!.revision,
    result,
  });
  await f.t.run((ctx) =>
    ctx.db.patch(taskId, { terminalAt: Date.now() - WORKER_TASK_RETENTION_MS }),
  );
  expect(await f.owner.mutation(internal.worker_tasks.prune, {})).toBe(1);
  expect(
    await f.first.machine.mutation(api.worker_tasks.completeEdit, {
      taskId,
      claimId: "bash-claim",
      expectedRevision: claimed!.revision,
      result,
    }),
  ).toEqual({ receiptAcknowledged: true });
  await expect(
    f.second.machine.mutation(api.worker_tasks.completeEdit, {
      taskId,
      claimId: "bash-claim",
      expectedRevision: claimed!.revision,
      result,
    }),
  ).rejects.toThrow();
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      taskId,
      claimId: "wrong-claim",
      expectedRevision: claimed!.revision,
      result,
    }),
  ).rejects.toThrow();
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      taskId,
      claimId: "bash-claim",
      expectedRevision: claimed!.revision,
      result: { ...result, output: "different" },
    }),
  ).rejects.toThrow();
  expect(await dispatch()).toEqual({ taskId });
  expect(
    await f.owner.query(internal.worker_tasks.chatEditOutcome, {
      chatId: f.chatId,
      userId: "owner",
      taskId,
    }),
  ).toEqual(result);
  await expect(
    dispatch({ request: { ...args.request, command: "different command" } }),
  ).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.patch(f.chatId, { worker: { ...f.worker, tools: [] } }));
  await expect(dispatch()).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.delete(f.chatId));
  await f.owner.mutation(internal.worker_tasks.cleanupChatCalls, { chatId: f.chatId });
  expect(
    await f.first.machine.mutation(api.worker_tasks.completeEdit, {
      taskId,
      claimId: "bash-claim",
      expectedRevision: claimed!.revision,
      result,
    }),
  ).toEqual({ receiptDiscarded: true });
});

test("chat dispatch is owner-only and reauthorizes workspace and personal chat visibility", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.insert("workspace_members", {
      workspace: f.workspace,
      userId: "member",
      role: "member",
    }),
  );

  await expect(f.dispatch({ userId: "member" })).rejects.toThrow();
  await expect(f.dispatch({ userId: "outsider" })).rejects.toThrow();

  const privateChat = await f.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace: f.workspace,
      userId: "member",
      scope: "personal",
      worker: f.worker as never,
    }),
  );
  await expect(
    f.owner.mutation(internal.worker_tasks.dispatchChatEdit, {
      chatId: privateChat,
      userId: "owner",
      workerId: f.first.identity.workerId,
      directory: f.worker.directory,
      tool: "read",
      toolCallId: "private-call",
      stage: "read",
      request: {
        sessionId: "ignored",
        directory: f.worker.directory,
        action: { kind: "read", path: "src/file.ts" },
      },
    }),
  ).rejects.toThrow();

  const foreignWorkspace = await f.t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "outsider",
      name: "Foreign",
    }),
  );
  const foreignChat = await f.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace: foreignWorkspace,
      userId: "outsider",
      scope: "workspace",
      worker: f.worker as never,
    }),
  );
  await expect(
    f.owner.mutation(internal.worker_tasks.dispatchChatEdit, {
      chatId: foreignChat,
      userId: "owner",
      workerId: f.first.identity.workerId,
      directory: f.worker.directory,
      tool: "read",
      toolCallId: "foreign-call",
      stage: "read",
      request: {
        sessionId: "ignored",
        directory: f.worker.directory,
        action: { kind: "read", path: "src/file.ts" },
      },
    }),
  ).rejects.toThrow();
});

test("dispatch requires the current active Worker, configured directory and enabled tool", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.patch(f.chatId, {
      worker: {
        workerId: f.first.identity.workerId,
        directory: f.worker.directory,
        tools: ["read"],
      } as never,
    }),
  );
  await expect(
    f.dispatch({
      tool: "edit",
      stage: "preview",
      toolCallId: "disabled-edit",
      request: {
        sessionId: "ignored",
        directory: f.worker.directory,
        action: { kind: "preview", patch: "*** Begin Patch\n*** End Patch" },
      },
    }),
  ).rejects.toThrow();

  await f.dispatch({ toolCallId: "assignment-bound-call" });
  await expect(f.dispatch({ directory: "/worker/other" })).rejects.toThrow();
  await expect(f.dispatch({ workerId: f.second.identity.workerId })).rejects.toThrow();
  await f.owner.mutation(api.workers.revoke, {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
  });
  await expect(f.dispatch()).rejects.toThrow();

  await f.t.run((ctx) =>
    ctx.db.patch(f.chatId, {
      worker: {
        workerId: f.second.identity.workerId,
        directory: "/worker/changed",
        tools: ["read"],
      } as never,
    }),
  );
  await expect(f.dispatch()).rejects.toThrow();
  await expect(
    f.dispatch({ workerId: f.second.identity.workerId, directory: "/worker/changed" }),
  ).rejects.toThrow();
  await expect(
    f.owner.mutation(internal.worker_tasks.dispatchChatEdit, {
      chatId: f.chatId,
      userId: "owner",
      workerId: f.second.identity.workerId,
      directory: "/worker/changed",
      tool: "read",
      toolCallId: "assignment-bound-call",
      stage: "read",
      request: {
        sessionId: "caller-controlled",
        directory: "/worker/changed",
        action: { kind: "read", path: "src/file.ts" },
      },
    }),
  ).rejects.toThrow();

  const changedDirectoryTask = await f.owner.mutation(internal.worker_tasks.dispatchChatEdit, {
    chatId: f.chatId,
    userId: "owner",
    workerId: f.second.identity.workerId,
    directory: "/worker/changed",
    tool: "read",
    toolCallId: "changed-directory-call",
    stage: "read",
    request: {
      sessionId: "caller-controlled",
      directory: "/worker/changed",
      action: { kind: "read", path: "src/file.ts" },
    },
  });
  const changedTask = await f.t.run((ctx) => ctx.db.get(changedDirectoryTask.taskId));
  expect(changedTask?.editRequest?.sessionId).toBe(
    await chatWorkerSessionId(f.chatId, "/worker/changed"),
  );
});

test("same chat call stage is idempotent and stores only the server-derived session and write mode", async () => {
  const f = await fixture();
  const readTaskId = await f.dispatch({
    request: {
      sessionId: "caller-controlled",
      directory: f.worker.directory,
      writeMode: "create",
      action: { kind: "read", path: "src/file.ts" },
    },
  });
  expect(
    await f.dispatch({
      request: {
        sessionId: "different-but-overwritten",
        directory: f.worker.directory,
        action: { kind: "read", path: "src/file.ts" },
      },
    }),
  ).toBe(readTaskId);
  await expect(
    f.dispatch({
      request: {
        sessionId: "ignored",
        directory: f.worker.directory,
        action: { kind: "read", path: "different.ts" },
      },
    }),
  ).rejects.toThrow();

  const readTask = await f.t.run((ctx) => ctx.db.get(readTaskId));
  expect(readTask?.editRequest).toMatchObject({
    sessionId: await chatWorkerSessionId(f.chatId, f.worker.directory),
    directory: f.worker.directory,
    action: { kind: "read", path: "src/file.ts" },
  });
  expect(readTask?.editRequest?.writeMode).toBeUndefined();
});

test("apply accepts only the successful preview receipt for the same tool call", async () => {
  const f = await fixture();
  const toolCallId = "edit-call";
  const previewRequest = {
    sessionId: "ignored",
    directory: f.worker.directory,
    writeMode: "create" as const,
    action: {
      kind: "preview" as const,
      patch: "*** Begin Patch\n*** Add File: new.ts\n+x\n*** End Patch",
    },
  };
  await expect(
    f.dispatch({
      tool: "edit",
      toolCallId,
      stage: "apply",
      request: {
        sessionId: "ignored",
        directory: f.worker.directory,
        action: { kind: "apply", previewId: "arbitrary-preview" },
      },
    }),
  ).rejects.toThrow();

  const previewTaskId = await f.dispatch({
    tool: "edit",
    toolCallId,
    stage: "preview",
    request: previewRequest,
  });
  await expect(
    f.dispatch({
      tool: "edit",
      toolCallId,
      stage: "apply",
      request: {
        sessionId: "ignored",
        directory: f.worker.directory,
        action: { kind: "apply", previewId: "preview-from-call" },
      },
    }),
  ).rejects.toThrow();
  const claimed = await f.first.machine.mutation(api.worker_tasks.claimEdit, {
    taskId: previewTaskId,
    claimId: "preview-worker",
  });
  expect(claimed?.editRequest?.writeMode).toBe("edit");
  await f.first.machine.mutation(api.worker_tasks.completeEdit, {
    taskId: previewTaskId,
    claimId: "preview-worker",
    expectedRevision: claimed!.revision,
    result: {
      ok: true,
      output: JSON.stringify({ ok: true, action: "preview", previewId: "preview-from-call" }),
    },
  });

  const applyArgs = {
    tool: "edit" as const,
    toolCallId,
    stage: "apply" as const,
    request: {
      sessionId: "ignored",
      directory: f.worker.directory,
      action: { kind: "apply" as const, previewId: "preview-from-call" },
    },
  };
  const applyTaskId = await f.dispatch(applyArgs);
  expect(await f.dispatch(applyArgs)).toBe(applyTaskId);
  await expect(
    f.dispatch({
      ...applyArgs,
      request: { ...applyArgs.request, action: { kind: "apply", previewId: "other-preview" } },
    }),
  ).rejects.toThrow();
  await expect(
    f.dispatch({
      ...applyArgs,
      toolCallId: "different-call",
    }),
  ).rejects.toThrow();

  const createTaskId = await f.dispatch({
    tool: "create",
    toolCallId: "create-call",
    stage: "preview",
    request: {
      sessionId: "ignored",
      directory: f.worker.directory,
      writeMode: "edit",
      action: {
        kind: "preview",
        patch: "*** Begin Patch\n*** Add File: new.ts\n+x\n*** End Patch",
      },
    },
  });
  expect((await f.t.run((ctx) => ctx.db.get(createTaskId)))?.editRequest?.writeMode).toBe("create");
});

test("chat result and call receipt survive five-minute task pruning", async () => {
  const f = await fixture();
  const taskId = await f.dispatch();
  const claimed = await f.first.machine.mutation(api.worker_tasks.claimEdit, {
    taskId,
    claimId: "read-worker",
  });
  const result = { ok: true as const, output: "file contents" };
  await f.first.machine.mutation(api.worker_tasks.completeEdit, {
    taskId,
    claimId: "read-worker",
    expectedRevision: claimed!.revision,
    result,
  });

  expect(
    await f.owner.query(internal.worker_tasks.chatEditOutcome, {
      chatId: f.chatId,
      userId: "owner",
      taskId,
    }),
  ).toEqual(result);
  await f.t.run((ctx) =>
    ctx.db.patch(taskId, { terminalAt: Date.now() - WORKER_TASK_RETENTION_MS }),
  );
  expect(await f.t.mutation(internal.worker_tasks.prune, {})).toBe(1);
  expect(await f.dispatch()).toBe(taskId);
  expect(
    await f.owner.query(internal.worker_tasks.chatEditOutcome, {
      chatId: f.chatId,
      userId: "owner",
      taskId,
    }),
  ).toEqual(result);

  await expect(
    f.owner.query(internal.worker_tasks.chatEditOutcome, {
      chatId: f.chatId,
      userId: "member",
      taskId,
    }),
  ).rejects.toThrow();
});

test("chat-call cleanup waits for deletion, drains batches and leaves no late result receipt", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const taskIds: Id<"worker_tasks">[] = [];
  for (let index = 0; index < 101; index += 1) {
    taskIds.push(await f.dispatch({ toolCallId: `cleanup-${index}` }));
  }

  expect(
    await f.t.mutation(internal.worker_tasks.cleanupChatCalls, { chatId: f.chatId }),
  ).toBeNull();
  await f.t.run((ctx) => ctx.db.delete("aisdk_chats", f.chatId));
  expect(await f.t.mutation(internal.worker_tasks.cleanupChatCalls, { chatId: f.chatId })).toBe(
    100,
  );
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("worker_chat_calls")
        .withIndex("by_chat_call_stage", (q) => q.eq("chatId", f.chatId))
        .take(1),
    ),
  ).toEqual([]);

  const taskId = taskIds[0]!;
  const claimed = await f.first.machine.mutation(api.worker_tasks.claimEdit, {
    taskId,
    claimId: "late-result",
  });
  await f.first.machine.mutation(api.worker_tasks.completeEdit, {
    taskId,
    claimId: "late-result",
    expectedRevision: claimed!.revision,
    result: { ok: true, output: "chat was already deleted" },
  });
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("worker_chat_calls")
        .withIndex("by_chat_call_stage", (q) => q.eq("chatId", f.chatId))
        .take(1),
    ),
  ).toEqual([]);
});

const queued = { text: "", files: [], model: "test-model", webSearch: false };

async function storedWorker(f: Awaited<ReturnType<typeof fixture>>, chatId: Id<"aisdk_chats">) {
  return (await f.t.run((ctx) => ctx.db.get(chatId)))?.worker;
}

test("Worker presence is machine-reported, owner-listed, and dropped on revoke", async () => {
  const f = await fixture();
  const firstId = f.first.identity.workerId;

  await expect(
    f.owner.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/radium" }),
  ).rejects.toThrow();
  await expect(
    f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "tmp/radium" }),
  ).rejects.toThrow("Worker temp directory must be an absolute path.");
  await f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/radium" });

  const workers = await f.owner.query(api.workers.list, { workspace: f.workspace });
  expect(workers.find((worker) => worker.workerId === firstId)).toMatchObject({
    lastSeenAt: expect.any(Number),
    tempDirectory: "/tmp/radium",
  });
  expect(
    workers.find((worker) => worker.workerId === f.second.identity.workerId),
  ).not.toHaveProperty("lastSeenAt");

  await f.owner.mutation(api.workers.revoke, { workspace: f.workspace, workerId: firstId });
  const afterRevoke = await f.owner.query(api.workers.list, { workspace: f.workspace });
  expect(afterRevoke.find((worker) => worker.workerId === firstId)).not.toHaveProperty(
    "lastSeenAt",
  );
});

test("chat Worker directories are derived server-side: Project folder, then temp directory", async () => {
  const f = await fixture();
  const firstId = f.first.identity.workerId;
  const secondId = f.second.identity.workerId;

  // Client directories are ignored; nothing is stored before the Worker reports one.
  const chatId = await f.owner.mutation(api.aisdk.CreateChat, {
    workspace: f.workspace,
    messages_queue: queued,
    worker: { workerId: firstId, directory: "/client/chosen", tools: ["read"] },
  });
  expect(await storedWorker(f, chatId)).toEqual({ workerId: firstId, tools: ["read"] });

  // A missing directory is derived on the next change, from the Worker's temp directory.
  await f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/first" });
  await f.owner.mutation(api.aisdk.SetChatWorker, {
    chatId,
    selection: { workerId: firstId, tools: ["read", "bash"] },
  });
  expect(await storedWorker(f, chatId)).toEqual({
    workerId: firstId,
    directory: "/tmp/first",
    tools: ["read", "bash"],
  });

  // Toggling tools keeps the stored directory even after the Worker reports a new one.
  await f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/first-new" });
  await f.owner.mutation(api.aisdk.SetChatWorker, {
    chatId,
    selection: { workerId: firstId, directory: "/client/ignored", tools: ["read"] },
  });
  expect(await storedWorker(f, chatId)).toMatchObject({ directory: "/tmp/first" });

  // Changing the Worker re-derives; a Worker without reports leaves the directory unset.
  await f.owner.mutation(api.aisdk.SetChatWorker, {
    chatId,
    selection: { workerId: secondId, tools: ["read"] },
  });
  expect(await storedWorker(f, chatId)).toEqual({ workerId: secondId, tools: ["read"] });

  const project = await f.owner.mutation(api.projects.create, {
    workspace: f.workspace,
    name: "Radium",
    folders: [
      { workerId: firstId, directory: "/srv/first" },
      { workerId: secondId, directory: "/srv/second" },
    ],
    defaultWorkerId: secondId,
  });

  // Moving into a Project uses its folder for the chat's Worker; leaving it falls back to temp.
  await f.owner.mutation(api.aisdk.SetChatProject, { chatId, project });
  expect(await storedWorker(f, chatId)).toMatchObject({ directory: "/srv/second" });
  await f.owner.mutation(api.aisdk.SetChatWorker, {
    chatId,
    selection: { workerId: firstId, tools: ["read"] },
  });
  expect(await storedWorker(f, chatId)).toMatchObject({ directory: "/srv/first" });
  await f.owner.mutation(api.aisdk.SetChatProject, { chatId, project: null });
  expect(await storedWorker(f, chatId)).toMatchObject({ directory: "/tmp/first-new" });

  // The Project folder wins over the temp directory for new chats too.
  const projectChat = await f.owner.mutation(api.aisdk.CreateChat, {
    workspace: f.workspace,
    messages_queue: queued,
    project,
    worker: { workerId: firstId, tools: ["edit"] },
  });
  expect(await storedWorker(f, projectChat)).toEqual({
    workerId: firstId,
    directory: "/srv/first",
    tools: ["edit"],
  });
});

test("Worker tools can be stored without a Worker, owner-only, and never dispatch", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.insert("workspace_members", {
      workspace: f.workspace,
      userId: "member",
      role: "member",
    }),
  );
  const member = f.t.withIdentity({ subject: "member" });

  const chatId = await f.owner.mutation(api.aisdk.CreateChat, {
    workspace: f.workspace,
    messages_queue: queued,
    worker: { directory: "/client/ignored", tools: ["read", "edit"] },
  });
  expect(await storedWorker(f, chatId)).toEqual({ tools: ["read", "edit"] });
  await expect(
    member.mutation(api.aisdk.CreateChat, {
      workspace: f.workspace,
      messages_queue: queued,
      worker: { tools: ["read"] },
    }),
  ).rejects.toThrow("Only the workspace owner can configure a Worker for chats.");

  // Even with a directory present, a selection without a Worker is denied at dispatch.
  await f.t.run((ctx) =>
    ctx.db.patch(f.chatId, { worker: { directory: f.worker.directory, tools: ["read"] } }),
  );
  await expect(f.dispatch()).rejects.toThrow();
});
