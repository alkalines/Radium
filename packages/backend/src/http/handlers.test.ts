import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";

const auth = vi.hoisted(() => ({
  safeGetAuthUser: vi.fn(),
  getSession: vi.fn(),
}));
const gateway = vi.hoisted(() => ({
  balance: vi.fn(),
  streamCompletion: vi.fn(),
}));

vi.mock("../../convex/auth", () => ({
  authComponent: { safeGetAuthUser: auth.safeGetAuthUser },
  createAuth: () => ({ api: { getSession: auth.getSession } }),
}));
vi.mock("../ai_balancer", () => ({ default: gateway.balance }));
vi.mock("../translators/openai", () => ({ StreamCompletion: gateway.streamCompletion }));

import { handleAISDKChat } from "./aisdk.chat";
import { handleChatCompletion, Internal_Chat_Completion } from "./chat_completion";
import { handleOpenAIModels } from "./models";

const runQuery = vi.fn();
const runMutation = vi.fn();
const ctx = { runQuery, runMutation } as unknown as ActionCtx;
const completionBody = { model: "test-model", messages: [{ role: "user", content: "Hello" }] };

describe("moved HTTP handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.safeGetAuthUser.mockResolvedValue(null);
    auth.getSession.mockResolvedValue(null);
  });

  test.each([handleOpenAIModels, handleChatCompletion])(
    "%s rejects missing and invalid bearer keys before routing",
    async (handler) => {
      for (const key of [undefined, "invalid-key"]) {
        runQuery.mockResolvedValue(null);
        const response = await handler(
          ctx,
          new Request("https://gateway.example.test/", {
            method: "POST",
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            body: JSON.stringify(completionBody),
          }),
        );
        expect(response.status).toBe(401);
      }
      expect(runQuery).toHaveBeenCalledExactlyOnceWith(api.keys.getKeyInfo, { key: "invalid-key" });
      expect(runMutation).not.toHaveBeenCalled();
    },
  );

  test("model listing derives workspace from the validated API key", async () => {
    const models = { object: "list", data: [{ id: "workspace-model" }] };
    runQuery.mockResolvedValueOnce({ workspace: "key-workspace" }).mockResolvedValueOnce(models);
    const response = await handleOpenAIModels(
      ctx,
      new Request(
        "https://gateway.example.test/api/openai/v1/models?workspace=untrusted-workspace",
        { headers: { Authorization: "Bearer valid-key" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(models);
    expect(runQuery).toHaveBeenNthCalledWith(2, internal.models.openaiModels, {
      workspace: "key-workspace",
    });
  });

  test("model listing retains the legacy workspace bridge", async () => {
    runQuery
      .mockResolvedValueOnce({ legacyBalance: "legacy-balance" })
      .mockResolvedValueOnce({ data: [] });
    runMutation.mockResolvedValue("backfilled-workspace");
    const response = await handleOpenAIModels(
      ctx,
      new Request("https://gateway.example.test/", {
        headers: { Authorization: "Bearer legacy-key" },
      }),
    );
    expect(response.status).toBe(200);
    expect(runMutation).toHaveBeenCalledExactlyOnceWith(
      internal.workspaces.ensureForLegacyBalance,
      {
        balance: "legacy-balance",
      },
    );
    expect(runQuery).toHaveBeenNthCalledWith(2, internal.models.openaiModels, {
      workspace: "backfilled-workspace",
    });
  });

  test("streaming completions retain the usage-record contract", async () => {
    const generation = {
      genId: "provider-generation",
      usage: {
        completion_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 1 },
        prompt_tokens: 4,
        prompt_tokens_details: { cached_tokens: 2, written_cache_tokens: 3 },
      },
      genTime: 25,
      ttft: 40,
    };
    gateway.balance.mockResolvedValue({ info: { slug: "test-provider" } });
    gateway.streamCompletion.mockImplementation(async (_request, _provider, onGeneration) => {
      let sentChunk = false;
      return new ReadableStream<string>(
        {
          async pull(controller) {
            if (!sentChunk) {
              sentChunk = true;
              controller.enqueue(
                JSON.stringify({
                  id: "provider-generation",
                  created: 1,
                  model: "test-model",
                  object: "chat.completion.chunk",
                  choices: [
                    {
                      delta: { content: "hello", role: "assistant" },
                      finish_reason: "length",
                      index: 0,
                      logprobs: null,
                    },
                  ],
                }),
              );
              return;
            }

            await onGeneration(generation);
            controller.enqueue("[DONE]");
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    });
    runQuery
      .mockResolvedValueOnce({
        apiKey: "api-key-id",
        workspace: "key-workspace",
        userId: "authenticated-user",
      })
      .mockResolvedValueOnce({ enabled: false });

    const response = await handleChatCompletion(
      ctx,
      new Request("https://gateway.example.test/api/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ ...completionBody, stream: true }),
      }),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.text();
    const returnedGenerationId = JSON.parse(responseBody.split("\n")[0].slice("data: ".length)).id;
    expect(returnedGenerationId).toMatch(/^gen-/);
    expect(returnedGenerationId).not.toBe("provider-generation");
    expect(responseBody).toContain('"provider":"test-provider"');
    expect(responseBody).toContain("data: [DONE]\n\n");
    expect(runMutation).toHaveBeenCalledExactlyOnceWith(internal.keys.recordCompletion, {
      bill: { workspace: "key-workspace", apiKey: "api-key-id" },
      request: {
        api: "chat_completions",
        byok: true,
        canceled: false,
        model_slug: "test-model",
        provider: "test-provider",
        stream: true,
        prompt_cache_key: undefined,
        telemetry_request_id: undefined,
      },
      response: {
        gen_id: returnedGenerationId,
        finish_reason: "length",
        gen_time: 25,
        ttft: 40,
        provider_gen_id: "provider-generation",
        usage: {
          completion_tokens: 3,
          prompt_tokens: 4,
          completion_tokens_details: { reasoning_tokens: 1 },
          prompt_tokens_details: { cached_tokens: 2, written_cache_tokens: 3 },
          total_tokens: 7,
        },
      },
    });
  });

  test("completion recording observes synchronous listener cancellation", async () => {
    let releaseGeneration!: () => void;
    const generationReady = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    gateway.balance.mockResolvedValue({ info: { slug: "test-provider" } });
    gateway.streamCompletion.mockImplementation(async (_request, _provider, onGeneration) => {
      return new ReadableStream<string>(
        {
          async pull(controller) {
            await generationReady;
            await onGeneration({
              genId: "provider-generation",
              usage: {
                completion_tokens: 3,
                completion_tokens_details: {},
                prompt_tokens: 4,
                prompt_tokens_details: {},
              },
              genTime: 25,
              ttft: 40,
            });
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    });

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    const response = await Internal_Chat_Completion(
      ctx,
      { ...completionBody, stream: true } as Parameters<typeof Internal_Chat_Completion>[1],
      "workspace" as Parameters<typeof Internal_Chat_Completion>[2],
      () => {
        // Cancellation marks the response immediately, even if the inner reader is locked.
        void reader.cancel("listener cancelled").catch(() => {});
      },
    );
    reader = response.body!.getReader();
    releaseGeneration();

    await vi.waitFor(() => {
      expect(runMutation).toHaveBeenCalledWith(
        internal.keys.recordCompletion,
        expect.objectContaining({ request: expect.objectContaining({ canceled: true }) }),
      );
    });
  });

  test("chat requires a Better Auth session before reading the body", async () => {
    const request = new Request("https://gateway.example.test/api/aisdk/chat", {
      method: "POST",
      headers: { Cookie: "session=test" },
      body: "not-json",
    });
    const response = await handleAISDKChat(ctx, request);
    expect(response.status).toBe(401);
    expect(auth.getSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers });
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  test.each(["convex", "cookie"])(
    "chat authorizes access using the %s session's identity",
    async (source) => {
      if (source === "convex")
        auth.safeGetAuthUser.mockResolvedValue({ _id: "authenticated-user" });
      else auth.getSession.mockResolvedValue({ user: { id: "authenticated-user" } });
      runQuery.mockResolvedValue(null);
      const response = await handleAISDKChat(
        ctx,
        new Request("https://gateway.example.test/api/aisdk/chat", {
          method: "POST",
          body: JSON.stringify({
            chatId: "private-chat",
            model: "model",
            messages: [],
            userId: "untrusted-user",
          }),
        }),
      );
      expect(response.status).toBe(401);
      expect(runQuery).toHaveBeenCalledExactlyOnceWith(internal.workspaces.authorizeChatForUser, {
        chatId: "private-chat",
        userId: "authenticated-user",
      });
      expect(runMutation).not.toHaveBeenCalled();
    },
  );
});
