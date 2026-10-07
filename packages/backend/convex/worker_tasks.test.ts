/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { register } from "worker-component/test";
import { api, components, internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";
import { WORKER_TASK_CLEANUP_BATCH, WORKER_TASK_RETENTION_MS } from "../src/worker/task-contract";

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
      name: "Tasks",
    }),
  );
  // Exercise real identity persistence without involving the HTTP proof boundary,
  // which is independently covered by workers.test.ts.
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

  const first = await enroll("first-worker");
  const second = await enroll("second-worker");
  const owner = t.withIdentity({ subject: "owner" });
  const chatId = await t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "personal",
      messages: [],
      chat_completions: [],
    }),
  );
  const dispatch = {
    workspace,
    workerId: first.identity.workerId,
    requestId: "tool-call-1",
    operation: "future-tool",
    chatId,
    toolCallId: "call-1",
  };
  const taskId = await owner.mutation(internal.worker_tasks.create, dispatch);
  return { t, owner, workspace, first, second, chatId, dispatch, taskId };
}

test("dispatch is owner-authorized, chat-visible, workspace-bound and idempotent", async () => {
  const f = await fixture();
  expect(await f.owner.mutation(internal.worker_tasks.create, f.dispatch)).toBe(f.taskId);
  await expect(
    f.owner.mutation(internal.worker_tasks.create, {
      ...f.dispatch,
      operation: "different-operation",
    }),
  ).rejects.toThrow();
  await expect(f.t.mutation(internal.worker_tasks.create, f.dispatch)).rejects.toThrow();
  await f.t.run((ctx) =>
    ctx.db.insert("workspace_members", {
      workspace: f.workspace,
      userId: "member",
      role: "member",
    }),
  );
  await expect(
    f.t.withIdentity({ subject: "member" }).mutation(internal.worker_tasks.create, f.dispatch),
  ).rejects.toThrow();

  const privateChat = await f.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace: f.workspace,
      userId: "member",
      scope: "personal",
      messages: [],
      chat_completions: [],
    }),
  );
  await expect(
    f.owner.mutation(internal.worker_tasks.create, {
      ...f.dispatch,
      requestId: "private",
      chatId: privateChat,
    }),
  ).rejects.toThrow();

  const foreignWorkspace = await f.t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Foreign",
    }),
  );
  await expect(
    f.owner.mutation(internal.worker_tasks.create, {
      ...f.dispatch,
      workspace: foreignWorkspace,
      chatId: undefined,
      toolCallId: undefined,
    }),
  ).rejects.toThrow();
  await f.owner.mutation(api.workers.revoke, {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
  });
  await expect(
    f.owner.mutation(internal.worker_tasks.create, {
      ...f.dispatch,
      requestId: "revoked",
    }),
  ).rejects.toThrow();
});

test("assigned machine transitions are fenced, retry-aware and reject foreign or revoked authority", async () => {
  const f = await fixture();
  const machine = f.first.machine;
  expect(
    (await machine.query(api.worker_tasks.assigned, { status: "sent" })).map((t) => t._id),
  ).toEqual([f.taskId]);
  expect(await f.second.machine.query(api.worker_tasks.assigned, { status: "sent" })).toEqual([]);
  await expect(
    f.second.machine.mutation(api.worker_tasks.updateStatus, {
      taskId: f.taskId,
      expectedRevision: 0,
      status: "processing",
    }),
  ).rejects.toThrow();
  await expect(f.owner.query(api.worker_tasks.assigned, { status: "sent" })).rejects.toThrow();
  await expect(
    machine.mutation(api.worker_tasks.updateStatus, {
      taskId: f.taskId,
      expectedRevision: 0,
      status: "success",
    }),
  ).rejects.toThrow("WORKER_TASK_INVALID_TRANSITION");

  const processing = { taskId: f.taskId, expectedRevision: 0, status: "processing" as const };
  const started = await machine.mutation(api.worker_tasks.updateStatus, processing);
  expect(started.attempt).toBe(1);
  expect(await machine.mutation(api.worker_tasks.updateStatus, processing)).toEqual(started);
  await machine.mutation(api.worker_tasks.updateStatus, {
    taskId: f.taskId,
    expectedRevision: 1,
    status: "failed",
  });
  const retry = await machine.mutation(api.worker_tasks.updateStatus, {
    taskId: f.taskId,
    expectedRevision: 2,
    status: "retrying",
  });
  expect(retry.terminalAt).toBeUndefined();
  const restarted = await machine.mutation(api.worker_tasks.updateStatus, {
    taskId: f.taskId,
    expectedRevision: 3,
    status: "processing",
  });
  expect(restarted.attempt).toBe(2);
  await expect(
    machine.mutation(api.worker_tasks.updateStatus, {
      taskId: f.taskId,
      expectedRevision: 1,
      status: "success",
    }),
  ).rejects.toThrow("WORKER_TASK_STALE_REVISION");
  await machine.mutation(api.worker_tasks.updateStatus, {
    taskId: f.taskId,
    expectedRevision: 4,
    status: "success",
  });
  await expect(
    machine.mutation(api.worker_tasks.updateStatus, {
      taskId: f.taskId,
      expectedRevision: 5,
      status: "retrying",
    }),
  ).rejects.toThrow("WORKER_TASK_INVALID_TRANSITION");

  await f.owner.mutation(api.workers.revoke, {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
  });
  await expect(machine.query(api.worker_tasks.assigned, { status: "success" })).rejects.toThrow();
  await expect(
    machine.mutation(api.worker_tasks.updateStatus, {
      taskId: f.taskId,
      expectedRevision: 4,
      status: "success",
    }),
  ).rejects.toThrow();
});

