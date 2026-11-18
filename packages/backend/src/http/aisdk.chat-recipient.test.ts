import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, expect, test, vi } from "vitest";
import { toBase64Url } from "radium-crypto";
import type { ActionCtx } from "../../convex/_generated/server";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  uiStream: vi.fn(),
  sealMessages: vi.fn(),
}));
vi.mock("../../convex/auth", () => ({
  authComponent: { safeGetAuthUser: mocks.user },
  createAuth: () => ({ api: { getSession: vi.fn() } }),
}));
vi.mock("../../convex/ai_gateway", () => ({ createInternalGatewayProvider: () => () => ({}) }));
vi.mock("ai", async () => ({
  ...(await vi.importActual<typeof import("ai")>("ai")),
  streamText: () => ({ stream: {} }),
  toUIMessageStream: (options: unknown) => {
    mocks.uiStream(options);
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
  createUIMessageStreamResponse: () => new Response(""),
}));
vi.mock("../chatroom/sealing", async () => ({
  ...(await vi.importActual<typeof import("../chatroom/sealing")>("../chatroom/sealing")),
  sealChatMessages: mocks.sealMessages,
}));

import { handleAISDKChat } from "./aisdk.chat";

const publicKey = new Uint8Array(1216).fill(7);
const recipientKey = { e2eeId: "chat-e2ee", epoch: 1, publicKey: toBase64Url(publicKey) };
const target = {
  e2eeId: "chat-e2ee",
  workspace: "workspace",
  epoch: 1,
  keyId: "key",
  publicKey: publicKey.slice().buffer,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ _id: "owner" });
  mocks.sealMessages.mockResolvedValue([]);
});

/** Routes the chat action's queries by name; `sealing` answers each `chatSealingInfo` call. */
function fixture(chat: { e2eeId?: string }, sealing = vi.fn().mockResolvedValue(target)) {
  const runQuery = vi.fn(async (ref: FunctionReference<"query">, args: unknown) => {
    switch (getFunctionName(ref)) {
      case "workspaces:authorizeChatForUser":
        return {
          chat: { userId: "owner", scope: "personal", ...chat },
          workspace: { _id: "workspace", ownerId: "owner" },
        };
      case "aisdk:chatSealingInfo":
        return sealing(args);
      case "observability/telemetry:getSettingsForWorkspace":
        return { enabled: false };
      case "chatroom:resolveChatTools":
        return { builtinToolSets: [], mcpServers: [] };
      case "chatroom:resolveWebSearch":
        return { enabled: false, workspace: null };
      case "models:supportsTools":
        return false;
      case "aisdk:chatMessageHeads":
        return [];
      default:
        return null;
    }
  });
  const runMutation = vi.fn().mockResolvedValue(null);
  return { ctx: { runQuery, runMutation } as unknown as ActionCtx, runMutation, sealing };
}

function request(extra: Record<string, unknown> = {}) {
  return new Request("https://backend.example.test/api/aisdk/chat", {
    method: "POST",
    body: JSON.stringify({ chatId: "chat", model: "test-model", messages: [], ...extra }),
  });
}

/** Ends the captured stream as a completed turn, which seals and saves it. */
async function finishTurn() {
  const { onEnd } = mocks.uiStream.mock.calls[0]![0] as { onEnd: (end: unknown) => Promise<void> };
  await onEnd({
    messages: [],
    isAborted: false,
    isCancelled: false,
    outcome: { status: "completed" },
    responseMessage: { id: "response", role: "assistant", parts: [] },
  });
}

const pinned = {
  chatId: "chat",
  recipient: {
    e2eeId: "chat-e2ee",
    epoch: 1,
    publicKey: expect.any(ArrayBuffer),
    userId: "owner",
  },
};

test("an encrypted turn without the client's pinned key is refused before anything starts", async () => {
  const f = fixture({ e2eeId: "chat-e2ee" });
  expect((await handleAISDKChat(f.ctx, request())).status).toBe(409);
  expect(f.sealing).not.toHaveBeenCalled();
  expect(f.runMutation).not.toHaveBeenCalled();
});

test("a malformed pin is a bad request, and a pin for a chat the server sees as keyless never saves plaintext", async () => {
  const malformed = fixture({ e2eeId: "chat-e2ee" });
  const short = { ...recipientKey, publicKey: toBase64Url(publicKey.slice(1)) };
  expect((await handleAISDKChat(malformed.ctx, request({ recipientKey: short }))).status).toBe(400);
  const keyless = fixture({});
  expect((await handleAISDKChat(keyless.ctx, request({ recipientKey }))).status).toBe(409);
  expect(keyless.sealing).not.toHaveBeenCalled();
  expect(keyless.runMutation).not.toHaveBeenCalled();
});

test("a pin the current key no longer matches is refused before generation", async () => {
  const f = fixture({ e2eeId: "chat-e2ee" }, vi.fn().mockResolvedValue(null));
  expect((await handleAISDKChat(f.ctx, request({ recipientKey }))).status).toBe(409);
  expect(f.sealing).toHaveBeenCalledExactlyOnceWith(pinned);
  expect(f.runMutation).not.toHaveBeenCalled();
});

test("the preflight and the final seal both resolve the same authenticated sender's pin", async () => {
  const f = fixture({ e2eeId: "chat-e2ee" });
  expect((await handleAISDKChat(f.ctx, request({ recipientKey }))).status).toBe(200);
  await finishTurn();
  expect(f.sealing).toHaveBeenCalledTimes(2);
  expect(f.sealing).toHaveBeenNthCalledWith(1, pinned);
  expect(f.sealing).toHaveBeenNthCalledWith(2, pinned);
  const sealed = f.sealing.mock.calls[1]![0] as { recipient: { publicKey: ArrayBuffer } };
  expect(new Uint8Array(sealed.recipient.publicKey)).toEqual(publicKey);
  expect(mocks.sealMessages).toHaveBeenCalledWith(expect.objectContaining({ epoch: 1 }));
});

test("a key change between preflight and saving fails the turn instead of sealing elsewhere", async () => {
  const f = fixture(
    { e2eeId: "chat-e2ee" },
    vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(null),
  );
  expect((await handleAISDKChat(f.ctx, request({ recipientKey }))).status).toBe(200);
  await expect(finishTurn()).rejects.toThrow("could not be saved securely");
  expect(f.sealing).toHaveBeenNthCalledWith(2, pinned);
  expect(mocks.sealMessages).not.toHaveBeenCalled();
  expect(f.runMutation).toHaveBeenLastCalledWith(expect.anything(), {
    chatId: "chat",
    activeStream: false,
  });
});
