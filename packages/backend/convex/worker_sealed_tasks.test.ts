/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { register } from "worker-component/test";
import { api, components, internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";
import type * as WorkerKeys from "../src/e2ee/worker-keys";
import { resolveWorkerChatTransport } from "../src/worker/chat-tools";
import type { ActionCtx } from "./_generated/server";

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

// Roster certification is Slice 1's boundary (tested there); here a listed Worker is "paired".
const paired = vi.hoisted(() => new Set<string>());
vi.mock("../src/e2ee/worker-keys", async (original) => ({
  ...(await original<typeof WorkerKeys>()),
  requireDispatchableWorker: async (_ctx: unknown, _workspace: unknown, workerId: string) =>
    paired.has(workerId)
      ? {
          keyId: "worker-key",
          encryptionPublicKey: new ArrayBuffer(1216),
          signingPublicKey: new ArrayBuffer(32),
        }
      : null,
}));

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  paired.clear();
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.invalid");
  const t = convexTest(schema, modules);
  register(t);
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Sealed" }),
  );
  const tokenHash = await tokenDigest("sealed-worker".padEnd(43, "_"));
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
  const machine = t.withIdentity({
    ...identity,
    subject: identity.workerId,
    kind: "worker",
    issuer: workerIssuer("https://backend.example.invalid"),
  });
  const worker = {
    workerId: identity.workerId,
    directory: "/worker/project",
    tools: ["read", "edit", "bash"] as ("read" | "edit" | "bash")[],
  };
  const chatId = await t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "personal",
      e2eeId: "chat-e2ee",
      worker,
    }),
  );
  const owner = t.withIdentity({ subject: "owner" });
  const sealedArgs = {
    chatId,
    userId: "owner",
    workerId: identity.workerId,
    directory: worker.directory,
    tool: "bash" as const,
    toolCallId: "call-1",
    stage: "execute" as const,
    sealed: {
      keyId: "worker-key",
      encapsulated: new Uint8Array(1120).fill(7).buffer,
      request: new Uint8Array(4096).fill(9).buffer,
    },
    receiptEpoch: 1,
  };
  return { t, workspace, identity, machine, worker, chatId, owner, sealedArgs };
}

test("chat transport preflight reaches the real query validator and resolves a paired Worker", async () => {
  const f = await fixture();
  paired.add(f.identity.workerId);
  const ctx = { runQuery: f.t.query.bind(f.t) } as unknown as ActionCtx;
  const transport = await resolveWorkerChatTransport(ctx, {
    chatId: f.chatId,
    userId: "owner",
    workerId: f.identity.workerId,
    encrypted: true,
  });
  // The fixture has no chat key yet: certification succeeded, but sealing must stay blocked.
  expect(transport).toMatchObject({ kind: "blocked", code: "CHAT_KEY_UNAVAILABLE" });
});

test("encrypted chats and paired Workers never receive a plaintext task", async () => {
  const f = await fixture();
  const plaintext = {
    chatId: f.chatId,
    userId: "owner",
    workerId: f.identity.workerId,
    directory: f.worker.directory,
    tool: "read" as const,
    toolCallId: "read-1",
    stage: "read" as const,
    request: {
      sessionId: "s",
      directory: f.worker.directory,
      action: { kind: "read" as const, path: "secret.txt" },
    },
  };
  // Keyless workspace, unpaired Worker, but the chat has keys.
  await expect(
    f.owner.mutation(internal.worker_tasks.dispatchChatEdit, plaintext),
  ).rejects.toThrow();

  paired.add(f.identity.workerId);
  await f.t.run((ctx) => ctx.db.patch(f.chatId, { e2eeId: undefined }));
  await expect(
    f.owner.mutation(internal.worker_tasks.dispatchChatEdit, plaintext),
  ).rejects.toThrow();
  expect(await f.t.run((ctx) => ctx.db.query("worker_tasks").collect())).toEqual([]);
});

