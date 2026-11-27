import { eq } from "drizzle-orm";
import {
  chatKeyBindingStatement,
  chatKeyStatement,
  fingerprint,
  randomBytes,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  utf8,
} from "radium-crypto";
import { WORKER_TASK_ENCAPSULATED_BYTES } from "contracts/worker/task-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { eventually } from "../../test/streams";
import { classicUser } from "../../test/users";
import { insertWorker, machineCaller, workerIssuerEnv } from "../../test/workers";
import { chats } from "../chatroom/schema";
import { e2eeChatKeys, e2eeIdentities, e2eeRosters, e2eeWorkerKeys } from "../e2ee/schema";
import { currentStream } from "../streams/rotating";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { workerChatCalls, workerTasks } from "./schema";
import { revokeWorker } from "./identity";
import {
  chatReceiptKey,
  chatWorkerTarget,
  dispatchSealedChatTask,
  sealedChatTaskOutcome,
  TASK_SIGNAL,
  type SealedChatTaskDispatch,
} from "./tasks";

// Sealed Worker tool tasks (Convex `worker_sealed_tasks.test.ts`, `worker_tasks.test.ts` sealed
// paths): chat-handler services (owner, chat visibility, selected Worker/directory/tool,
// certified key, receipt key proofs), the Worker's assigned/claim/completeSealed procedures, and
// the three invariants under concurrency: dispatch dedupe, claim once, fenced completion.

type Role = "owner" | "member";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
const db = () => test.runtime.drivers.db;
const ownerSeed = new Uint8Array(32).fill(1);
const ownerKeyId = toBase64Url(new Uint8Array(16).fill(1));
const denied = { code: "FORBIDDEN", message: "WORKER_TASK_DENIED" };

beforeAll(async () => {
  test = await createTestRuntime({ env: (await workerIssuerEnv()).env });
  for (const role of ["owner", "member"] as const) {
    users[role] = await classicUser(test.runtime, `tasks-${role}@example.test`);
  }
  await db()
    .insert(e2eeIdentities)
    .values({
      userId: users.owner.id,
      keyId: ownerKeyId,
      suite: 1,
      encryptionPublicKey: new Uint8Array(1216).fill(5),
      signingPublicKey: await signingPublicKeyFromSeed(ownerSeed),
      secrets: new Uint8Array(1),
      selfSignature: new Uint8Array(64),
      recoveryWrapper: new Uint8Array(1),
      status: "active",
    });
});

afterAll(async () => {
  await test?.close();
});

let e2eeIds = 0;

/**
 * A keyed workspace with a Worker certified by the newest roster, and an owner chat whose
 * selection is that Worker in `/work` with Bash and Edit, keyed with a signed and bound epoch.
 */