test("cleanup uses terminal age, retains all nonterminal states and preserves chat history", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now());
  const now = Date.now();
  const ids = await f.t.run(async (ctx) => {
    const result: Record<string, string> = {};
    for (const status of ["sent", "processing", "retrying", "failed", "success"] as const) {
      result[status] = await ctx.db.insert("worker_tasks", {
        ...f.dispatch,
        requestId: status,
        status,
        attempt: 1,
        revision: 1,
        updatedAt: now - WORKER_TASK_RETENTION_MS,
        terminalAt: status === "failed" || status === "success" ? now : undefined,
      });
    }
    return result;
  });

  vi.setSystemTime(now + WORKER_TASK_RETENTION_MS - 1);
  expect(await f.t.mutation(internal.worker_tasks.prune, {})).toBe(0);
  vi.setSystemTime(now + WORKER_TASK_RETENTION_MS);
  expect(await f.t.mutation(internal.worker_tasks.prune, {})).toBe(2);
  expect(await f.t.mutation(internal.worker_tasks.prune, {})).toBe(0);
  const remaining = await f.t.run((ctx) => ctx.db.query("worker_tasks").collect());
  expect(remaining.map((task) => task._id)).toContain(f.taskId);
  for (const status of ["sent", "processing", "retrying"]) {
    expect(remaining.map((task) => task._id)).toContain(ids[status]);
  }
  expect(await f.t.run((ctx) => ctx.db.get(f.chatId))).not.toBeNull();
});

test("cleanup bounds each terminal batch and subsequent ticks drain the backlog", async () => {
  const f = await fixture();
  const terminalAt = Date.now() - WORKER_TASK_RETENTION_MS;
  await f.t.run(async (ctx) => {
    for (const status of ["failed", "success"] as const) {
      for (let index = 0; index < WORKER_TASK_CLEANUP_BATCH + 1; index += 1) {
        await ctx.db.insert("worker_tasks", {
          ...f.dispatch,
          requestId: `${status}-${index}`,
          status,
          attempt: 1,
          revision: 1,
          updatedAt: terminalAt,
          terminalAt,
        });
      }
    }
  });
  expect(await f.t.mutation(internal.worker_tasks.prune, {})).toBe(2 * WORKER_TASK_CLEANUP_BATCH);
  expect(await f.t.mutation(internal.worker_tasks.prune, {})).toBe(2);
});

test("edit dispatch and output preserve owner, private-chat and assignment boundaries", async () => {
  const f = await fixture();
  const args = {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
    requestId: "edit-read",
    request: {
      directory: "/worker/project",
      sessionId: "session",
      action: { kind: "read" as const, path: "src/file.ts" },
    },
    chatId: f.chatId,
  };
  const taskId = await f.owner.mutation(api.worker_tasks.dispatchEdit, args);
  expect(await f.owner.mutation(api.worker_tasks.dispatchEdit, args)).toBe(taskId);
  await expect(
    f.owner.mutation(api.worker_tasks.dispatchEdit, {
      ...args,
      request: { ...args.request, directory: "/worker/another-project" },
    }),
  ).rejects.toThrow();
  const { directory: _directory, ...legacyRequest } = args.request;
  await expect(
    f.owner.mutation(api.worker_tasks.dispatchEdit, { ...args, request: legacyRequest } as never),
  ).rejects.toThrow();
  await expect(
    f.owner.mutation(api.worker_tasks.dispatchEdit, {
      ...args,
      request: { ...args.request, action: { kind: "read", path: "other.ts" } },
    }),
  ).rejects.toThrow();
  await expect(f.t.mutation(api.worker_tasks.dispatchEdit, args)).rejects.toThrow();
  await f.t.run((ctx) =>
    ctx.db.insert("workspace_members", {
      workspace: f.workspace,
      userId: "member",
      role: "member",
    }),
  );
  const member = f.t.withIdentity({ subject: "member" });
  await expect(member.mutation(api.worker_tasks.dispatchEdit, args)).rejects.toThrow();
  await expect(
    member.query(api.worker_tasks.outcome, { workspace: f.workspace, taskId }),
  ).rejects.toThrow();
  const privateChat = await f.t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace: f.workspace,
      userId: "member",
      scope: "personal",
      messages: [],
      chat_completions: [],
    }),
  );
  await expect(
    f.owner.mutation(api.worker_tasks.dispatchEdit, {
      ...args,
      chatId: privateChat,
      requestId: "private-edit",
    }),
  ).rejects.toThrow();
  await expect(
    f.second.machine.mutation(api.worker_tasks.claimEdit, { taskId, claimId: "other" }),
  ).rejects.toThrow();
  expect(
    (
      await f.first.machine.query(api.worker_tasks.assigned, { status: "sent", operation: "edit" })
    ).map((task) => task._id),
  ).toEqual([taskId]);
  await expect(
    f.owner.mutation(api.worker_tasks.dispatchEdit, {
      ...args,
      requestId: "large",
      request: {
        directory: "/worker/project",
        sessionId: "session",
        action: { kind: "preview", patch: "a".repeat(33 * 1024) },
      },
    }),
  ).rejects.toThrow();
  expect(
    (await f.owner.query(api.worker_tasks.outcome, { workspace: f.workspace, taskId }))
      ?.editRequest,
  ).toEqual(args.request);
  await f.t.run((ctx) => ctx.db.patch(f.chatId, { userId: "member" }));
  await expect(
    f.owner.query(api.worker_tasks.outcome, { workspace: f.workspace, taskId }),
  ).rejects.toThrow();
});

