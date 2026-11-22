import { expect, test, vi } from "vitest";
import { generateText, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  buildAad,
  generateEncryptionKeyPair,
  openRequestRecipient,
  sealSym,
  unpad,
  utf8,
} from "radium-crypto";
import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { buildWorkerChatTools, workerChatApprovalSecret } from "./chat-tools";
import { workerChatTaskRequestId, workerTaskAad } from "contracts/worker/task-contract";

const scope = {
  chatId: "chat-test" as Id<"aisdk_chats">,
  workspaceId: "workspace-test" as Id<"workspaces">,
  userId: "owner",
  selection: {
    workerId: "worker-test",
    directory: "/project",
    tools: ["read", "edit", "create"] as ("read" | "edit" | "create")[],
  },
  transport: { kind: "plaintext" as const },
  approvals: new Map(),
};
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
function fixture(outputs: unknown[]) {
  const runMutation = vi.fn().mockResolvedValue({ taskId: "task-test" });
  const runQuery = vi.fn();
  for (const output of outputs)
    runQuery.mockResolvedValueOnce({ ok: true, output: JSON.stringify(output) });
  const ctx = { runMutation, runQuery } as unknown as ActionCtx;
  return { ctx, runMutation, runQuery, ...buildWorkerChatTools(ctx, scope) };
}
function finalModel() {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "Done." }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    },
  });
}

test("the model receives only enabled Worker tools and read executes through the task bridge", async () => {
  const f = fixture([{ ok: true, action: "read", content: "snapshot" }]);
  const { tools } = buildWorkerChatTools(f.ctx, {
    ...scope,
    selection: { ...scope.selection, tools: ["read"] },
  });
  expect(Object.keys(tools)).toEqual(["worker_read"]);
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "read-1",
          toolName: "worker_read",
          input: '{"path":"file.txt"}',
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    },
  });
  const result = await generateText({ model, tools, prompt: "Read file.txt" });
  expect(model.doGenerateCalls[0]!.tools).toEqual([
    expect.objectContaining({ name: "worker_read" }),
  ]);
  expect(f.runMutation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      chatId: scope.chatId,
      userId: "owner",
      workerId: "worker-test",
      directory: "/project",
      tool: "read",
      stage: "read",
    }),
  );
  expect(result.toolResults[0]!.output).toMatchObject({ ok: true, content: "snapshot" });
});

test("Create pauses for signed approval, then stages and applies the exact preview", async () => {
  const f = fixture([
    { ok: true, previewId: "preview-1" },
    { ok: true, action: "apply" },
  ]);
  const secret = await workerChatApprovalSecret("test-only-issuer-secret", scope);
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "create-1",
          toolName: "worker_create",
          input: JSON.stringify({ path: "new.txt", content: "hello\n*** End Patch" }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    },
  });
  const first = await generateText({
    model,
    tools: f.tools,
    toolApproval: f.toolApproval,
    experimental_toolApprovalSecret: secret,
    prompt: "Create new.txt",
  });
  expect(f.runMutation).not.toHaveBeenCalled();
  const approval = first.content.find((part) => part.type === "tool-approval-request");
  expect(approval).toBeDefined();
  if (!approval) throw new Error("Missing approval");
  expect(approval.signature).toEqual(expect.any(String));

  const messages: ModelMessage[] = [
    { role: "user", content: "Create new.txt" },
    ...first.response.messages,
    {
      role: "tool",
      content: [
        { type: "tool-approval-response", approvalId: approval.approvalId, approved: true },
      ],
    },
  ];
  await generateText({
    model: finalModel(),
    tools: f.tools,
    toolApproval: f.toolApproval,
    experimental_toolApprovalSecret: secret,
    messages,
  });
  expect(f.runMutation).toHaveBeenCalledTimes(2);
  expect(f.runMutation.mock.calls[0]![1]).toMatchObject({
    tool: "create",
    stage: "preview",
    request: {
      action: {
        kind: "preview",
        patch: "*** Begin Patch\n*** Add File: new.txt\n+hello\n+*** End Patch\n*** End Patch",
      },
    },
  });
  expect(f.runMutation.mock.calls[1]![1]).toMatchObject({
    tool: "create",
    stage: "apply",
    request: { action: { kind: "apply", previewId: "preview-1" } },
  });

  const foreignScopeSecret = await workerChatApprovalSecret("test-only-issuer-secret", {
    ...scope,
    userId: "another-user",
  });
  await expect(
    generateText({
      model: finalModel(),
      tools: f.tools,
      toolApproval: f.toolApproval,
      experimental_toolApprovalSecret: foreignScopeSecret,
      messages,
    }),
  ).rejects.toThrow();
  expect(f.runMutation).toHaveBeenCalledTimes(2);
});

