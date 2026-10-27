import { blobValue, type LoadedBlob, type LoadedNode } from "./store";
import type { TelemetryAttempt, TelemetryUsage } from "./validators";

/** OTLP/JSON `AnyValue` subset used by exports. 64-bit integers are strings per OTLP/JSON. */
export type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpValue[] } };

export type OtlpAttribute = { key: string; value: OtlpValue };

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 3 = CLIENT. */
  kind: 3;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: 0 | 1 | 2; message?: string };
};

export type ExportTraceServiceRequest = {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string; version?: string }; spans: OtlpSpan[] }>;
  }>;
};

/** The `telemetry_requests` fields the exporter reads. Plain data so the builder stays pure. */
export type OtlpRequest = {
  requestId: string;
  source: "chatroom" | "gateway";
  model: string;
  provider?: string;
  stream: boolean;
  status: "ok" | "error" | "aborted";
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ttftMs?: number;
  generationMs?: number;
  finishReason?: string;
  usage?: TelemetryUsage;
  providerGenerationId?: string;
  error?: { message: string; status?: number };
  attempts: TelemetryAttempt[];
  lineage: { kind: string };
  changes?: { system?: unknown; toolset?: unknown; params?: unknown; model?: unknown };
};

/** A request plus the blobs and messages its pointers resolve to. */
export type OtlpBundle = {
  request: OtlpRequest;
  /** Routing session key; `gen_ai.conversation.id`. */
  sessionKey?: string;
  system?: LoadedBlob | null;
  toolset?: LoadedBlob[];
  params?: LoadedBlob | null;
  /** Conversation chain ending at the request input, oldest first. */
  messages?: LoadedNode[];
  output?: LoadedNode | null;
};

export type OtlpOptions = {
  /** Strip messages, system instructions, tool definitions, and output. */
  privacyMode: boolean;
};

const encoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Deterministic keep/drop decision in `[0, 1)` space. The same key always lands in the same
 * bucket, so every request of a session is kept or dropped together.
 */
export async function isSampled(key: string, rate: number): Promise<boolean> {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const hex = (await sha256Hex(`sample\u0000${key}`)).slice(0, 8);
  return parseInt(hex, 16) / 0x1_0000_0000 < rate;
}

function toNanos(milliseconds: number): string {
  return (BigInt(Math.round(milliseconds)) * 1_000_000n).toString();
}

function attr(key: string, value: unknown): OtlpAttribute | undefined {
  const converted = toValue(value);
  return converted ? { key, value: converted } : undefined;
}

/** Measurements stay doubles even when whole, so a series never mixes int and double. */
function doubleAttr(key: string, value: number | undefined): OtlpAttribute | undefined {
  return value === undefined ? undefined : { key, value: { doubleValue: value } };
}

function toValue(value: unknown): OtlpValue | undefined {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    const values = value.map(toValue).filter((item): item is OtlpValue => item !== undefined);
    return { arrayValue: { values } };
  }
  return undefined;
}

function compact(attributes: Array<OtlpAttribute | undefined>): OtlpAttribute[] {
  return attributes.filter((item): item is OtlpAttribute => item !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number");
}

function parseJsonOrKeep(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function contentParts(content: unknown): unknown[] {
  if (typeof content === "string") return content ? [{ type: "text", content }] : [];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    const record = asRecord(part);
    if (!record) return { type: "text", content: String(part) };
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "text", content: record.text };
    }
    if (record.type === "image_url") {
      const url = asRecord(record.image_url)?.url ?? record.image_url;
      return { type: "uri", modality: "image", uri: url };
    }
    return record;
  });
}

/** OpenAI chat message → OTel GenAI message with typed parts. */
function toGenAiMessage(message: unknown, finishReason?: string): Record<string, unknown> {
  const record = asRecord(message) ?? {};
  const role = typeof record.role === "string" ? record.role : "user";
  const parts: unknown[] = [];

  if (role === "tool") {
    parts.push({
      type: "tool_call_response",
      id: record.tool_call_id,
      response: parseJsonOrKeep(
        typeof record.content === "string" ? record.content : JSON.stringify(record.content),
      ),
    });
  } else {
    if (typeof record.reasoning === "string" && record.reasoning) {
      parts.push({ type: "reasoning", content: record.reasoning });
    }
    parts.push(...contentParts(record.content));
    if (Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        const fn = asRecord(asRecord(call)?.function);
        parts.push({
          type: "tool_call",
          id: asRecord(call)?.id,
          name: fn?.name,
          arguments: parseJsonOrKeep(fn?.arguments),
        });
      }
    }
  }

  return {
    role,
    parts,
    ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
  };
}

function toToolDefinition(tool: unknown): unknown {
  const record = asRecord(tool);
  const fn = asRecord(record?.function);
  if (!fn) return tool;
  return {
    type: typeof record?.type === "string" ? record.type : "function",
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
  };
}

