import { eq } from "drizzle-orm";
import { generateText, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  buildAad,
  chatKeyBindingStatement,
  chatKeyStatement,
  fingerprint,
  fromBase64Url,
  generateEncryptionKeyPair,
  openRequestRecipient,
  randomBytes,
  sealSym,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  unpad,
  utf8,
  type EncryptionKeyPair,
} from "radium-crypto";
import type { ChatWorkerTool } from "contracts/worker/chat-config";
import type { WorkerApprovalSignature } from "contracts/worker/chat-tools";
import { workerTaskAad, type WorkerSealedTaskRequest } from "contracts/worker/task-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addModel, addProvider, offer, upstreamStream } from "../../test/gateway";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { eventually, readToEnd } from "../../test/streams";
import { classicUser } from "../../test/users";
import { insertWorker, machineCaller, workerIssuerEnv } from "../../test/workers";
import { chatMembers, chatRuns, chats } from "../chatroom/schema";
import { e2eeChatKeys, e2eeIdentities, e2eeRosters, e2eeWorkerKeys } from "../e2ee/schema";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { chatWorkerSelection } from "./chat-selection";
import {
  buildWorkerChatTools,
  resolveWorkerChatTransport,
  workerChatApprovalSecret,
  type WorkerChatScope,
} from "./chat-tools";
import { workerTasks } from "./schema";

// Worker chat tools (Convex `src/worker/chat-tools.test.ts`, paired path) against the real task
// services, a simulated Worker on its machine procedures, and `/api/chat`: sealed dispatch, the
// signal-driven wait, authorization (grant, approval signatures, the SDK replay guard), owner-only
// and personal-chat boundaries, blocked transports, and stop.

type Role = "owner" | "member";
const MODEL = "worker-model";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
const db = () => test.runtime.drivers.db;
const ownerSeed = new Uint8Array(32).fill(1);
const ownerKeyId = toBase64Url(new Uint8Array(16).fill(1));
const chatKeyId = toBase64Url(new Uint8Array(16).fill(200));
let chatKey: EncryptionKeyPair;
let workerKey: EncryptionKeyPair;
const denied = { code: "FORBIDDEN", message: "WORKER_TASK_DENIED" };

beforeAll(async () => {
  test = await createTestRuntime({ env: (await workerIssuerEnv()).env });
  [chatKey, workerKey] = await Promise.all([generateEncryptionKeyPair(), generateEncryptionKeyPair()]);
  for (const role of ["owner", "member"] as const) {
    users[role] = await classicUser(test.runtime, `chat-tools-${role}@example.test`);
  }
  await db()
    .insert(e2eeIdentities)
    .values({
      userId: users.owner.id,
      keyId: ownerKeyId,
      suite: 1,
      encryptionPublicKey: chatKey.publicKey,
      signingPublicKey: await signingPublicKeyFromSeed(ownerSeed),
      secrets: new Uint8Array(1),
      selfSignature: new Uint8Array(64),
      recoveryWrapper: new Uint8Array(1),
      status: "active",
    });
  await addModel(test.runtime, MODEL);
});

afterAll(async () => {
  await test?.close();
});

let e2eeIds = 0;

type Fixture = {
  workspace: string;
  workerId: string;
  chat: string;
  e2eeId: string;
  machine: Awaited<ReturnType<typeof machineCaller>>;
};

/**
 * A keyed workspace whose newest roster certifies a Worker (unless `certified: false`), and an
 * owner chat selecting that Worker in `/work` with `tools` (Read granted with `grant`), keyed
 * with an owner-signed epoch bound to its audience. `shared` adds the member to the chat.
 */
