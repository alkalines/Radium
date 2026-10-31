/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { APICallError } from "ai";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";
import { DEFAULT_ROUTING_SETTINGS } from "../routing/settings";
import type * as Translators from "../translators/openai";

const auth = vi.hoisted(() => ({
  safeGetAuthUser: vi.fn(),
  getSession: vi.fn(),
}));
const gateway = vi.hoisted(() => ({
  streamCompletion: vi.fn(),
}));

vi.mock("../../convex/auth", () => ({
  authComponent: { safeGetAuthUser: auth.safeGetAuthUser },
  createAuth: () => ({ api: { getSession: auth.getSession } }),
}));
vi.mock("../routing/connector", () => ({
  createRoutedProvider: (_ctx: unknown, provider: { slug: string }) => ({
    info: provider,
    connector: vi.fn(),
  }),
}));
vi.mock("../translators/openai", async (importOriginal) => ({
  ...(await importOriginal<typeof Translators>()),
  StreamCompletion: gateway.streamCompletion,
}));

import { CompletionStreamError } from "../translators/openai";
import { handleAISDKChat } from "./aisdk.chat";
import { handleChatCompletion, Internal_Chat_Completion } from "./chat_completion";
import { handleOpenAIModels } from "./models";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.ts");
const runQuery = vi.fn();
const runMutation = vi.fn();
const ctx = { runQuery, runMutation } as unknown as ActionCtx;
const completionBody = { model: "test-model", messages: [{ role: "user", content: "Hello" }] };

function isPick(fn: FunctionReference<"mutation", "internal">) {
  return getFunctionName(fn) === getFunctionName(internal.routing.pick);
}

function routedProvider(slug: string) {
  return { slug, routing: { errorRules: [] }, credential: { values: {} } };
}

/** Route every attempt to one provider and accept routing and usage writes. */
function routeTo(slug: string) {
  runMutation.mockImplementation(async (fn) =>
    isPick(fn)
      ? { ok: true, provider: routedProvider(slug), settings: DEFAULT_ROUTING_SETTINGS }
      : null,
  );
}

function streamChunk(content: string, finishReason: string | null = null) {
  return JSON.stringify({
    id: "provider-generation",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [
      {
        delta: { content, role: "assistant" },
        finish_reason: finishReason,
        index: 0,
        logprobs: null,
      },
    ],
  });
}

function streamingRequest() {
  return new Request("https://gateway.example.test/api/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
    body: JSON.stringify({ ...completionBody, stream: true }),
  });
}

function mockValidKey() {
  runQuery
    .mockResolvedValueOnce({
      apiKey: "api-key-id",
      workspace: "key-workspace",
      userId: "authenticated-user",
    })
    .mockResolvedValueOnce({ enabled: false });
}