async function fixture(options: { certified?: boolean; scope?: "personal" | "workspace" } = {}) {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Tasks", keyEpoch: 1 })
    .returning();
  const workspace = row!.id;
  await db()
    .insert(workspaceMembers)
    .values({ workspace, userId: users.member.id, role: "member" });
  const worker = await insertWorker(test.runtime, workspace);
  const keys = {
    encryptionPublicKey: randomBytes(1216),
    signingPublicKey: randomBytes(32),
  };
  await db()
    .insert(e2eeWorkerKeys)
    .values({
      worker: worker.workerId,
      keyId: "worker-key",
      suite: 1,
      ...keys,
      selfSignature: randomBytes(64),
      pairingMac: randomBytes(32),
      pairingId: "pairing",
    });
  if (options.certified !== false) {
    await db()
      .insert(e2eeRosters)
      .values({
        workspace,
        version: 2,
        body: utf8(
          JSON.stringify({
            v: 2,
            workers: [
              { workerId: worker.workerId, keyId: "worker-key", fingerprint: await fingerprint(keys) },
            ],
          }),
        ),
        signature: new Uint8Array(64),
        signerKeyId: ownerKeyId,
      });
  }

  const scope = options.scope ?? "personal";
  const e2eeId = toBase64Url(new Uint8Array(16).fill(++e2eeIds));
  const [chat] = await db()
    .insert(chats)
    .values({
      workspace,
      userId: users.owner.id,
      scope,
      e2eeId,
      keyEpoch: 1,
      worker: worker.workerId,
      workerSelection: { tools: ["bash", "edit"], directory: "/work" },
    })
    .returning();
  const key = { epoch: 1, keyId: "chat-key-1", suite: 1, publicKey: new Uint8Array(1216).fill(9) };
  const statement = { workspaceId: workspace, chatE2eeId: e2eeId, ...key };
  await db()
    .insert(e2eeChatKeys)
    .values({
      chat: chat!.id,
      ...key,
      signerUserId: users.owner.id,
      signerKeyId: ownerKeyId,
      signature: await sign(ownerSeed, chatKeyStatement(statement)),
      bindingSignature: await sign(
        ownerSeed,
        chatKeyBindingStatement({
          ...statement,
          chatId: chat!.id,
          scope,
          creatorId: users.owner.id,
          members: [],
        }),
      ),
    });

  const dispatch: SealedChatTaskDispatch = {
    chatId: chat!.id,
    userId: users.owner.id,
    workerId: worker.workerId,
    directory: "/work",
    tool: "bash",
    toolCallId: "call-1",
    stage: "execute",
    sealed: {
      keyId: "worker-key",
      encapsulated: new Uint8Array(WORKER_TASK_ENCAPSULATED_BYTES).fill(1),
      request: new Uint8Array(4096).fill(2),
    },
    receiptEpoch: 1,
  };
  return {
    workspace,
    worker,
    chat: chat!.id,
    dispatch,
    machine: await machineCaller(test.runtime, worker),
  };
}

const bytes = (size: number, fill: number) => toBase64Url(new Uint8Array(size).fill(fill));