test("denying Edit approval never dispatches work", async () => {
  const f = fixture([]);
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "edit-1",
          toolName: "worker_edit",
          input: '{"patch":"test-patch"}',
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    },
  });
  const first = await generateText({
    model,
    tools: f.tools,
    toolApproval: f.toolApproval,
    prompt: "Edit file",
  });
  const approval = first.content.find((part) => part.type === "tool-approval-request");
  if (!approval) throw new Error("Missing approval");
  await generateText({
    model: finalModel(),
    tools: f.tools,
    toolApproval: f.toolApproval,
    messages: [
      { role: "user", content: "Edit file" },
      ...first.response.messages,
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: approval.approvalId, approved: false },
        ],
      },
    ],
  });
  expect(f.runMutation).not.toHaveBeenCalled();
});

test("a failed preview cannot advance to filesystem application", async () => {
  const f = fixture([{ ok: false, code: "EDIT_REJECTED" }]);
  const execute = f.tools.worker_edit!.execute!;
  const result = await execute({ patch: "invalid" }, {
    toolCallId: "bad-1",
    messages: [],
    toolContext: undefined,
  } as never);
  expect(result).toMatchObject({ ok: false, code: "EDIT_REJECTED" });
  expect(f.runMutation).toHaveBeenCalledTimes(1);
});

test("without a directory, tools report it and never dispatch; approval signatures change with assignment", async () => {
  const f = fixture([]);
  const unavailable = buildWorkerChatTools(f.ctx, {
    ...scope,
    selection: { ...scope.selection, directory: undefined },
  });
  expect(unavailable.toolApproval).toEqual({});
  await expect(
    unavailable.tools.worker_read!.execute!(
      { path: "a.ts" },
      {
        toolCallId: "call",
        messages: [],
      },
    ),
  ).resolves.toMatchObject({ ok: false, code: "WORKER_DIRECTORY_UNAVAILABLE" });
  expect(f.runMutation).not.toHaveBeenCalled();
  const first = await workerChatApprovalSecret("test-only-issuer-secret", scope);
  const changed = await workerChatApprovalSecret("test-only-issuer-secret", {
    ...scope,
    selection: { ...scope.selection, directory: "/other" },
  });
  expect(first).not.toEqual(changed);
});

test("a disconnected Worker times out with an unknown outcome and never retries or applies", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture([]);
    f.runQuery.mockResolvedValue(null);
    const result = f.tools.worker_create!.execute!({ path: "new.txt", content: "hello" }, {
      toolCallId: "timeout-1",
      messages: [],
      toolContext: undefined,
    } as never);
    await vi.waitFor(() => expect(f.runQuery).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await result).toMatchObject({
      ok: false,
      code: "WORKER_OUTCOME_UNKNOWN",
      taskId: "task-test",
    });
    expect(f.runMutation).toHaveBeenCalledTimes(1);
    expect(f.runMutation.mock.calls[0]![1].stage).toBe("preview");
  } finally {
    vi.useRealTimers();
  }
});