test("edit claims exclude competing connections and completion retries never reopen execution", async () => {
  const f = await fixture();
  const taskId = await f.owner.mutation(api.worker_tasks.dispatchEdit, {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
    requestId: "apply",
    request: {
      directory: "/worker/project",
      sessionId: "session",
      action: { kind: "apply", previewId: "preview" },
    },
  });
  const claim = { taskId, claimId: "process-1" };
  const task = await f.first.machine.mutation(api.worker_tasks.claimEdit, claim);
  expect(task?.status).toBe("processing");
  expect(await f.first.machine.mutation(api.worker_tasks.claimEdit, claim)).toEqual(task);
  expect(
    await f.first.machine.mutation(api.worker_tasks.claimEdit, { ...claim, claimId: "process-2" }),
  ).toBeNull();
  await expect(
    f.first.machine.mutation(api.worker_tasks.updateStatus, {
      taskId,
      expectedRevision: 1,
      status: "retrying",
    }),
  ).rejects.toThrow();
  const completion = {
    ...claim,
    expectedRevision: 1,
    result: { ok: true as const, output: "changed" },
  };
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      ...completion,
      claimId: "process-2",
    }),
  ).rejects.toThrow();
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      ...completion,
      result: { ok: true, output: "a".repeat(129 * 1024) },
    }),
  ).rejects.toThrow();
  const done = await f.first.machine.mutation(api.worker_tasks.completeEdit, completion);
  expect(done.status).toBe("success");
  expect(await f.first.machine.mutation(api.worker_tasks.completeEdit, completion)).toEqual(done);
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      ...completion,
      result: { ok: true, output: "different" },
    }),
  ).rejects.toThrow();
  expect(await f.first.machine.mutation(api.worker_tasks.claimEdit, claim)).toBeNull();
  await f.owner.mutation(api.workers.revoke, {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
  });
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, completion),
  ).rejects.toThrow();
});

test("native error context is bounded, idempotent and expires with the failed task", async () => {
  const f = await fixture();
  const args = {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
    requestId: "rejected",
    request: {
      sessionId: "session",
      directory: "/worker/project",
      action: { kind: "read" as const, path: "file.ts", startLine: 10, maxLines: 20 },
    },
  };
  await expect(
    f.owner.mutation(api.worker_tasks.dispatchEdit, {
      ...args,
      request: { ...args.request, action: { ...args.request.action, startLine: 0 } },
    }),
  ).rejects.toThrow();
  const taskId = await f.owner.mutation(api.worker_tasks.dispatchEdit, args);
  await expect(
    f.owner.mutation(api.worker_tasks.dispatchEdit, {
      ...args,
      request: { ...args.request, action: { ...args.request.action, startLine: 11 } },
    }),
  ).rejects.toThrow();
  await f.first.machine.mutation(api.worker_tasks.claimEdit, { taskId, claimId: "process" });
  const receipt = {
    taskId,
    claimId: "process",
    expectedRevision: 1,
    result: { ok: false as const, code: "EDIT_REJECTED", output: "stale reference context" },
  };
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      ...receipt,
      result: { ...receipt.result, output: "x".repeat(129 * 1024) },
    }),
  ).rejects.toThrow();
  const failed = await f.first.machine.mutation(api.worker_tasks.completeEdit, receipt);
  expect(failed.status).toBe("failed");
  expect(await f.first.machine.mutation(api.worker_tasks.completeEdit, receipt)).toEqual(failed);
  await expect(
    f.first.machine.mutation(api.worker_tasks.completeEdit, {
      ...receipt,
      result: { ...receipt.result, output: "different context" },
    }),
  ).rejects.toThrow();
  await f.t.run((ctx) =>
    ctx.db.patch(taskId, { terminalAt: Date.now() - WORKER_TASK_RETENTION_MS }),
  );
  expect(await f.t.mutation(internal.worker_tasks.prune, {})).toBe(1);
  expect(
    await f.owner.query(api.worker_tasks.outcome, { workspace: f.workspace, taskId }),
  ).toBeNull();
});