test("a sealed task stores only bytes and dispatches each call stage once", async () => {
  const f = await fixture();
  // Not certified: refused before anything is stored.
  await expect(
    f.owner.mutation(internal.worker_tasks.dispatchSealedChatTask, f.sealedArgs),
  ).rejects.toThrow();
  paired.add(f.identity.workerId);

  for (const bad of [
    { sealed: { ...f.sealedArgs.sealed, keyId: "re-paired-key" } },
    { sealed: { ...f.sealedArgs.sealed, encapsulated: new ArrayBuffer(32) } },
    { sealed: { ...f.sealedArgs.sealed, request: new ArrayBuffer(300 * 1024) } },
    { stage: "read" as const },
    { tool: "create" as const, stage: "preview" as const },
    { userId: "member" },
  ]) {
    await expect(
      f.owner.mutation(internal.worker_tasks.dispatchSealedChatTask, { ...f.sealedArgs, ...bad }),
    ).rejects.toThrow();
  }
  // Apply needs a completed preview of the same call.
  await expect(
    f.owner.mutation(internal.worker_tasks.dispatchSealedChatTask, {
      ...f.sealedArgs,
      tool: "edit",
      stage: "apply",
      toolCallId: "edit-1",
    }),
  ).rejects.toThrow();

  const first = await f.owner.mutation(internal.worker_tasks.dispatchSealedChatTask, f.sealedArgs);
  expect(first.replay).toBe(false);
  const replay = await f.owner.mutation(internal.worker_tasks.dispatchSealedChatTask, f.sealedArgs);
  expect(replay).toEqual({ taskId: first.taskId, replay: true });

  const task = await f.t.run((ctx) => ctx.db.get(first.taskId));
  expect(task).toMatchObject({ operation: "bash", sealed: { keyId: "worker-key" } });
  expect(task?.editRequest).toBeUndefined();
  expect(task?.bashRequest).toBeUndefined();
  const [call] = await f.t.run((ctx) => ctx.db.query("worker_chat_calls").collect());
  expect(call).toMatchObject({ requestKey: task!.requestId, receiptEpoch: 1 });
  expect(call?.result).toBeUndefined();
});

test("sealed completion keeps only ciphertext, requires the named receipt and is idempotent", async () => {
  const f = await fixture();
  paired.add(f.identity.workerId);
  const { taskId } = await f.owner.mutation(
    internal.worker_tasks.dispatchSealedChatTask,
    f.sealedArgs,
  );
  const [assigned] = await f.machine.query(api.worker_tasks.assigned, {
    status: "sent",
    operation: "bash",
  });
  expect(assigned?.sealed?.keyId).toBe("worker-key");
  await f.machine.mutation(api.worker_tasks.claimEdit, { taskId, claimId: "process" });

  // A plaintext result can never be attached to a sealed task.
  await expect(
    f.machine.mutation(api.worker_tasks.completeEdit, {
      taskId,
      claimId: "process",
      expectedRevision: 1,
      result: { ok: true, output: "plaintext" },
    }),
  ).rejects.toThrow();

  const completion = {
    taskId,
    claimId: "process",
    expectedRevision: 1,
    ok: true,
    result: new Uint8Array(512).fill(1).buffer,
    receipt: new Uint8Array(2048).fill(2).buffer,
  };
  // The dispatch named a chat key epoch, so the result must come with its sealed receipt.
  await expect(
    f.machine.mutation(api.worker_tasks.completeSealedTask, { ...completion, receipt: undefined }),
  ).rejects.toThrow();
  await expect(
    f.machine.mutation(api.worker_tasks.completeSealedTask, { ...completion, claimId: "other" }),
  ).rejects.toThrow();

  expect(await f.machine.mutation(api.worker_tasks.completeSealedTask, completion)).toEqual({
    completed: true,
  });
  expect(await f.machine.mutation(api.worker_tasks.completeSealedTask, completion)).toEqual({
    completed: true,
  });
  await expect(
    f.machine.mutation(api.worker_tasks.completeSealedTask, {
      ...completion,
      result: new Uint8Array(512).fill(3).buffer,
    }),
  ).rejects.toThrow();

  const outcome = await f.owner.query(internal.worker_tasks.sealedChatTaskOutcome, {
    chatId: f.chatId,
    userId: "owner",
    taskId,
  });
  expect(outcome?.ok).toBe(true);
  expect(new Uint8Array(outcome!.result!)).toEqual(new Uint8Array(completion.result));
  const [call] = await f.t.run((ctx) => ctx.db.query("worker_chat_calls").collect());
  expect(new Uint8Array(call!.sealedResult!)).toEqual(new Uint8Array(completion.receipt));
  expect(call?.result).toBeUndefined();

  // After the task is pruned, an identical receipt is acknowledged, a different one is refused.
  await f.t.run((ctx) => ctx.db.delete(taskId));
  expect(await f.machine.mutation(api.worker_tasks.completeSealedTask, completion)).toEqual({
    receiptAcknowledged: true,
  });
  await expect(
    f.machine.mutation(api.worker_tasks.completeSealedTask, {
      ...completion,
      receipt: new Uint8Array(2048).fill(4).buffer,
    }),
  ).rejects.toThrow();
});