test("Bash requires signed approval of the exact command and dispatches one foreground stage", async () => {
  const f = fixture([{ ok: true, exitCode: 0, output: "done", truncated: false }]);
  const enabledScope = { ...scope, selection: { ...scope.selection, tools: ["bash"] as "bash"[] } };
  const { tools, toolApproval } = buildWorkerChatTools(f.ctx, enabledScope);
  expect(Object.keys(tools)).toEqual(["worker_bash"]);
  const secret = await workerChatApprovalSecret("test-only-issuer-secret", enabledScope);
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
  expect(f.runMutation).not.toHaveBeenCalled();
  const approval = first.content.find((part) => part.type === "tool-approval-request");
  if (!approval) throw new Error("Missing Bash approval");
  const messages: ModelMessage[] = [
    { role: "user", content: "Run command" },
    ...first.response.messages,
    {
      role: "tool",
      content: [
        { type: "tool-approval-response", approvalId: approval.approvalId, approved: false },
      ],
    },
  ];
  await generateText({
    model: finalModel(),
    tools,
    toolApproval,
    experimental_toolApprovalSecret: secret,
    messages,
  });
  expect(f.runMutation).not.toHaveBeenCalled();
  messages[messages.length - 1] = {
    role: "tool",
    content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: true }],
  };
  const tampered = structuredClone(messages);
  for (const message of tampered) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") part.input = { command: "printf tampered", timeout: 5 };
    }
  }
  await expect(
    generateText({
      model: finalModel(),
      tools,
      toolApproval,
      experimental_toolApprovalSecret: secret,
      messages: tampered,
    }),
  ).rejects.toThrow();
  expect(f.runMutation).not.toHaveBeenCalled();
  await expect(
    generateText({
      model: finalModel(),
      tools,
      toolApproval,
      experimental_toolApprovalSecret: await workerChatApprovalSecret(
        "different-issuer",
        enabledScope,
      ),
      messages,
    }),
  ).rejects.toThrow();
  expect(f.runMutation).not.toHaveBeenCalled();
  await generateText({
    model: finalModel(),
    tools,
    toolApproval,
    experimental_toolApprovalSecret: secret,
    messages,
  });
  expect(f.runMutation).toHaveBeenCalledTimes(1);
  expect(f.runMutation.mock.calls[0]![1]).toMatchObject({
    tool: "bash",
    stage: "execute",
    request: { command: "printf done", timeoutSeconds: 5, directory: "/project" },
  });
});

/** A paired-Worker scope whose tasks the test opens and answers like the Worker would. */
async function sealedFixture(tools: ("read" | "edit" | "bash")[], grant?: boolean) {
  const worker = await generateEncryptionKeyPair();
  const dispatched: Record<string, unknown>[] = [];
  let answer: (request: Record<string, unknown>) => unknown = () => ({ ok: true, output: "{}" });
  let responseKey: Uint8Array | undefined;
  const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
    const sealed = args.sealed as { encapsulated: ArrayBuffer; request: ArrayBuffer };
    const recipient = await openRequestRecipient(worker.seed, new Uint8Array(sealed.encapsulated));
    responseKey = recipient.responseKey;
    const requestId = await workerChatTaskRequestId(
      args.chatId as string,
      args.toolCallId as string,
      args.stage as "read",
    );
    const aad = { workspaceId: scope.workspaceId, chatId: scope.chatId, requestId };
    const plaintext = unpad(
      await recipient.open(
        new Uint8Array(sealed.request),
        buildAad(workerTaskAad({ ...aad, field: "request" })),
      ),
    );
    dispatched.push({ ...args, aad, opened: JSON.parse(new TextDecoder().decode(plaintext)) });
    return { taskId: requestId, replay: false };
  });
  const runQuery = vi.fn(async () => {
    const { aad, opened } = dispatched.at(-1) as {
      aad: { workspaceId: string; chatId: string; requestId: string };
      opened: Record<string, unknown>;
    };
    const result = await sealSym({
      key: responseKey!,
      keyRef: new Uint8Array(16),
      plaintext: utf8(JSON.stringify(answer(opened))),
      aad: workerTaskAad({ ...aad, field: "result" }),
    });
    return { ok: true, result: result.slice().buffer };
  });
  const ctx = { runMutation, runQuery } as unknown as ActionCtx;
  const approvals = new Map();
  const built = buildWorkerChatTools(ctx, {
    ...scope,
    selection: {
      ...scope.selection,
      tools,
      ...(grant
        ? {
            grant: {
              tools: ["read" as const],
              issuedAt: 5,
              signature: new Uint8Array(64).fill(1).buffer,
              signerKeyId: "owner-key",
            },
          }
        : {}),
    },
    transport: {
      kind: "sealed",
      keyId: "worker-key",
      encryptionPublicKey: worker.publicKey,
    },
    approvals,
  });
  return {
    ...built,
    approvals,
    dispatched,
    runMutation,
    setAnswer: (next: typeof answer) => (answer = next),
  };
}