function upstreamError(statusCode: number) {
  return new APICallError({
    message: `Upstream ${statusCode}`,
    url: "https://upstream.example.test",
    requestBodyValues: {},
    statusCode,
  });
}

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

  test("streaming fails over to the next provider before any output", async () => {
    const providers = ["first-provider", "second-provider"];
    runMutation.mockImplementation(async (fn, args) => {
      if (!isPick(fn)) return null;
      const next = providers.find(
        (slug) => !args.excluded.some((target: { provider: string }) => target.provider === slug),
      );
      if (!next) return { ok: false, message: "exhausted", settings: DEFAULT_ROUTING_SETTINGS };
      return { ok: true, provider: routedProvider(next), settings: DEFAULT_ROUTING_SETTINGS };
    });
    gateway.streamCompletion.mockImplementation(async (_request, provider) => {
      if (provider.info.slug === "first-provider") {
        return new ReadableStream({
          start(controller) {
            controller.error(new CompletionStreamError(upstreamError(503), false));
          },
        });
      }
      return new ReadableStream<string>({
        start(controller) {
          controller.enqueue(streamChunk("served"));
          controller.enqueue("[DONE]");
          controller.close();
        },
      });
    });
    mockValidKey();

    const response = await handleChatCompletion(ctx, streamingRequest());

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"provider":"second-provider"');
    expect(body).not.toContain('"error"');
    expect(runMutation).toHaveBeenCalledWith(
      internal.routing.reportResult,
      expect.objectContaining({
        provider: "first-provider",
        outcome: expect.objectContaining({ type: "failure", reason: "transient", status: 503 }),
      }),
    );
    expect(runMutation).toHaveBeenCalledWith(
      internal.routing.reportResult,
      expect.objectContaining({ provider: "second-provider", outcome: { type: "success" } }),
    );
  });

  test("a captured streaming request stores its failover attempts, input, and output", async () => {
    const t = convexTest({ schema, modules });
    const { workspace, apiKey } = await t.run(async (db) => {
      const workspace = await db.db.insert("workspaces", {
        ownerType: "user",
        ownerId: "authenticated-user",
        name: "Workspace",
      });
      const apiKey = await db.db.insert("api_keys", { workspace, name: "key", hash: "hash" });
      return { workspace, apiKey };
    });
    const providers = ["first-provider", "second-provider"];
    runQuery.mockImplementation(async (fn, args) => {
      const name = getFunctionName(fn);
      if (name === getFunctionName(api.keys.getKeyInfo)) {
        return { apiKey, workspace, userId: "authenticated-user" };
      }
      if (name === getFunctionName(internal.observability.telemetry.getSettingsForWorkspace)) {
        return { enabled: true, recordInputs: true, recordOutputs: true };
      }
      return await t.query(fn, args);
    });
    runMutation.mockImplementation(async (fn, args) => {
      if (isPick(fn)) {
        const next = providers.find(
          (slug) => !args.excluded.some((target: { provider: string }) => target.provider === slug),
        );
        if (!next) return { ok: false, message: "exhausted", settings: DEFAULT_ROUTING_SETTINGS };
        return { ok: true, provider: routedProvider(next), settings: DEFAULT_ROUTING_SETTINGS };
      }
      const name = getFunctionName(fn);
      if (
        name === getFunctionName(internal.routing.reportResult) ||
        name === getFunctionName(internal.keys.recordCompletion)
      ) {
        return null;
      }
      return await t.mutation(fn, args);
    });
    gateway.streamCompletion.mockImplementation(async (_request, provider) => {
      if (provider.info.slug === "first-provider") {
        return new ReadableStream({
          start(controller) {
            controller.error(new CompletionStreamError(upstreamError(503), false));
          },
        });
      }
      return new ReadableStream<string>({
        start(controller) {
          controller.enqueue(streamChunk("served"));
          controller.enqueue("[DONE]");
          controller.close();
        },
      });
    });

    // Export delivery is scheduled by capture; keep it from running inside this test.
    vi.useFakeTimers();
    try {
      const response = await handleChatCompletion(
        ctx,
        new Request("https://gateway.example.test/api/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer valid-key",
            "Content-Type": "application/json",
            "X-Title": "Radium test",
          },
          body: JSON.stringify({
            ...completionBody,
            stream: true,
            prompt_cache_key: "capture-cache-key",
          }),
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      vi.useRealTimers();
    }

    const captured = await t.run(async (db) => {
      const requests = await db.db.query("telemetry_requests").collect();
      const request = requests[0];
      const outputNode = request?.output
        ? await db.db.get("telemetry_nodes", request.output)
        : null;
      const outputBlob = outputNode ? await db.db.get("telemetry_blobs", outputNode.blob) : null;
      const params = request?.params ? await db.db.get("telemetry_blobs", request.params) : null;
      const headers = request?.headers ? await db.db.get("telemetry_blobs", request.headers) : null;
      return { requests, outputNode, outputBlob, params, headers };
    });
    expect(captured.requests).toHaveLength(1);
    const request = captured.requests[0]!;
    expect(request).toMatchObject({
      status: "ok",
      source: "gateway",
      stream: true,
      model: "test-model",
      provider: "second-provider",
      apiKey,
      lineage: { kind: "root" },
    });
    expect(request.attempts).toMatchObject([
      { provider: "first-provider", outcome: "error", status: 503, errorKind: "http" },
      { provider: "second-provider", outcome: "ok" },
    ]);
    expect(captured.outputNode?.parent).toBe(request.input);
    expect(JSON.parse(captured.outputBlob!.content!)).toEqual({
      role: "assistant",
      content: "served",
    });
    // Supported request parameters are captured, but credentials never are.
    expect(JSON.parse(captured.params!.content!)).toMatchObject({
      prompt_cache_key: "capture-cache-key",
    });
    expect(JSON.parse(captured.headers!.content!)).toEqual({ "x-title": "Radium test" });
  });

  test("a failure after output is reported in-stream and never retried", async () => {
    routeTo("test-provider");
    gateway.streamCompletion.mockImplementation(async () => {
      let sentChunk = false;
      return new ReadableStream<string>(
        {
          pull(controller) {
            if (!sentChunk) {
              sentChunk = true;
              controller.enqueue(streamChunk("partial"));
              return;
            }
            controller.error(new CompletionStreamError(upstreamError(500), true));
          },
        },
        { highWaterMark: 0 },
      );
    });
    mockValidKey();

    const response = await handleChatCompletion(ctx, streamingRequest());

    const body = await response.text();
    expect(body).toContain('"content":"partial"');
    expect(body).toContain('"error":{"message":"Upstream 500","code":500');
    expect(body).not.toContain("[DONE]");
    expect(gateway.streamCompletion).toHaveBeenCalledTimes(1);
  });

  test("request-invalid upstream errors return without trying another provider", async () => {
    routeTo("test-provider");
    gateway.streamCompletion.mockImplementation(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.error(new CompletionStreamError(upstreamError(400), false));
          },
        }),
    );
    mockValidKey();

    const response = await handleChatCompletion(ctx, streamingRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: "Upstream 400", code: 400, status: 400, provider: "test-provider" },
    });
    expect(gateway.streamCompletion).toHaveBeenCalledTimes(1);
  });

  test.each([
    { status: 429, code: "usage_limit_reached", type: "usage_limit_reached" },
    { status: 401, code: "invalid_api_key", type: "authentication_error" },
    { status: 402, code: "insufficient_balance", type: "payment_required" },
  ])(
    "returns upstream $code after configured failover is exhausted",
    async ({ status, code, type }) => {
      const settings = { ...DEFAULT_ROUTING_SETTINGS, requestRetry: 0 };
      runMutation.mockImplementation(async (fn, args) => {
        if (!isPick(fn)) return null;
        return args.excluded.length === 0
          ? { ok: true, provider: routedProvider("test-provider"), settings }
          : { ok: false, message: "No other providers", settings };
      });
      gateway.streamCompletion.mockImplementation(async () => {
        throw new CompletionStreamError(
          new APICallError({
            message: "Upstream inference failed",
            url: "https://upstream.example.test",
            requestBodyValues: {},
            statusCode: status,
            responseHeaders: { "retry-after": "15" },
            responseBody: JSON.stringify({
              error: { message: "Provider refused inference", code, type },
            }),
          }),
          false,
        );
      });
      mockValidKey();
      const response = await handleChatCompletion(ctx, streamingRequest());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: {
          message: "Provider refused inference",
          status,
          code,
          type,
          provider: "test-provider",
        },
      });
      expect(response.headers.get("retry-after")).toBe("15");
    },
  );

  test("Chatroom returns structured errors for arbitrary upstream providers", async () => {
    auth.safeGetAuthUser.mockResolvedValue({ _id: "owner" });
    runQuery.mockImplementation(async (fn) => {
      const name = getFunctionName(fn);
      if (name === getFunctionName(internal.workspaces.authorizeChatForUser))
        return {
          chat: { userId: "owner", scope: "workspace" },
          workspace: { _id: "key-workspace", ownerId: "owner" },
        };
      if (name === getFunctionName(internal.observability.telemetry.getSettingsForWorkspace))
        return { enabled: false };
      if (name === getFunctionName(internal.chatroom.resolveChatTools))
        return { builtinToolSets: [], mcpServers: [] };
      if (name === getFunctionName(internal.models.supportsTools)) return true;
      if (name === getFunctionName(internal.chatroom.resolveWebSearch)) return { enabled: false };
      throw new Error(`Unexpected query ${name}`);
    });
    const settings = { ...DEFAULT_ROUTING_SETTINGS, requestRetry: 0 };
    runMutation.mockImplementation(async (fn, args) => {
      if (!isPick(fn)) return null;
      return args.excluded.length === 0
        ? { ok: true, provider: routedProvider("subscription-example"), settings }
        : { ok: false, message: "No other providers", settings };
    });
    gateway.streamCompletion.mockImplementation(async () => {
      throw new CompletionStreamError(
        new APICallError({
          message: "Upstream failure",
          statusCode: 429,
          url: "https://subscription.example.test",
          requestBodyValues: {},
          responseBody: JSON.stringify({
            error: {
              code: "provider_custom_limit",
              type: "provider_limit",
              message: "Subscription capacity exhausted",
            },
          }),
        }),
        false,
      );
    });
    const response = await handleAISDKChat(
      ctx,
      new Request("https://gateway.example.test/api/aisdk/chat", {
        method: "POST",
        body: JSON.stringify({
          chatId: "chat-id",
          model: "test-model",
          messages: [
            { id: "user-message", role: "user", parts: [{ type: "text", text: "Hello" }] },
          ],
        }),
      }),
    );
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const details = events.find((event) => event.type === "data-gateway-error");
    expect(details).toEqual({
      type: "data-gateway-error",
      transient: true,
      data: {
        status: 429,
        code: "provider_custom_limit",
        type: "provider_limit",
        message: "Subscription capacity exhausted",
        provider: "subscription-example",
      },
    });
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].errorText).toContain("provider_custom_limit");

    // The failure outlives the page: the saved chat offers to continue with the same error.
    const saved = runMutation.mock.calls.findLast(
      ([fn]) => getFunctionName(fn) === getFunctionName(internal.aisdk.EditChat),
    );
    expect(saved?.[1]).toMatchObject({
      activeStream: false,
      interruption: { kind: "failed", message: errors[0].errorText },
    });
  });

  test("completion recording observes synchronous listener cancellation", async () => {
    let releaseGeneration!: () => void;
    const generationReady = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    routeTo("test-provider");
    gateway.streamCompletion.mockImplementation(async (_request, _provider, onGeneration) => {
      let sentChunk = false;
      return new ReadableStream<string>(
        {
          async pull(controller) {
            // Routing commits on the first payload; usage settles after it.
            if (!sentChunk) {
              sentChunk = true;
              controller.enqueue(streamChunk("hello"));
              return;
            }
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