async function normalizeId(value: string, length: 16 | 32): Promise<string> {
  const lowered = value.toLowerCase();
  const pattern = length === 32 ? HEX_32 : HEX_16;
  if (pattern.test(lowered) && !/^0+$/.test(lowered)) return lowered;
  return (await sha256Hex(value)).slice(0, length);
}

function stopSequences(stop: unknown): string[] | undefined {
  if (typeof stop === "string") return [stop];
  if (Array.isArray(stop)) return stop.filter((item): item is string => typeof item === "string");
  return undefined;
}

function reasoningLevel(params: Record<string, unknown>): string | undefined {
  const reasoning = asRecord(params.reasoning);
  const effort = reasoning?.effort ?? params.reasoning_effort;
  return typeof effort === "string" ? effort : undefined;
}

function metadataValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function changedFields(changes: OtlpRequest["changes"]): string | undefined {
  if (!changes) return undefined;

  const fields = (["system", "toolset", "params", "model"] as const).filter(
    (field) => changes[field] !== undefined,
  );
  return fields.length > 0 ? fields.join(",") : undefined;
}

/**
 * Build one OTLP/JSON trace for a captured request: a root `chat {model}` span carrying the
 * GenAI semantic-convention attributes plus one child span per routing attempt. IDs and times
 * derive only from the request, so redelivery produces an identical payload.
 */
export async function buildOtlpExport(
  bundle: OtlpBundle,
  options: OtlpOptions,
): Promise<ExportTraceServiceRequest> {
  const { request } = bundle;
  const params = asRecord(blobValue(bundle.params)) ?? {};
  const trace = asRecord(params.trace) ?? {};

  const traceId =
    typeof trace.trace_id === "string" && trace.trace_id
      ? await normalizeId(trace.trace_id, 32)
      : (await sha256Hex(`trace\u0000${request.requestId}`)).slice(0, 32);
  const rootSpanId = (await sha256Hex(`span\u0000${request.requestId}\u0000root`)).slice(0, 16);
  const parentSpanId =
    typeof trace.parent_span_id === "string" && trace.parent_span_id
      ? await normalizeId(trace.parent_span_id, 16)
      : undefined;

  const customName = [trace.generation_name, trace.trace_name].find(
    (name): name is string => typeof name === "string" && name.length > 0,
  );

  const usage = request.usage;
  const outputTokens = usage?.outputTokens;
  const interTokenLatency =
    request.ttftMs !== undefined &&
    request.generationMs !== undefined &&
    outputTokens !== undefined &&
    outputTokens >= 2
      ? request.generationMs / (outputTokens - 1)
      : undefined;

  const reservedTraceKeys: Record<string, true> = {
    trace_id: true,
    parent_span_id: true,
    trace_name: true,
    generation_name: true,
  };
  const traceMetadata = Object.entries(trace)
    .filter(([key, value]) => !(key in reservedTraceKeys) && value !== undefined && value !== null)
    .map(([key, value]) => attr(`trace.metadata.${key}`, metadataValue(value)));

  const lineageKind = request.lineage.kind;
  const attributes = compact([
    attr("gen_ai.operation.name", "chat"),
    attr("gen_ai.provider.name", request.provider),
    attr("gen_ai.request.model", request.model),
    attr("gen_ai.response.model", request.attempts.at(-1)?.providerModel ?? request.model),
    attr("gen_ai.response.id", request.providerGenerationId),
    attr(
      "gen_ai.response.finish_reasons",
      request.finishReason ? [request.finishReason] : undefined,
    ),
    attr("gen_ai.conversation.id", bundle.sessionKey),
    attr("gen_ai.conversation.compacted", lineageKind === "compacted" ? true : undefined),
    attr("gen_ai.request.temperature", firstNumber(params.temperature)),
    attr("gen_ai.request.top_p", firstNumber(params.top_p)),
    attr("gen_ai.request.top_k", firstNumber(params.top_k)),
    attr(
      "gen_ai.request.max_tokens",
      firstNumber(params.max_tokens, params.max_completion_tokens, params.max_output_tokens),
    ),
    attr("gen_ai.request.seed", firstNumber(params.seed)),
    attr("gen_ai.request.stop_sequences", stopSequences(params.stop)),
    attr("gen_ai.request.frequency_penalty", firstNumber(params.frequency_penalty)),
    attr("gen_ai.request.presence_penalty", firstNumber(params.presence_penalty)),
    attr("gen_ai.request.stream", request.stream),
    attr("gen_ai.request.reasoning.level", reasoningLevel(params)),
    attr("gen_ai.usage.input_tokens", usage?.inputTokens),
    attr("gen_ai.usage.output_tokens", usage?.outputTokens),
    attr("gen_ai.usage.cache_read.input_tokens", usage?.cacheReadTokens),
    attr("gen_ai.usage.cache_write.input_tokens", usage?.cacheWriteTokens),
    attr("gen_ai.usage.reasoning.output_tokens", usage?.reasoningTokens),
    doubleAttr(
      "gen_ai.response.time_to_first_chunk",
      request.ttftMs !== undefined ? request.ttftMs / 1000 : undefined,
    ),
    doubleAttr("radium.inter_token_latency_ms", interTokenLatency),
    attr("radium.request.id", request.requestId),
    attr("radium.source", request.source),
    attr("radium.lineage.kind", lineageKind),
    attr("radium.changes", changedFields(request.changes)),
    attr("radium.attempt.count", request.attempts.length),
    attr("error.type", request.status === "ok" ? undefined : request.status),
    ...traceMetadata,
  ]);

  if (!options.privacyMode) attributes.push(...contentAttributes(bundle));

  const rootStatus: OtlpSpan["status"] =
    request.status === "ok"
      ? { code: 1 }
      : { code: 2, message: request.error?.message ?? `Request ${request.status}` };

  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootSpanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: customName ?? `chat ${request.model}`,
      kind: 3,
      startTimeUnixNano: toNanos(request.startedAt),
      endTimeUnixNano: toNanos(request.endedAt),
      attributes,
      status: rootStatus,
    },
  ];

  for (const [index, attempt] of request.attempts.entries()) {
    const model = attempt.providerModel ?? request.model;
    spans.push({
      traceId,
      spanId: (await sha256Hex(`span\u0000${request.requestId}\u0000attempt\u0000${index}`)).slice(
        0,
        16,
      ),
      parentSpanId: rootSpanId,
      name: `chat ${model}`,
      kind: 3,
      startTimeUnixNano: toNanos(attempt.startedAt),
      endTimeUnixNano: toNanos(attempt.startedAt + attempt.durationMs),
      attributes: compact([
        attr("gen_ai.operation.name", "chat"),
        attr("gen_ai.provider.name", attempt.provider),
        attr("gen_ai.request.model", model),
        attr("http.response.status_code", attempt.status),
        attr(
          "error.type",
          attempt.outcome === "ok" ? undefined : (attempt.errorKind ?? attempt.outcome),
        ),
        attr("radium.request.id", request.requestId),
        attr("radium.attempt.index", index),
        attr("radium.attempt.outcome", attempt.outcome),
        attr("radium.credential.id", attempt.credential),
      ]),
      status:
        attempt.outcome === "ok"
          ? { code: 1 }
          : { code: 2, message: attempt.message ?? attempt.errorKind ?? attempt.outcome },
    });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: compact([attr("service.name", "radium-gateway")]) },
        scopeSpans: [{ scope: { name: "radium.gateway" }, spans }],
      },
    ],
  };
}