const callOptions = (toolCallId: string) => ({ toolCallId, messages: [] }) as never;

test("a paired Worker gets only sealed requests and the action opens the request-key result", async () => {
  const f = await sealedFixture(["read"], true);
  f.setAnswer((request) => {
    expect(request).toMatchObject({
      tool: "read",
      stage: "read",
      directory: "/project",
      input: JSON.stringify({ path: "secret.txt" }),
      authorization: { kind: "grant", tools: ["read"], issuedAt: 5, signerKeyId: "owner-key" },
    });
    return { ok: true, output: JSON.stringify({ ok: true, content: "sealed content" }) };
  });
  const output = await f.tools.worker_read!.execute!({ path: "secret.txt" }, callOptions("r-1"));
  expect(output).toEqual({ ok: true, content: "sealed content" });

  // Only ciphertext and routing metadata reach the backend.
  const stored = JSON.stringify(
    f.dispatched.map(({ opened: _opened, sealed: _sealed, ...metadata }) => metadata),
  );
  expect(stored).not.toContain("secret.txt");
  const sealed = f.dispatched[0]!.sealed as { request: ArrayBuffer; keyId: string };
  expect(sealed.keyId).toBe("worker-key");
  expect(new TextDecoder().decode(sealed.request)).not.toContain("secret.txt");
});

test("Read without a grant and an approved write without a signature are not dispatched", async () => {
  const read = await sealedFixture(["read"]);
  expect(
    await read.tools.worker_read!.execute!({ path: "file.txt" }, callOptions("r-1")),
  ).toMatchObject({ ok: false, code: "WORKER_GRANT_MISSING" });

  const bash = await sealedFixture(["bash"]);
  const input = { command: "rm -rf build", timeout: 5 };
  expect(await bash.tools.worker_bash!.execute!(input, callOptions("b-1"))).toMatchObject({
    ok: false,
    code: "WORKER_APPROVAL_UNSIGNED",
  });
  // A signature over a different command is not forwarded for this call.
  bash.approvals.set("b-1", {
    signature: "A".repeat(86),
    signerKeyId: "owner-key",
    input: JSON.stringify({ command: "ls", timeout: 5 }),
    approvedAt: 1,
  });
  expect(await bash.tools.worker_bash!.execute!(input, callOptions("b-1"))).toMatchObject({
    ok: false,
    code: "WORKER_APPROVAL_UNSIGNED",
  });
  expect(read.runMutation).not.toHaveBeenCalled();
  expect(bash.runMutation).not.toHaveBeenCalled();

  bash.approvals.set("b-1", {
    signature: "A".repeat(86),
    signerKeyId: "owner-key",
    input: JSON.stringify({ timeout: 5, command: "rm -rf build" }),
    approvedAt: 1,
  });
  bash.setAnswer((request) => {
    expect(request.authorization).toMatchObject({
      kind: "approval",
      input: JSON.stringify({ timeout: 5, command: "rm -rf build" }),
      approvedAt: 1,
    });
    return { ok: true, output: JSON.stringify({ ok: true, exitCode: 0 }) };
  });
  expect(await bash.tools.worker_bash!.execute!(input, callOptions("b-1"))).toEqual({
    ok: true,
    exitCode: 0,
  });
});