describe("chat handler services", () => {
  it("are for the workspace owner in a chat they can see", async () => {
    const f = await fixture();
    const asMember = { chatId: f.chat, userId: users.member.id };
    await expect(
      chatWorkerTarget(db(), { ...asMember, workerId: f.worker.workerId }),
    ).rejects.toMatchObject(denied);
    await expect(chatReceiptKey(db(), asMember)).rejects.toMatchObject(denied);
    await expect(
      dispatchSealedChatTask(test.runtime, { ...f.dispatch, userId: users.member.id }),
    ).rejects.toMatchObject(denied);
    // A workspace chat the member can see is still the owner's to dispatch from.
    const shared = await fixture({ scope: "workspace" });
    await expect(
      dispatchSealedChatTask(test.runtime, { ...shared.dispatch, userId: users.member.id }),
    ).rejects.toMatchObject(denied);
    await db()
      .update(workspaces)
      .set({ archivedAt: new Date() })
      .where(eq(workspaces.id, f.workspace));
    await expect(dispatchSealedChatTask(test.runtime, f.dispatch)).rejects.toMatchObject(denied);
    expect(await db().select().from(workerTasks).where(eq(workerTasks.worker, f.worker.workerId))).toEqual(
      [],
    );
  });

  it("chatWorkerTarget gives the certified key; an uncertified Worker is not paired", async () => {
    const f = await fixture();
    const target = await chatWorkerTarget(db(), {
      chatId: f.chat,
      userId: users.owner.id,
      workerId: f.worker.workerId,
    });
    expect(target?.keyId).toBe("worker-key");
    expect(target?.encryptionPublicKey.byteLength).toBe(1216);
    const unpaired = await fixture({ certified: false });
    await expect(
      chatWorkerTarget(db(), {
        chatId: unpaired.chat,
        userId: users.owner.id,
        workerId: unpaired.worker.workerId,
      }),
    ).rejects.toMatchObject({ message: "WORKER_NOT_PAIRED" });
    await expect(dispatchSealedChatTask(test.runtime, unpaired.dispatch)).rejects.toMatchObject({
      message: "WORKER_NOT_PAIRED",
    });
  });

  it("chatReceiptKey gives a bound current epoch only", async () => {
    const f = await fixture();
    expect(await chatReceiptKey(db(), { chatId: f.chat, userId: users.owner.id })).toMatchObject({
      epoch: 1,
      keyId: "chat-key-1",
      signerKeyId: ownerKeyId,
      scope: "personal",
      creatorId: users.owner.id,
      members: [],
    });
    // A chat that must rekey is blocked.
    await db().update(chats).set({ rekey: true }).where(eq(chats.id, f.chat));
    expect(await chatReceiptKey(db(), { chatId: f.chat, userId: users.owner.id })).toBeNull();
    // An epoch whose binding does not match the current audience is blocked.
    const g = await fixture();
    await db()
      .update(e2eeChatKeys)
      .set({ bindingSignature: new Uint8Array(64) })
      .where(eq(e2eeChatKeys.chat, g.chat));
    expect(await chatReceiptKey(db(), { chatId: g.chat, userId: users.owner.id })).toBeNull();
  });

  it("a sealed task stores only bytes and dispatches each call stage once", async () => {
    const f = await fixture();
    for (const bad of [
      { sealed: { ...f.dispatch.sealed, keyId: "re-paired-key" } },
      { sealed: { ...f.dispatch.sealed, encapsulated: new Uint8Array(32) } },
      { sealed: { ...f.dispatch.sealed, request: new Uint8Array(300 * 1024) } },
      { sealed: { ...f.dispatch.sealed, request: new Uint8Array(0) } },
      { stage: "read" as const },
      { tool: "create" as const, stage: "preview" as const },
      { tool: "read" as const, stage: "read" as const },
      { directory: "/elsewhere" },
      { toolCallId: "x".repeat(129) },
      { receiptEpoch: -1 },
    ]) {
      await expect(dispatchSealedChatTask(test.runtime, { ...f.dispatch, ...bad })).rejects.toMatchObject(
        denied,
      );
    }
    // Apply needs a completed preview of the same call.
    await expect(
      dispatchSealedChatTask(test.runtime, { ...f.dispatch, tool: "edit", stage: "apply", toolCallId: "e" }),
    ).rejects.toMatchObject(denied);

    const first = await dispatchSealedChatTask(test.runtime, f.dispatch);
    expect(first.replay).toBe(false);
    expect(await dispatchSealedChatTask(test.runtime, f.dispatch)).toEqual({
      taskId: first.taskId,
      replay: true,
    });
    // The call id stays bound to its tool: another tool under it is refused.
    await expect(
      dispatchSealedChatTask(test.runtime, { ...f.dispatch, tool: "edit", stage: "preview" }),
    ).rejects.toMatchObject(denied);

    const [task] = await db().select().from(workerTasks).where(eq(workerTasks.id, first.taskId));
    expect(task).toMatchObject({
      operation: "bash",
      status: "sent",
      sealedKeyId: "worker-key",
      editRequest: null,
      bashRequest: null,
      result: null,
      chat: f.chat,
      editOwnerId: users.owner.id,
    });
    const [call] = await db()
      .select()
      .from(workerChatCalls)
      .where(eq(workerChatCalls.task, first.taskId));
    expect(call).toMatchObject({ requestKey: task!.requestId, receiptEpoch: 1, result: null });
  });

  it("refuses a Worker that is no longer selected or active", async () => {
    const f = await fixture();
    await db()
      .update(chats)
      .set({ workerSelection: { tools: ["edit"], directory: "/work" } })
      .where(eq(chats.id, f.chat));
    await expect(dispatchSealedChatTask(test.runtime, f.dispatch)).rejects.toMatchObject(denied);
    const g = await fixture();
    await call("owner").workers.revoke({ workspace: g.workspace, workerId: g.worker.workerId });
    await expect(dispatchSealedChatTask(test.runtime, g.dispatch)).rejects.toMatchObject(denied);
  });
});