/** Opt-in content attributes; blobs recorded without content (redacted) are skipped. */
function contentAttributes(bundle: OtlpBundle): OtlpAttribute[] {
  const out: Array<OtlpAttribute | undefined> = [];

  const system = blobValue(bundle.system);
  if (Array.isArray(system) && system.length > 0) {
    const parts = system.flatMap((message) => contentParts(asRecord(message)?.content));
    out.push(attr("gen_ai.system_instructions", JSON.stringify(parts)));
  }

  const inputs = bundle.messages ?? [];
  if (inputs.length > 0 && inputs.every((node) => node.message.content !== undefined)) {
    const converted = inputs.map((node) => toGenAiMessage(blobValue(node.message)));
    out.push(attr("gen_ai.input.messages", JSON.stringify(converted)));
  }

  const output = blobValue(bundle.output?.message);
  if (output !== undefined) {
    out.push(
      attr(
        "gen_ai.output.messages",
        JSON.stringify([toGenAiMessage(output, bundle.request.finishReason ?? "")]),
      ),
    );
  }

  const tools = bundle.toolset ?? [];
  if (tools.length > 0 && tools.every((tool) => tool.content !== undefined)) {
    const definitions = tools.map((tool) => toToolDefinition(blobValue(tool)));
    out.push(attr("gen_ai.tool.definitions", JSON.stringify(definitions)));
  }

  return compact(out);
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Parse an export endpoint. Remote endpoints must use TLS; plaintext HTTP is allowed on
 * loopback only. Embedded credentials are rejected so they never reach destination listings.
 */
export function parseDestinationEndpoint(endpoint: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
  return url.protocol === "https:" || loopbackHttp ? url : undefined;
}

/** OTLP endpoints get `/v1/traces` appended unless present; webhooks are posted as configured. */
export function deliveryUrl(kind: "otlp" | "webhook", endpoint: string): string {
  const url = new URL(endpoint);
  const base = url.pathname.replace(/\/+$/, "");
  if (kind === "otlp" && !base.endsWith("/v1/traces")) url.pathname = `${base}/v1/traces`;
  return url.toString();
}
