import assert from "node:assert/strict";
import { test } from "vitest";
import { NonStreamingCompletion, openAIToModelMessages, StreamCompletion } from "./openai";
import { ChatCompletions_RequestBody } from "../types/openai/types";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { RoutedProvider } from "../routing/connector";

test("settles streaming billing once when aborted after provider dispatch", async () => {
  let resolveDispatch!: () => void;
  const providerDispatched = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });
  const requestController = new AbortController();
  let billingMutationCalls = 0;
  let resolveBilling!: () => void;
  const billingMutation = new Promise<void>((resolve) => {
    resolveBilling = resolve;
  });

  const model = {
    specificationVersion: "v4" as const,
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unused");
    },
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      const stream = new ReadableStream({
        start(controller) {
          const abort = () => controller.error(abortSignal?.reason);
          abortSignal?.addEventListener("abort", abort, { once: true });
        },
      });
      resolveDispatch();
      return { stream };
    },
  };
  const provider = {
    connector: () => model,
    info: { modelId: "test-model" },
  } as any;

  const output = await StreamCompletion(
    {
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      stream: true,
    },
    provider,
    async () => {
      billingMutationCalls += 1;
      resolveBilling();
    },
    requestController.signal,
  );

  const reader = output.getReader();
  await providerDispatched;
  requestController.abort();
  await reader.cancel();
  await billingMutation;

  assert.equal(billingMutationCalls, 1);
});

test("preserves custom tool input even when it resembles JSON", () => {
  const request = ChatCompletions_RequestBody.parse({
    model: "test",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { type: "custom", id: "call-1", custom: { name: "code", input: '{"value":1}' } },
        ],
      },
    ],
  });
  const message = openAIToModelMessages(request.messages)[0];
  assert.ok(message);
  assert.equal(message.role, "assistant");
  assert.ok(Array.isArray(message.content));
  assert.ok(message.content[0]);
  assert.equal(message.content[0].type, "tool-call");
  if (message.content[0].type === "tool-call")
    assert.equal(message.content[0].input, '{"value":1}');
});

test("rejects unsupported price constraints instead of silently routing without them", () => {
  assert.equal(
    ChatCompletions_RequestBody.safeParse({
      model: "test",
      messages: [],
      provider: { max_price: { prompt: 1 } },
    }).success,
    false,
  );
});

test("non-streaming completion retains every parallel function call", async () => {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "a", toolName: "lookup" },
    { type: "tool-input-start", id: "b", toolName: "lookup" },
    { type: "tool-input-end", id: "a" },
    { type: "tool-input-end", id: "b" },
    { type: "tool-call", toolCallId: "a", toolName: "lookup", input: '{"n":1}' },
    { type: "tool-call", toolCallId: "b", toolName: "lookup", input: '{"n":2}' },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: {
        inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
    },
  ];
  const provider = {
    info: { modelId: "test", npm: "@ai-sdk/openai" },
    connector: () => ({
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("unused");
      },
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      }),
    }),
  } as unknown as RoutedProvider;
  const response = await NonStreamingCompletion(
    {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: { n: { type: "number" } } },
          },
        },
      ],
    },
    provider,
    async () => undefined,
  );
  assert.ok(response.choices[0]);
  assert.deepEqual(
    response.choices[0].message.tool_calls?.map(
      (call) => "function" in call && call.function.arguments,
    ),
    ['{"n":1}', '{"n":2}'],
  );
  assert.equal(response.choices[0].finish_reason, "tool_calls");
});

test("inference mode overrides reach upstream and explicit service tiers win", async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const provider = {
    info: {
      modelId: "test",
      npm: "@ai-sdk/openai",
      inferenceMode: { id: "fast", provider_body: { service_tier: "priority" } },
    },
    connector: () => ({
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate: async () => { throw new Error("unused"); },
      doStream: async (options: { providerOptions?: Record<string, unknown>; headers?: Record<string, string> }) => {
        calls.push(options.providerOptions);
        headers.push(options.headers);
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
              controller.close();
            },
          }),
        };
      },
    }),
  } as unknown as RoutedProvider;
  const request = { model: "test", messages: [{ role: "user" as const, content: "hello" }] };
  await NonStreamingCompletion(request, provider, async () => undefined);
  assert.equal((calls[0]?.openai as Record<string, unknown>).serviceTier, "priority");
  await NonStreamingCompletion({ ...request, service_tier: "default" }, provider, async () => undefined);
  assert.equal((calls[1]?.openai as Record<string, unknown>).serviceTier, "default");
  provider.info.inferenceMode = { id: "pro", provider_body: { reasoning: { mode: "pro" } } };
  await NonStreamingCompletion(request, provider, async () => undefined);
  assert.equal((calls[2]?.openai as Record<string, unknown>).reasoningMode, "pro");
  assert.equal((calls[2]?.openai as Record<string, unknown>).serviceTier, undefined);
  provider.info.npm = "@ai-sdk/anthropic";
  provider.info.inferenceMode = {
    id: "fast",
    provider_body: { speed: "fast" },
    provider_headers: { "anthropic-beta": "fast-mode-2026-02-01" },
  };
  await NonStreamingCompletion(request, provider, async () => undefined);
  assert.equal((calls[3]?.anthropic as Record<string, unknown>).speed, "fast");
  assert.equal(headers[3]?.["anthropic-beta"], "fast-mode-2026-02-01");
  await NonStreamingCompletion({ ...request, service_tier: "default" }, provider, async () => undefined);
  assert.equal((calls[4]?.anthropic as Record<string, unknown>).speed, "standard");
  assert.equal(headers[4]?.["anthropic-beta"], undefined);
});
