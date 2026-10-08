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

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WORKER_AUTH_PRIVATE_JWK", "test-only-issuer-secret");
  mocks.user.mockResolvedValue({ _id: "owner" });
  mocks.streamText.mockReturnValue({ stream: {} });
});
afterEach(() => vi.unstubAllEnvs());

function fixture(userId = "owner", directory: string | undefined = "/project") {
  mocks.user.mockResolvedValue({ _id: userId });
  const runQuery = vi
    .fn()
    .mockResolvedValueOnce({
      chat: {
        worker: { workerId: "selected-worker", directory, tools: ["read", "edit", "create"] },
        scope: "workspace",
        userId: "owner",
      },
      workspace: { _id: "chat-workspace", ownerId: "owner" },
    })
    .mockResolvedValueOnce({ enabled: false })
    .mockResolvedValueOnce({ mcpServers: [] });
  if (userId === "owner")
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
  expect(Object.keys(options.tools)).toEqual(["worker_read", "worker_edit", "worker_create"]);
  expect(options.toolApproval).toEqual({
    worker_edit: "user-approval",
    worker_create: "user-approval",
  });
  expect(options.experimental_toolApprovalSecret).toBeInstanceOf(Uint8Array);
  expect(f.runQuery.mock.calls[3]![1]).toEqual({
    workspaceId: "chat-workspace",
    workerId: "selected-worker",
  });
});

test("shared-chat members never receive owner-selected Worker tools", async () => {
  const f = fixture("member");
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(200);
  expect(mocks.streamText.mock.calls[0]![0].tools).toEqual({});
  expect(f.runQuery).toHaveBeenCalledTimes(4);
});

test("missing Worker directory fails visibly before marking a stream active", async () => {
  const f = fixture("owner", "");
  const response = await handleAISDKChat(f.ctx, request());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { message: expect.stringContaining("absolute directory") },
  });
  expect(mocks.streamText).not.toHaveBeenCalled();
  expect(f.runMutation).not.toHaveBeenCalled();
});
