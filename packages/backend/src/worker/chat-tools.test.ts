import { expect, test, vi } from "vitest";
import { generateText, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { buildWorkerChatTools, workerChatApprovalSecret } from "./chat-tools";

const scope = {
  chatId: "chat-test" as Id<"aisdk_chats">,
  workspaceId: "workspace-test" as Id<"workspaces">,
  userId: "owner",
  selection: {
    workerId: "worker-test",
    directory: "/project",
    tools: ["read", "edit", "create"] as ("read" | "edit" | "create")[],
  },
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

test("execution requires an absolute directory and approval signatures change with assignment", async () => {
  const f = fixture([]);
  expect(() =>
    buildWorkerChatTools(f.ctx, {
      ...scope,
      selection: { ...scope.selection, directory: undefined },
    }),
  ).toThrow("absolute Worker directory");
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