async function fixture(
  options: { tools: ChatWorkerTool[]; grant?: boolean; certified?: boolean; scope?: "personal" | "shared" },
): Promise<Fixture> {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Worker tools", keyEpoch: 1 })
    .returning();
  const workspace = row!.id;
  await db().insert(workspaceMembers).values({ workspace, userId: users.member.id, role: "member" });
  await addProvider(test.runtime, workspace, { slug: "upstream", models: [offer(MODEL)] });
  const worker = await insertWorker(test.runtime, workspace);
  const keys = { encryptionPublicKey: workerKey.publicKey, signingPublicKey: randomBytes(32) };
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
            workers: [{ workerId: worker.workerId, keyId: "worker-key", fingerprint: await fingerprint(keys) }],
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
      workerSelection: {
        tools: options.tools,
        directory: "/work",
        ...(options.grant
          ? {
              grant: {
                tools: ["read" as const],
                issuedAt: 5,
                signature: toBase64Url(new Uint8Array(64).fill(1)),
                signerKeyId: ownerKeyId,
              },
            }
          : {}),
      },
    })
    .returning();
  const members = scope === "shared" ? [users.member.id] : [];
  if (scope === "shared") {
    await db()
      .insert(chatMembers)
      .values({ chat: chat!.id, workspace, userId: users.member.id, lastInteractionAt: new Date() });
  }
  const key = { epoch: 1, keyId: chatKeyId, suite: 1, publicKey: chatKey.publicKey };
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
        chatKeyBindingStatement({ ...statement, chatId: chat!.id, scope, creatorId: users.owner.id, members }),
      ),
      ...(scope === "shared" ? { bindingMembers: members } : {}),
    });
  return {
    workspace,
    workerId: worker.workerId,
    chat: chat!.id,
    e2eeId,
    machine: await machineCaller(test.runtime, worker),
  };
}

/** The owner's Worker tools for `f`'s chat, as `/api/chat` builds them. */
async function ownerTools(f: Fixture, approvals = new Map<string, WorkerApprovalSignature>()) {
  const [chat] = await db().select().from(chats).where(eq(chats.id, f.chat));
  const scope: WorkerChatScope = {
    chatId: f.chat,
    workspaceId: f.workspace,
    userId: users.owner.id,
    selection: { ...chatWorkerSelection(chat!)!, workerId: f.workerId },
    transport: await resolveWorkerChatTransport(db(), {
      chatId: f.chat,
      userId: users.owner.id,
      workerId: f.workerId,
    }),
    approvals,
  };
  return { scope, ...buildWorkerChatTools(test.runtime, scope) };
}

type WorkerReply = { ok: true; output: unknown } | { ok: false; code: string } | "refuse";

/**
 * Answers the Worker's next sent task like the Worker does: claims it, opens the sealed request
 * with the Worker's key, and completes it with `answer`'s reply sealed under the request key (and
 * a receipt, since every call names the chat key epoch). `refuse` completes it without a result.
 * Resolves with the opened request and the moment the completion committed.
 */
async function answerNext(f: Fixture, answer: (request: WorkerSealedTaskRequest) => WorkerReply) {
  const [task] = await eventually(async () => {
    const sent = await f.machine.worker.tasks.assigned({ status: "sent" });
    return sent.length > 0 ? sent : null;
  });
  const claimed = await f.machine.worker.tasks.claim({ taskId: task!.id, claimId: "process" });
  const recipient = await openRequestRecipient(workerKey.seed, fromBase64Url(task!.sealed.encapsulated));
  const aad = { workspaceId: f.workspace, chatId: f.chat, requestId: task!.requestId };
  const opened = await recipient.open(
    fromBase64Url(task!.sealed.request),
    buildAad(workerTaskAad({ ...aad, field: "request" })),
  );
  const request = JSON.parse(new TextDecoder().decode(unpad(opened))) as WorkerSealedTaskRequest;
  const reply = answer(request);
  const completion = { taskId: task!.id, claimId: "process", expectedRevision: claimed!.revision };
  if (reply === "refuse") {
    await f.machine.worker.tasks.completeSealed({ ...completion, ok: false });
  } else {
    const result = await sealSym({
      key: recipient.responseKey,
      keyRef: new Uint8Array(16),
      plaintext: utf8(JSON.stringify(reply.ok ? { ok: true, output: JSON.stringify(reply.output) } : reply)),
      aad: workerTaskAad({ ...aad, field: "result" }),
    });
    await f.machine.worker.tasks.completeSealed({
      ...completion,
      ok: true,
      result: toBase64Url(result),
      receipt: toBase64Url(randomBytes(64)),
    });
  }
  return { request, task: task!, completedAt: Date.now() };
}