function call(role: Role) {
  return appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });
}

describe("Worker procedures", () => {
  it("assigned, claim and completeSealed act on the Worker's own sealed tasks", async () => {
    const f = await fixture();
    const other = await fixture();
    const { taskId } = await dispatchSealedChatTask(test.runtime, f.dispatch);
    expect(await other.machine.worker.tasks.assigned({ status: "sent" })).toEqual([]);
    const [assigned] = await f.machine.worker.tasks.assigned({ status: "sent", operation: "bash" });
    expect(assigned).toMatchObject({
      id: taskId,
      status: "sent",
      revision: 0,
      sealed: {
        keyId: "worker-key",
        encapsulated: bytes(WORKER_TASK_ENCAPSULATED_BYTES, 1),
        request: bytes(4096, 2),
      },
    });
    expect(await f.machine.worker.tasks.assigned({ status: "sent", operation: "edit" })).toEqual([]);

    // Another Worker cannot claim or complete it.
    await expect(
      other.machine.worker.tasks.claim({ taskId, claimId: "intruder" }),
    ).rejects.toMatchObject(denied);
    await expect(f.machine.worker.tasks.claim({ taskId, claimId: "bad id!" })).rejects.toMatchObject(
      denied,
    );
    const claimed = await f.machine.worker.tasks.claim({ taskId, claimId: "process" });
    expect(claimed).toMatchObject({ status: "processing", revision: 1, attempt: 1 });
    // The same claim retries; another process gets nothing.
    expect(await f.machine.worker.tasks.claim({ taskId, claimId: "process" })).toMatchObject({
      revision: 1,
    });
    expect(await f.machine.worker.tasks.claim({ taskId, claimId: "other" })).toBeNull();

    const completion = {
      taskId,
      claimId: "process",
      expectedRevision: 1,
      ok: true,
      result: bytes(512, 1),
      receipt: bytes(2048, 2),
    };
    // The dispatch named a receipt epoch: a result needs its receipt.
    await expect(
      f.machine.worker.tasks.completeSealed({ ...completion, receipt: undefined }),
    ).rejects.toMatchObject(denied);
    await expect(
      f.machine.worker.tasks.completeSealed({ ...completion, claimId: "other" }),
    ).rejects.toMatchObject(denied);
    await expect(
      f.machine.worker.tasks.completeSealed({ ...completion, result: undefined, receipt: undefined }),
    ).rejects.toMatchObject(denied);
    await expect(
      f.machine.worker.tasks.completeSealed({ ...completion, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "WORKER_TASK_STALE_REVISION" });

    expect(await sealedChatTaskOutcome(db(), { chatId: f.chat, userId: users.owner.id, taskId })).toBeNull();
    expect(await f.machine.worker.tasks.completeSealed(completion)).toEqual({ completed: true });
    // An identical repeat is idempotent; different bytes are stale.
    expect(await f.machine.worker.tasks.completeSealed(completion)).toEqual({ completed: true });
    await expect(
      f.machine.worker.tasks.completeSealed({ ...completion, result: bytes(512, 3) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const outcome = await sealedChatTaskOutcome(db(), {
      chatId: f.chat,
      userId: users.owner.id,
      taskId,
    });
    expect(outcome?.ok).toBe(true);
    expect(toBase64Url(outcome!.result!)).toBe(completion.result);
    await expect(
      sealedChatTaskOutcome(db(), { chatId: other.chat, userId: users.owner.id, taskId }),
    ).rejects.toMatchObject(denied);
    const [receipt] = await db()
      .select()
      .from(workerChatCalls)
      .where(eq(workerChatCalls.task, taskId));
    expect(toBase64Url(receipt!.sealedResult!)).toBe(completion.receipt);
    expect(receipt).toMatchObject({ completionClaimId: "process", completionRevision: 2, result: null });

    // Once the task is pruned nothing remains to accept the payload.
    await db().delete(workerTasks).where(eq(workerTasks.id, taskId));
    expect(await f.machine.worker.tasks.completeSealed(completion)).toEqual({
      receiptDiscarded: true,
    });
    expect(await sealedChatTaskOutcome(db(), { chatId: f.chat, userId: users.owner.id, taskId })).toBeNull();
  });

  it("a Worker that cannot open the request fails it without a result", async () => {
    const f = await fixture();
    const { taskId } = await dispatchSealedChatTask(test.runtime, { ...f.dispatch, receiptEpoch: undefined });
    await f.machine.worker.tasks.claim({ taskId, claimId: "process" });
    await expect(
      f.machine.worker.tasks.completeSealed({
        taskId,
        claimId: "process",
        expectedRevision: 1,
        ok: false,
        receipt: bytes(10, 1),
      }),
    ).rejects.toMatchObject(denied);
    expect(
      await f.machine.worker.tasks.completeSealed({
        taskId,
        claimId: "process",
        expectedRevision: 1,
        ok: false,
      }),
    ).toEqual({ completed: true });
    expect(
      await sealedChatTaskOutcome(db(), { chatId: f.chat, userId: users.owner.id, taskId }),
    ).toEqual({ ok: false, result: null });
  });

  it("an apply follows only a completed preview of the same call", async () => {
    const f = await fixture();
    const preview = { ...f.dispatch, tool: "edit" as const, stage: "preview" as const, toolCallId: "e" };
    const { taskId } = await dispatchSealedChatTask(test.runtime, preview);
    const apply = { ...preview, stage: "apply" as const };
    await expect(dispatchSealedChatTask(test.runtime, apply)).rejects.toMatchObject(denied);
    await f.machine.worker.tasks.claim({ taskId, claimId: "process" });
    await f.machine.worker.tasks.completeSealed({
      taskId,
      claimId: "process",
      expectedRevision: 1,
      ok: true,
      result: bytes(64, 1),
      receipt: bytes(64, 2),
    });
    expect((await dispatchSealedChatTask(test.runtime, apply)).replay).toBe(false);
  });
});

describe("live layer", () => {
  it("a new task rings its Worker's inbox, a replay does not; completion signals the chat", async () => {
    const f = await fixture();
    const { kv } = test.runtime.drivers;
    const { stream: inbox } = await f.machine.worker.inbox();
    const signals = await currentStream(kv, test.runtime.streams, `c/${f.chat}/signals`);
    const messagesOf = async (path: string, count: number) =>
      await eventually(async () => {
        const page = await test.runtime.streams.read(path, "-1");
        return page && page.messages.length >= count ? page.messages : null;
      });

    const { taskId } = await dispatchSealedChatTask(test.runtime, f.dispatch);
    expect(await messagesOf(inbox, 1)).toEqual([{ topic: "tasks" }]);
    await dispatchSealedChatTask(test.runtime, f.dispatch);
    await dispatchSealedChatTask(test.runtime, { ...f.dispatch, toolCallId: "call-2" });
    // Only the second new task rang again.
    expect(await messagesOf(inbox, 2)).toEqual([{ topic: "tasks" }, { topic: "tasks" }]);

    await f.machine.worker.tasks.claim({ taskId, claimId: "process" });
    expect((await test.runtime.streams.read(signals, "-1"))?.messages).toEqual([]);
    await f.machine.worker.tasks.completeSealed({
      taskId,
      claimId: "process",
      expectedRevision: 1,
      ok: true,
      result: bytes(64, 1),
      receipt: bytes(64, 2),
    });
    expect((await test.runtime.streams.read(signals, "-1"))?.messages).toEqual([
      { topic: TASK_SIGNAL, ids: [taskId] },
    ]);
  });

  it("revocation fails the Worker's open tasks and signals their chats", async () => {
    const f = await fixture();
    const signals = await currentStream(test.runtime.drivers.kv, test.runtime.streams, `c/${f.chat}/signals`);
    const { taskId } = await dispatchSealedChatTask(test.runtime, f.dispatch);
    await revokeWorker(test.runtime, f.workspace, f.worker.workerId);
    expect((await db().select().from(workerTasks).where(eq(workerTasks.id, taskId)))[0]?.status).toBe("failed");
    expect((await test.runtime.streams.read(signals, "-1"))?.messages).toEqual([
      { topic: TASK_SIGNAL, ids: [taskId] },
    ]);
  });
});

describe("invariants under concurrency", () => {
  it("dispatch dedupe: parallel dispatches of one call stage make one task", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => dispatchSealedChatTask(test.runtime, f.dispatch)),
    );
    const fulfilled = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(fulfilled).toHaveLength(6);
    expect(new Set(fulfilled.map((result) => result.taskId)).size).toBe(1);
    expect(fulfilled.filter((result) => !result.replay)).toHaveLength(1);
    expect(
      await db().select().from(workerTasks).where(eq(workerTasks.worker, f.worker.workerId)),
    ).toHaveLength(1);
    expect(
      await db().select().from(workerChatCalls).where(eq(workerChatCalls.chat, f.chat)),
    ).toHaveLength(1);
  });

  it("claim once: of parallel claims by different processes exactly one wins", async () => {
    const f = await fixture();
    const { taskId } = await dispatchSealedChatTask(test.runtime, f.dispatch);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        f.machine.worker.tasks.claim({ taskId, claimId: `process-${index}` }),
      ),
    );
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const [task] = await db().select().from(workerTasks).where(eq(workerTasks.id, taskId));
    expect(task).toMatchObject({
      status: "processing",
      revision: 1,
      attempt: 1,
      claimId: winners[0]!.claimId,
    });
  });

  it("fenced completion: of parallel different completions exactly one lands", async () => {
    const f = await fixture();
    const { taskId } = await dispatchSealedChatTask(test.runtime, f.dispatch);
    await f.machine.worker.tasks.claim({ taskId, claimId: "process" });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        f.machine.worker.tasks.completeSealed({
          taskId,
          claimId: "process",
          expectedRevision: 1,
          ok: true,
          result: bytes(64, index + 1),
          receipt: bytes(64, index + 1),
        }),
      ),
    );
    const landed = results.filter((result) => result.status === "fulfilled");
    expect(landed).toHaveLength(1);
    const [task] = await db().select().from(workerTasks).where(eq(workerTasks.id, taskId));
    expect(task).toMatchObject({ status: "success", revision: 2 });
    const [receipt] = await db()
      .select()
      .from(workerChatCalls)
      .where(eq(workerChatCalls.task, taskId));
    // The receipt is the one that matches the stored result.
    expect(receipt!.sealedResult).toEqual(task!.sealedResult);
  });
});

describe("revocation", () => {
  it("fails the revoked Worker's open tasks; its token can no longer complete them", async () => {
    const f = await fixture();
    const { taskId } = await dispatchSealedChatTask(test.runtime, f.dispatch);
    await f.machine.worker.tasks.claim({ taskId, claimId: "process" });
    await call("owner").workers.revoke({ workspace: f.workspace, workerId: f.worker.workerId });
    expect(
      await sealedChatTaskOutcome(db(), { chatId: f.chat, userId: users.owner.id, taskId }),
    ).toEqual({ ok: false, result: null });
    await expect(
      f.machine.worker.tasks.completeSealed({
        taskId,
        claimId: "process",
        expectedRevision: 1,
        ok: true,
        result: bytes(64, 1),
        receipt: bytes(64, 1),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
