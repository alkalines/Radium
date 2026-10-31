import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ActionCtx } from "../../convex/_generated/server";

const mocks = vi.hoisted(() => ({ streamText: vi.fn(), user: vi.fn() }));
vi.mock("../../convex/auth", () => ({
  authComponent: { safeGetAuthUser: mocks.user },
  createAuth: () => ({ api: { getSession: vi.fn() } }),
}));
vi.mock("../../convex/ai_gateway", () => ({ createInternalGatewayProvider: () => () => ({}) }));
vi.mock("ai", async () => ({
  ...(await vi.importActual<typeof import("ai")>("ai")),
  streamText: mocks.streamText,
  toUIMessageStream: () =>
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  createUIMessageStreamResponse: () => new Response(""),
}));

import { handleAISDKChat } from "./aisdk.chat";
import { QUESTION_TOOL_ID } from "../chatroom/tools";

/**
 * The fixture's resolved selection enables only the `question` session set, so `todo_write`
 * (switched off) must not reach the model; enabled session tools come before Worker tools.
 */
const sessionToolNames = [QUESTION_TOOL_ID];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WORKER_AUTH_PRIVATE_JWK", "test-only-issuer-secret");
  mocks.user.mockResolvedValue({ _id: "owner" });
  mocks.streamText.mockReturnValue({ stream: {} });
});
afterEach(() => vi.unstubAllEnvs());

type StoredWorker = {
  workerId?: string;
  directory?: string;
  tools: Array<"read" | "edit" | "create" | "bash">;
};

const defaultWorker: StoredWorker = {
  workerId: "selected-worker",
  directory: "/project",
  tools: ["read", "edit", "create"],
};

function fixture(
  userId = "owner",
  worker: StoredWorker = defaultWorker,
  modelSupportsTools = true,
) {
  mocks.user.mockResolvedValue({ _id: userId });
  const runQuery = vi
    .fn()
    .mockResolvedValueOnce({
      chat: {
        worker,
        scope: "workspace",
        userId: "owner",
      },
      workspace: { _id: "chat-workspace", ownerId: "owner" },
    })
    .mockResolvedValueOnce({ enabled: false })
    .mockResolvedValueOnce({ builtinToolSets: [QUESTION_TOOL_ID], mcpServers: [] })
    .mockResolvedValueOnce(modelSupportsTools);
  if (userId === "owner" && worker.workerId !== undefined)
    runQuery.mockResolvedValueOnce({
      workerId: "selected-worker",
      workspaceId: "chat-workspace",
      status: "active",
    });
  runQuery.mockResolvedValueOnce({ enabled: false });
  const runMutation = vi.fn().mockResolvedValue(null);
  return { ctx: { runQuery, runMutation } as unknown as ActionCtx, runQuery, runMutation };
}
function request() {
  return new Request("https://backend.example.test/api/aisdk/chat", {
    method: "POST",
    body: JSON.stringify({
      chatId: "chat-test",
      model: "test-model",
      messages: [],
      worker: { workerId: "foreign-worker", directory: "/untrusted" },
      userId: "untrusted",
    }),
  });
}

test("HTTP chat exposes the persisted Worker's enabled tools with signed write approvals", async () => {
  const f = fixture();
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(200);
  const options = mocks.streamText.mock.calls[0]![0];
  expect(Object.keys(options.tools)).toEqual([
    ...sessionToolNames,
    "worker_read",
    "worker_edit",
    "worker_create",
  ]);
  expect(options.toolApproval).toEqual({
    worker_edit: "user-approval",
    worker_create: "user-approval",
  });
  expect(options.experimental_toolApprovalSecret).toBeInstanceOf(Uint8Array);
  expect(f.runQuery.mock.calls[4]![1]).toEqual({
    workspaceId: "chat-workspace",
    workerId: "selected-worker",
  });
});

test("Bash-only Worker selection receives a signed approval secret", async () => {
  const f = fixture("owner", { ...defaultWorker, tools: ["bash"] });
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(200);
  const options = mocks.streamText.mock.calls[0]![0];
  expect(Object.keys(options.tools)).toEqual([...sessionToolNames, "worker_bash"]);
  expect(options.toolApproval).toEqual({ worker_bash: "user-approval" });
  expect(options.experimental_toolApprovalSecret).toBeInstanceOf(Uint8Array);
});

test("shared-chat members never receive owner-selected Worker tools", async () => {
  const f = fixture("member");
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(200);
  expect(Object.keys(mocks.streamText.mock.calls[0]![0].tools)).toEqual(sessionToolNames);
  expect(f.runQuery).toHaveBeenCalledTimes(5);
});

test("an invalid stored Worker directory fails visibly before marking a stream active", async () => {
  const f = fixture("owner", { ...defaultWorker, directory: "relative/path" });
  const response = await handleAISDKChat(f.ctx, request());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { message: expect.stringContaining("Worker tools are unavailable") },
  });
  expect(mocks.streamText).not.toHaveBeenCalled();
  expect(f.runMutation).not.toHaveBeenCalled();
});

test("a Worker without a reported directory exposes tools that explain why they cannot run", async () => {
  const f = fixture("owner", { workerId: "selected-worker", tools: ["read", "bash"] });
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(200);
  const options = mocks.streamText.mock.calls[0]![0];
  expect(Object.keys(options.tools)).toEqual([...sessionToolNames, "worker_read", "worker_bash"]);
  expect(options.toolApproval).toEqual({});
  await expect(
    options.tools.worker_bash.execute({ command: "ls", timeout: 5 }, { toolCallId: "call" }),
  ).resolves.toMatchObject({
    ok: false,
    code: "WORKER_DIRECTORY_UNAVAILABLE",
    message: "Worker has not reported a working directory; update/restart the Worker.",
  });
  // Only the stream-start bookkeeping ran; nothing was dispatched to the Worker.
  expect(f.runMutation).toHaveBeenCalledTimes(1);
});

test("Worker tools chosen without a Worker are not offered to the model", async () => {
  const f = fixture("owner", { tools: ["read"] });
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(200);
  expect(Object.keys(mocks.streamText.mock.calls[0]![0].tools)).toEqual(sessionToolNames);
  expect(f.runQuery).toHaveBeenCalledTimes(5);
});

test("default-on session tools are withheld from a model without tool support", async () => {
  const f = fixture("owner", defaultWorker, false);
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(200);
  expect(Object.keys(mocks.streamText.mock.calls[0]![0].tools)).toEqual([
    "worker_read",
    "worker_edit",
    "worker_create",
  ]);
});