async function tasksOf(f: Fixture) {
  return await db().select().from(workerTasks).where(eq(workerTasks.worker, f.workerId));
}

const callOptions = (toolCallId: string, abortSignal?: AbortSignal) =>
  ({ toolCallId, messages: [], abortSignal }) as never;

const approval = (input: unknown): WorkerApprovalSignature => ({
  signature: "A".repeat(86),
  signerKeyId: ownerKeyId,
  input: JSON.stringify(input),
  approvedAt: 1,
});

describe("sealed dispatch", () => {
  it("seals Read to the paired Worker and resolves on the completion signal, not a poll", async () => {
    const f = await fixture({ tools: ["read"], grant: true });
    const { tools, toolApproval } = await ownerTools(f);
    expect(Object.keys(tools)).toEqual(["worker_read"]);
    expect(toolApproval).toEqual({});

    const pending = tools.worker_read!.execute!({ path: "secret.txt" }, callOptions("r-1"));
    const answered = await answerNext(f, () => ({ ok: true, output: { ok: true, content: "sealed content" } }));
    const output = await pending;
    // The long-poll wakes on the signal right away; without it the tool would wait 45 s.
    expect(Date.now() - answered.completedAt).toBeLessThan(2_000);
    expect(output).toEqual({ ok: true, content: "sealed content" });
    expect(answered.request).toMatchObject({
      workspaceId: f.workspace,
      chatId: f.chat,
      workerId: f.workerId,
      directory: "/work",
      tool: "read",
      stage: "read",
      toolCallId: "r-1",
      input: JSON.stringify({ path: "secret.txt" }),
      authorization: { kind: "grant", tools: ["read"], issuedAt: 5, signerKeyId: ownerKeyId },
      receipt: { e2eeId: f.e2eeId, epoch: 1, keyId: chatKeyId, scope: "personal", members: [] },
    });

    // Only ciphertext and routing metadata reach the backend.
    const [task] = await tasksOf(f);
    expect(task).toMatchObject({ sealedKeyId: "worker-key", status: "success", editRequest: null });
    expect(new TextDecoder().decode(task!.sealedRequest!)).not.toContain("secret.txt");
    expect(new TextDecoder().decode(task!.sealedResult!)).not.toContain("sealed content");

    // The same call stage again is never re-dispatched: its key is gone.
    expect(await tools.worker_read!.execute!({ path: "secret.txt" }, callOptions("r-1"))).toMatchObject({
      ok: false,
      code: "WORKER_ALREADY_EXECUTED",
    });
    expect(await tasksOf(f)).toHaveLength(1);
  });

  it("refuses Read without a grant and approved calls without a matching signature, without dispatch", async () => {
    const read = await fixture({ tools: ["read"] });
    expect(
      await (await ownerTools(read)).tools.worker_read!.execute!({ path: "a.txt" }, callOptions("r-1")),
    ).toMatchObject({ ok: false, code: "WORKER_GRANT_MISSING" });
    expect(await tasksOf(read)).toEqual([]);

    const f = await fixture({ tools: ["bash"] });
    const approvals = new Map<string, WorkerApprovalSignature>();
    const { tools } = await ownerTools(f, approvals);
    const input = { command: "rm -rf build", timeout: 5 };
    expect(await tools.worker_bash!.execute!(input, callOptions("b-1"))).toMatchObject({
      ok: false,
      code: "WORKER_APPROVAL_UNSIGNED",
    });
    // A signature over another command is not forwarded for this call.
    approvals.set("b-1", approval({ command: "ls", timeout: 5 }));
    expect(await tools.worker_bash!.execute!(input, callOptions("b-1"))).toMatchObject({
      code: "WORKER_APPROVAL_UNSIGNED",
    });
    expect(await tasksOf(f)).toEqual([]);

    // The same operation in another key order is the signed one; the Worker gets the signed text.
    approvals.set("b-1", approval({ timeout: 5, command: "rm -rf build" }));
    const pending = tools.worker_bash!.execute!(input, callOptions("b-1"));
    const { request } = await answerNext(f, () => ({ ok: true, output: { ok: true, exitCode: 0 } }));
    expect(await pending).toEqual({ ok: true, exitCode: 0 });
    expect(request).toMatchObject({
      tool: "bash",
      stage: "execute",
      authorization: { kind: "approval", input: JSON.stringify({ timeout: 5, command: "rm -rf build" }) },
    });
    expect(request).not.toHaveProperty("input");
  });

  it("stages and applies an approved Create; a failed preview never applies", async () => {
    const f = await fixture({ tools: ["create", "edit"] });
    const input = { path: "new.txt", content: "hello" };
    const { tools } = await ownerTools(f, new Map([["c-1", approval(input)], ["e-1", approval({ patch: "bad" })]]));

    const created = tools.worker_create!.execute!(input, callOptions("c-1"));
    const preview = await answerNext(f, () => ({ ok: true, output: { ok: true, previewId: "preview-1" } }));
    const apply = await answerNext(f, () => ({ ok: true, output: { ok: true, action: "apply" } }));
    expect(await created).toEqual({ ok: true, action: "apply" });
    expect([preview.request.stage, apply.request.stage]).toEqual(["preview", "apply"]);

    const edited = tools.worker_edit!.execute!({ patch: "bad" }, callOptions("e-1"));
    await answerNext(f, () => ({ ok: false, code: "EDIT_REJECTED" }));
    expect(await edited).toMatchObject({ ok: false, code: "EDIT_REJECTED" });
    expect(await tasksOf(f)).toHaveLength(3);
  });

  it("reports a request the Worker could not open", async () => {
    const f = await fixture({ tools: ["read"], grant: true });
    const { tools } = await ownerTools(f);
    const pending = tools.worker_read!.execute!({ path: "a.txt" }, callOptions("r-1"));
    await answerNext(f, () => "refuse");
    expect(await pending).toMatchObject({ ok: false, code: "WORKER_REQUEST_REFUSED" });
  });

  it("a stop ends the wait with an unknown outcome and never retries", async () => {
    const f = await fixture({ tools: ["bash"] });
    const input = { command: "sleep 100", timeout: 5 };
    const { tools } = await ownerTools(f, new Map([["b-1", approval(input)]]));
    const stop = new AbortController();
    const pending = tools.worker_bash!.execute!(input, callOptions("b-1", stop.signal));
    const [task] = await eventually(async () => {
      const sent = await tasksOf(f);
      return sent.length > 0 ? sent : null;
    });
    const stoppedAt = Date.now();
    stop.abort();
    expect(await pending).toMatchObject({ ok: false, code: "WORKER_OUTCOME_UNKNOWN", taskId: task!.id });
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    expect(await tasksOf(f)).toHaveLength(1);
  });
});

