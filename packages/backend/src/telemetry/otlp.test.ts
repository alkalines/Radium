import { describe, expect, test } from "vitest";
import {
  buildOtlpExport,
  deliveryUrl,
  isSampled,
  parseDestinationEndpoint,
  type OtlpAttribute,
  type OtlpBundle,
  type OtlpValue,
} from "./otlp";
import type { LoadedBlob, LoadedNode } from "./store";

function blob(value: unknown, kind: LoadedBlob["kind"] = "message"): LoadedBlob {
  return {
    id: "blob" as never,
    hash: "h",
    kind,
    size: 1,
    content: value === undefined ? undefined : JSON.stringify(value),
    redacted: false,
  };
}

function node(depth: number, value: unknown): LoadedNode {
  return { id: `node${depth}` as never, depth, origin: "input", message: blob(value) };
}

function bundle(overrides: Partial<OtlpBundle> = {}): OtlpBundle {
  return {
    request: {
      requestId: "req-1",
      source: "gateway",
      model: "openrouter/some-model",
      provider: "openrouter",
      stream: true,
      status: "ok",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_002_000,
      durationMs: 2000,
      ttftMs: 400,
      generationMs: 1500,
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 31,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        reasoningTokens: 5,
      },
      providerGenerationId: "gen-9",
      attempts: [
        {
          provider: "openrouter",
          providerModel: "some-model",
          startedAt: 1_700_000_000_100,
          durationMs: 300,
          outcome: "error",
          status: 429,
          errorKind: "rate_limit",
          message: "slow down",
        },
        {
          provider: "openai",
          providerModel: "gpt-x",
          startedAt: 1_700_000_000_500,
          durationMs: 1400,
          outcome: "ok",
        },
      ],
      lineage: { kind: "continue" },
      changes: { system: { to: "x" }, params: { to: "y" } },
    },
    sessionKey: "session-abc",
    system: blob([{ role: "system", content: "Be brief." }], "system"),
    toolset: [
      blob(
        { type: "function", function: { name: "lookup", description: "d", parameters: {} } },
        "tool",
      ),
    ],
    params: blob(
      {
        model: "openrouter/some-model",
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        max_tokens: 256,
        seed: 7,
        stop: "END",
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        reasoning: { effort: "high" },
      },
      "params",
    ),
    messages: [node(1, { role: "user", content: "hi" })],
    output: node(2, { role: "assistant", content: "hello" }),
    ...overrides,
  };
}

function attrs(list: OtlpAttribute[]): Record<string, OtlpValue> {
  return Object.fromEntries(list.map((item) => [item.key, item.value]));
}

function parseJsonAttr(map: Record<string, OtlpValue>, key: string): unknown {
  const value = map[key];
  if (!value || !("stringValue" in value)) throw new Error(`${key} is not a string attribute`);
  return JSON.parse(value.stringValue);
}

async function spansOf(input: OtlpBundle, privacyMode = false) {
  const exported = await buildOtlpExport(input, { privacyMode });
  return exported.resourceSpans[0].scopeSpans[0].spans;
}

