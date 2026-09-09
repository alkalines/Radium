import assert from "node:assert/strict";
import { test } from "node:test";
import type { Telemetry } from "ai";

import {
  createTelemetryIntegrations,
  type TelemetryFinishTrace,
  type TelemetrySettings,
  type TelemetryStartTrace,
} from "./integration";

type StartEvent = Parameters<NonNullable<Telemetry["onStart"]>>[0];
type EndEvent = Parameters<NonNullable<Telemetry["onEnd"]>>[0];
type AbortEvent = Parameters<NonNullable<Telemetry["onAbort"]>>[0];
type StepEndEvent = Parameters<NonNullable<Telemetry["onStepEnd"]>>[0];

const usage = {
  inputTokens: 2,
  inputTokenDetails: {
    noCacheTokens: 2,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens: 3,
  outputTokenDetails: {
    textTokens: 3,
    reasoningTokens: undefined,
  },
  totalTokens: 5,
};

const defaultSettings: TelemetrySettings = {
  enabled: true,
  recordInputs: true,
  recordOutputs: true,
};

function startEvent(overrides: Record<string, unknown> = {}): StartEvent {
  return {
    callId: "call-1",
    operationId: "ai.streamText",
    provider: "provider",
    modelId: "model",
    instructions: "system",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as unknown as StartEvent;
}

function endEvent(overrides: Record<string, unknown> = {}): EndEvent {
  return {
    finishReason: "stop",
    usage,
    steps: [],
    content: [{ type: "text", text: "answer" }],
    responseMessages: [],
    ...overrides,
  } as unknown as EndEvent;
}

function stepEndEvent(stepNumber: number): StepEndEvent {
  return {
    stepNumber,
    model: { provider: "provider", modelId: "model" },
    finishReason: "stop",
    usage,
    content: [],
  } as unknown as StepEndEvent;
}

function abortEvent(): AbortEvent {
  return { steps: [], reason: new Error("aborted") } as unknown as AbortEvent;
}

function collector(settings: TelemetrySettings = defaultSettings) {
  const starts: TelemetryStartTrace[] = [];
  const finishes: TelemetryFinishTrace<string>[] = [];
  const integrations = createTelemetryIntegrations({
    requestId: "request-1",
    source: "chatroom",
    functionId: "radium.chat",
    settings,
    persistence: {
      startTrace: async (trace) => {
        starts.push(trace);
        return "trace-1";
      },
      finishTrace: async (trace) => {
        finishes.push(trace);
      },
    },
  });

  return { integration: integrations[0]!, starts, finishes };
}

async function start(integration: Telemetry) {
  await integration.onStart?.(startEvent());
}

test("honors input and output payload controls", async () => {
  const { integration, starts, finishes } = collector({
    enabled: true,
    recordInputs: false,
    recordOutputs: false,
  });

  await start(integration);
  await integration.onEnd?.(endEvent());

  assert.equal(starts[0]?.inputJson, undefined);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]?.outputJson, undefined);
  assert.equal(finishes[0]?.spans.length, 0);
});

test("records inputs and outputs independently", async () => {
  const inputOnly = collector({ enabled: true, recordInputs: true, recordOutputs: false });
  await start(inputOnly.integration);
  await inputOnly.integration.onEnd?.(endEvent());
  assert.ok(inputOnly.starts[0]?.inputJson);
  assert.equal(inputOnly.finishes[0]?.outputJson, undefined);

  const outputOnly = collector({ enabled: true, recordInputs: false, recordOutputs: true });
  await start(outputOnly.integration);
  await outputOnly.integration.onEnd?.(endEvent());
  assert.equal(outputOnly.starts[0]?.inputJson, undefined);
  assert.ok(outputOnly.finishes[0]?.outputJson);
});

test("passes request correlation and event function identifiers to persistence", async () => {
  const { integration, starts } = collector();

  await integration.onStart?.(startEvent({ functionId: "caller.function" }));

  assert.deepEqual(starts[0], {
    requestId: "request-1",
    source: "chatroom",
    callId: "call-1",
    operationId: "ai.streamText",
    functionId: "caller.function",
    provider: "provider",
    model: "model",
    startedAt: starts[0]?.startedAt,
    recordsInputs: true,
    recordsOutputs: true,
    inputJson: '{"instructions":"system","messages":[{"role":"user","content":"hello"}]}',
  });
});

test("limits persisted spans to one hundred", async () => {
  const { integration, finishes } = collector();

  await start(integration);
  for (let index = 0; index < 101; index++) {
    integration.onStepEnd?.(stepEndEvent(index));
  }
  await integration.onEnd?.(endEvent());

  assert.equal(finishes[0]?.spans.length, 100);
  assert.equal(finishes[0]?.spans[0]?.name, "Step 1");
  assert.equal(finishes[0]?.spans.at(-1)?.name, "Step 100");
});

test("finalizes only once across end, abort, and error callbacks", async () => {
  const { integration, finishes } = collector();

  await start(integration);
  await integration.onEnd?.(endEvent());
  await integration.onAbort?.(abortEvent());
  await integration.onError?.(new Error("late error"));

  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]?.status, "ok");
});

test("serializes special values and truncates valid JSON payloads", async () => {
  const { integration, starts } = collector();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  await integration.onStart?.(
    startEvent({
      messages: [
        {
          role: "user",
          content: {
            bigint: 123n,
            error: new Error("bad input"),
            cyclic,
            long: "x".repeat(40_000),
          },
        },
      ],
    }),
  );

  const serialized = starts[0]?.inputJson;
  assert.ok(serialized);
  assert.ok(serialized.length <= 32_000);
  const parsed = JSON.parse(serialized) as {
    instructions: string;
    messages: Array<{
      content: {
        bigint: string;
        error: { name: string; message: string };
        cyclic: { self: string };
        long: string;
      };
    }>;
  };
  assert.equal(parsed.instructions, "system");
  assert.equal(parsed.messages[0]?.content.bigint, "123");
  assert.deepEqual(parsed.messages[0]?.content.error, { name: "Error", message: "bad input" });
  assert.deepEqual(parsed.messages[0]?.content.cyclic, { self: "[Circular]" });
  assert.ok(parsed.messages[0]?.content.long.endsWith("…"));
  assert.ok(parsed.messages[0]?.content.long.length < 40_000);
});

test("isolates serialization failures with the existing fallback", async () => {
  const { integration, starts } = collector();
  const unserializable = {
    toJSON() {
      throw new Error("cannot serialize");
    },
  };

  await integration.onStart?.(startEvent({ messages: [unserializable] }));

  assert.equal(starts[0]?.inputJson, "[Unserializable]");
});

test("propagates persistence failures and does not retry a finalized trace", async () => {
  let finishCalls = 0;
  const integration = createTelemetryIntegrations({
    requestId: "request-1",
    source: "gateway",
    functionId: "radium.gateway",
    settings: defaultSettings,
    persistence: {
      startTrace: async () => "trace-1",
      finishTrace: async () => {
        finishCalls++;
        throw new Error("persistence unavailable");
      },
    },
  })[0]!;

  await start(integration);
  await assert.rejects(Promise.resolve(integration.onEnd!(endEvent())), /persistence unavailable/);
  await integration.onError?.(new Error("late error"));

  assert.equal(finishCalls, 1);
});

test("does not persist non-stream operations", async () => {
  const { integration, starts, finishes } = collector();

  await integration.onStart?.(startEvent({ operationId: "ai.generateObject" }));
  await integration.onEnd?.(endEvent());

  assert.equal(starts.length, 0);
  assert.equal(finishes.length, 0);
});