describe("authorization", () => {
  it("binds SDK approvals to the owner, chat, Worker, directory and tools; an unsigned approval is not dispatched", async () => {
    const f = await fixture({ tools: ["bash"] });
    const { scope, tools, toolApproval } = await ownerTools(f);
    expect(toolApproval).toEqual({ worker_bash: "user-approval" });
    const secret = await workerChatApprovalSecret("test-secret", scope);
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    };
    /** Continues `messages` with a model that answers in text; returns that model. */
    const run = async (messages: ModelMessage[], approvalSecret = secret) => {
      const model = new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: "text", text: "Done." }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      });
      await generateText({ model, tools, toolApproval, experimental_toolApprovalSecret: approvalSecret, messages });
      return model;
    };

    const first = await generateText({
      model: new MockLanguageModelV4({
        doGenerate: {
          content: [
            {
              type: "tool-call",
              toolCallId: "bash-1",
              toolName: "worker_bash",
              input: '{"command":"printf done","timeout":5}',
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
      }),
      tools,
      toolApproval,
      experimental_toolApprovalSecret: secret,
      prompt: "Run command",
    });
    const request = first.content.find((part) => part.type === "tool-approval-request");
    if (!request) throw new Error("Missing approval request");
    const messages: ModelMessage[] = [
      { role: "user", content: "Run command" },
      ...first.response.messages,
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: true }],
      },
    ];

    // A tampered call, or an approval replayed under another owner, chat or directory, is rejected.
    const tampered = structuredClone(messages);
    for (const message of tampered) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === "tool-call") part.input = { command: "printf tampered", timeout: 5 };
      }
    }
    await expect(run(tampered)).rejects.toThrow();
    for (const other of [
      { ...scope, userId: users.member.id },
      { ...scope, chatId: "another-chat" },
      { ...scope, selection: { ...scope.selection, directory: "/other" } },
    ]) {
      await expect(run(messages, await workerChatApprovalSecret("test-secret", other))).rejects.toThrow();
    }
    await expect(run(messages, await workerChatApprovalSecret("other-secret", scope))).rejects.toThrow();

    // Approved in the SDK but without the user's signature: the Worker never sees it, and the
    // model is told why.
    const approved = await run(messages);
    expect(JSON.stringify(approved.doGenerateCalls[0]!.prompt)).toContain("WORKER_APPROVAL_UNSIGNED");
    expect(await tasksOf(f)).toEqual([]);
  });

  it("is the workspace owner's in a chat they can see", async () => {
    const f = await fixture({ tools: ["bash"], scope: "shared" });
    await expect(
      resolveWorkerChatTransport(db(), { chatId: f.chat, userId: users.member.id, workerId: f.workerId }),
    ).rejects.toMatchObject(denied);
  });
});