describe("buildOtlpExport", () => {
  test("maps request fields to GenAI attributes with a child span per attempt", async () => {
    const [root, ...children] = await spansOf(bundle());
    const a = attrs(root.attributes);

    expect(root.name).toBe("chat openrouter/some-model");
    expect(root.kind).toBe(3);
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.startTimeUnixNano).toBe("1700000000000000000");
    expect(root.endTimeUnixNano).toBe("1700000002000000000");
    expect(root.status).toEqual({ code: 1 });

    expect(a["gen_ai.operation.name"]).toEqual({ stringValue: "chat" });
    expect(a["gen_ai.provider.name"]).toEqual({ stringValue: "openrouter" });
    expect(a["gen_ai.request.model"]).toEqual({ stringValue: "openrouter/some-model" });
    expect(a["gen_ai.response.model"]).toEqual({ stringValue: "gpt-x" });
    expect(a["gen_ai.response.id"]).toEqual({ stringValue: "gen-9" });
    expect(a["gen_ai.conversation.id"]).toEqual({ stringValue: "session-abc" });
    expect(a["gen_ai.response.finish_reasons"]).toEqual({
      arrayValue: { values: [{ stringValue: "stop" }] },
    });
    expect(a["gen_ai.request.temperature"]).toEqual({ doubleValue: 0.5 });
    expect(a["gen_ai.request.top_k"]).toEqual({ intValue: "40" });
    expect(a["gen_ai.request.max_tokens"]).toEqual({ intValue: "256" });
    expect(a["gen_ai.request.stop_sequences"]).toEqual({
      arrayValue: { values: [{ stringValue: "END" }] },
    });
    expect(a["gen_ai.request.stream"]).toEqual({ boolValue: true });
    expect(a["gen_ai.request.reasoning.level"]).toEqual({ stringValue: "high" });
    expect(a["gen_ai.usage.input_tokens"]).toEqual({ intValue: "10" });
    expect(a["gen_ai.usage.cache_read.input_tokens"]).toEqual({ intValue: "4" });
    expect(a["gen_ai.usage.cache_write.input_tokens"]).toEqual({ intValue: "2" });
    expect(a["gen_ai.usage.reasoning.output_tokens"]).toEqual({ intValue: "5" });
    expect(a["gen_ai.response.time_to_first_chunk"]).toEqual({ doubleValue: 0.4 });
    expect(a["radium.inter_token_latency_ms"]).toEqual({ doubleValue: 50 });
    expect(a["radium.lineage.kind"]).toEqual({ stringValue: "continue" });
    expect(a["radium.changes"]).toEqual({ stringValue: "system,params" });
    expect(a["radium.attempt.count"]).toEqual({ intValue: "2" });
    expect(a["gen_ai.conversation.compacted"]).toBeUndefined();

    expect(children).toHaveLength(2);
    expect(children.every((child) => child.parentSpanId === root.spanId)).toBe(true);
    expect(new Set(children.map((child) => child.spanId)).size).toBe(2);
    expect(attrs(children[0].attributes)["gen_ai.provider.name"]).toEqual({
      stringValue: "openrouter",
    });
    expect(children[0].status).toEqual({ code: 2, message: "slow down" });
    expect(children[1].status).toEqual({ code: 1 });
  });

  test("marks compacted lineage and error status", async () => {
    const input = bundle();
    input.request.lineage = { kind: "compacted" };
    input.request.status = "error";
    input.request.error = { message: "upstream failed" };
    const [root] = await spansOf(input);

    expect(attrs(root.attributes)["gen_ai.conversation.compacted"]).toEqual({ boolValue: true });
    expect(root.status).toEqual({ code: 2, message: "upstream failed" });
  });

  test("includes content as JSON strings and omits it in privacy mode", async () => {
    const [open] = await spansOf(bundle());
    const openAttrs = attrs(open.attributes);

    const input = parseJsonAttr(openAttrs, "gen_ai.input.messages");
    expect(input).toEqual([{ role: "user", parts: [{ type: "text", content: "hi" }] }]);
    const output = parseJsonAttr(openAttrs, "gen_ai.output.messages");
    expect(output).toMatchObject([{ role: "assistant", finish_reason: "stop" }]);
    expect(openAttrs["gen_ai.system_instructions"]).toBeDefined();
    expect(parseJsonAttr(openAttrs, "gen_ai.tool.definitions")).toEqual([
      { type: "function", name: "lookup", description: "d", parameters: {} },
    ]);

    const [private_] = await spansOf(bundle(), true);
    const keys = private_.attributes.map((item) => item.key);
    for (const key of [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "gen_ai.tool.definitions",
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  test("omits content that was recorded redacted", async () => {
    const redacted = { ...blob(undefined), redacted: true };
    const input = bundle({
      messages: [{ ...node(1, undefined), message: redacted }],
      output: { ...node(2, undefined), message: redacted },
      system: { ...redacted, kind: "system" },
    });
    const keys = (await spansOf(input))[0].attributes.map((item) => item.key);

    expect(keys).not.toContain("gen_ai.input.messages");
    expect(keys).not.toContain("gen_ai.output.messages");
    expect(keys).not.toContain("gen_ai.system_instructions");
  });

  test("honors the OpenRouter trace field", async () => {
    const traceId = "ABCDEF0123456789ABCDEF0123456789";
    const input = bundle({
      params: blob(
        {
          trace: {
            trace_id: traceId,
            parent_span_id: "0123456789abcdef",
            generation_name: "summarize",
            trace_name: "ignored-name",
            team: "search",
            attempt: 3,
          },
        },
        "params",
      ),
    });
    const [root] = await spansOf(input);
    const a = attrs(root.attributes);

    expect(root.traceId).toBe(traceId.toLowerCase());
    expect(root.parentSpanId).toBe("0123456789abcdef");
    expect(root.name).toBe("summarize");
    expect(a["trace.metadata.team"]).toEqual({ stringValue: "search" });
    expect(a["trace.metadata.attempt"]).toEqual({ stringValue: "3" });
    expect(a["trace.metadata.trace_id"]).toBeUndefined();
  });

  test("hashes non-hex trace ids deterministically", async () => {
    const input = bundle({ params: blob({ trace: { trace_id: "my-run-42" } }, "params") });
    const [first] = await spansOf(input);
    const [second] = await spansOf(input);

    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.traceId).toBe(second.traceId);
    expect(first.traceId).not.toBe((await spansOf(bundle()))[0].traceId);
  });

  test("skips inter-token latency without enough output tokens", async () => {
    const input = bundle();
    input.request.usage = { outputTokens: 1 };
    const [root] = await spansOf(input);

    expect(attrs(root.attributes)["radium.inter_token_latency_ms"]).toBeUndefined();
  });
});

describe("isSampled", () => {
  test("is deterministic per key and honors the bounds", async () => {
    expect(await isSampled("session", 1)).toBe(true);
    expect(await isSampled("session", 0)).toBe(false);
    expect(await isSampled("session", 0.5)).toBe(await isSampled("session", 0.5));
  });

  test("keeps roughly the requested share and is monotone in the rate", async () => {
    const keys = Array.from({ length: 400 }, (_, index) => `session-${index}`);
    const low = await Promise.all(keys.map((key) => isSampled(key, 0.25)));
    const high = await Promise.all(keys.map((key) => isSampled(key, 0.75)));

    const kept = low.filter(Boolean).length;
    expect(kept).toBeGreaterThan(60);
    expect(kept).toBeLessThan(140);
    // A key kept at a lower rate stays kept at a higher one.
    expect(low.every((value, index) => !value || high[index])).toBe(true);
  });
});

describe("endpoints", () => {
  test("requires https except on loopback and rejects embedded credentials", () => {
    expect(parseDestinationEndpoint("https://otel.example.com")).toBeDefined();
    expect(parseDestinationEndpoint("http://localhost:4318")).toBeDefined();
    expect(parseDestinationEndpoint("http://127.0.0.1:4318")).toBeDefined();
    expect(parseDestinationEndpoint("http://[::1]:4318")).toBeDefined();
    expect(parseDestinationEndpoint("http://otel.example.com")).toBeUndefined();
    expect(parseDestinationEndpoint("https://user:pass@otel.example.com")).toBeUndefined();
    expect(parseDestinationEndpoint("not a url")).toBeUndefined();
  });

  test("appends /v1/traces for OTLP only when missing", () => {
    expect(deliveryUrl("otlp", "https://otel.example.com")).toBe(
      "https://otel.example.com/v1/traces",
    );
    expect(deliveryUrl("otlp", "https://otel.example.com/prefix/")).toBe(
      "https://otel.example.com/prefix/v1/traces",
    );
    expect(deliveryUrl("otlp", "https://otel.example.com/v1/traces")).toBe(
      "https://otel.example.com/v1/traces",
    );
    expect(deliveryUrl("webhook", "https://hooks.example.com/in")).toBe(
      "https://hooks.example.com/in",
    );
  });
});