describe("blocked transports", () => {
  it("expose the tools with a fixed failure, no approval prompt and no dispatch", async () => {
    const unpaired = await fixture({ tools: ["read", "bash"], grant: true, certified: false });
    const rekeyed = await fixture({ tools: ["read", "bash"], grant: true });
    await db().update(chats).set({ rekey: true }).where(eq(chats.id, rekeyed.chat));
    const undirected = await fixture({ tools: ["read", "bash"], grant: true });
    await db()
      .update(chats)
      .set({ workerSelection: { tools: ["read", "bash"] } })
      .where(eq(chats.id, undirected.chat));

    for (const [f, code] of [
      [unpaired, "WORKER_NOT_PAIRED"],
      [rekeyed, "CHAT_KEY_UNAVAILABLE"],
      [undirected, "WORKER_DIRECTORY_UNAVAILABLE"],
    ] as const) {
      const { tools, toolApproval } = await ownerTools(f, new Map([["b-1", approval({ command: "ls" })]]));
      expect(toolApproval).toEqual({});
      expect(await tools.worker_read!.execute!({ path: "a.txt" }, callOptions("r-1"))).toMatchObject({
        ok: false,
        code,
      });
      expect(await tools.worker_bash!.execute!({ command: "ls" }, callOptions("b-1"))).toMatchObject({
        ok: false,
        code,
      });
      expect(await tasksOf(f)).toEqual([]);
    }
  });
});

/** An upstream reply whose one step calls `name` with `input`. */
function upstreamToolCall(name: string, input: unknown) {
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
    `data: ${JSON.stringify({
      id: "upstream-generation",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;
  const body = [
    chunk({
      role: "assistant",
      tool_calls: [
        { index: 0, id: "call-1", type: "function", function: { name, arguments: JSON.stringify(input) } },
      ],
    }),
    chunk({}, "tool_calls", { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * Stubs the model: it calls `worker_read` when offered and no tool result is in the history yet,
 * then answers in text. Records the tool names of every model request.
 */
function stubModel() {
  const offered: string[][] = [];
  test.runtime.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      tools?: Array<{ function: { name: string } }>;
      messages: Array<{ role: string }>;
    };
    const names = (body.tools ?? []).map((entry) => entry.function.name);
    offered.push(names);
    if (names.includes("worker_read") && !body.messages.some((message) => message.role === "tool")) {
      return upstreamToolCall("worker_read", { path: "notes.txt" });
    }
    return upstreamStream(["Read it."]);
  }) as unknown as typeof fetch;
  return offered;
}

async function send(role: Role, f: Fixture) {
  const headers = new Headers(users[role].headers);
  headers.set("content-type", "application/json");
  return await test.app.request("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({
      chatId: f.chat,
      model: MODEL,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Read notes.txt" }] }],
      recipientKey: { e2eeId: f.e2eeId, epoch: 1, publicKey: toBase64Url(chatKey.publicKey) },
    }),
  });
}

async function runOf(chat: string) {
  const [run] = await db().select().from(chatRuns).where(eq(chatRuns.chat, chat));
  return run;
}

describe("/api/chat", () => {
  it("runs a Worker read the model calls and streams its result to the chat", async () => {
    const offered = stubModel();
    const f = await fixture({ tools: ["read"], grant: true });
    const response = await send("owner", f);
    expect(response.status).toBe(201);
    const path = ((await response.json()) as { streamUrl: string }).streamUrl.slice("/api/streams/".length);
    const { request } = await answerNext(f, () => ({ ok: true, output: { ok: true, content: "notes" } }));
    expect(request).toMatchObject({ tool: "read", input: JSON.stringify({ path: "notes.txt" }) });

    const chunks = await readToEnd(test.app, users.owner.headers, path);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "tool-output-available", output: { ok: true, content: "notes" } }),
    );
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
    // Title generation runs concurrently without tools, so the order of requests is not fixed.
    expect(offered.some((names) => names.includes("worker_read"))).toBe(true);
    await eventually(async () => (await runOf(f.chat))?.status === "finished");
  });

  it("stops a run waiting on its Worker", async () => {
    stubModel();
    const f = await fixture({ tools: ["read"], grant: true });
    expect((await send("owner", f)).status).toBe(201);
    await eventually(async () => (await tasksOf(f)).length > 0);
    const stoppedAt = Date.now();
    expect(await appRouter.createCaller({ runtime: test.runtime, headers: users.owner.headers }).chats.stop({ chatId: f.chat })).toBe(true);
    await eventually(async () => (await runOf(f.chat))?.status !== "active");
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    // The task stays for the Worker; the stop is never a retry.
    expect(await tasksOf(f)).toHaveLength(1);
  });

  it("offers Worker tools to the workspace owner only; a personal chat stays private", async () => {
    const offered = stubModel();
    const shared = await fixture({ tools: ["bash"], scope: "shared" });
    expect((await send("member", shared)).status).toBe(201);
    await eventually(async () => (await runOf(shared.chat))?.status === "finished");
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.flat().some((name) => name.startsWith("worker_"))).toBe(false);

    offered.length = 0;
    const personal = await fixture({ tools: ["bash"] });
    expect((await send("member", personal)).status).toBe(404);
    expect(offered).toEqual([]);
  });

  it("refuses a request whose selected Worker was revoked, and malformed approvals", async () => {
    const offered = stubModel();
    const f = await fixture({ tools: ["bash"] });
    await appRouter
      .createCaller({ runtime: test.runtime, headers: users.owner.headers })
      .workers.revoke({ workspace: f.workspace, workerId: f.workerId });
    const revoked = await send("owner", f);
    expect(revoked.status).toBe(400);
    expect(await revoked.json()).toMatchObject({ error: { message: expect.stringMatching(/Worker tools are unavailable/) } });

    const g = await fixture({ tools: ["bash"] });
    const headers = new Headers(users.owner.headers);
    headers.set("content-type", "application/json");
    const malformed = await test.app.request("/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({
        chatId: g.chat,
        model: MODEL,
        messages: [],
        approvals: { "b-1": { signature: "short", signerKeyId: ownerKeyId, input: "{}", approvedAt: 1 } },
        recipientKey: { e2eeId: g.e2eeId, epoch: 1, publicKey: toBase64Url(chatKey.publicKey) },
      }),
    });
    expect(malformed.status).toBe(400);
    expect(offered).toEqual([]);
  });
});
