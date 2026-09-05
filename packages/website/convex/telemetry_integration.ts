import { OpenTelemetry } from "@ai-sdk/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type {
  GenerateTextAbortEvent,
  GenerateTextEndEvent,
  GenerateTextStartEvent,
  GenerateTextStepEndEvent,
  GenerateTextStepStartEvent,
  InferTelemetryEvent,
  LanguageModelCallEndEvent,
  LanguageModelCallStartEvent,
  LanguageModelUsage,
  Telemetry,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "ai";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { GenericActionCtx } from "convex/server";

export type TelemetrySettings = {
  enabled: boolean;
  recordInputs: boolean;
  recordOutputs: boolean;
};

export type TelemetryRequestContext = {
  balance: Id<"balances">;
  key?: Id<"keys">;
  chatId?: Id<"aisdk_chats">;
  userId: string;
  requestId: string;
  settings: TelemetrySettings;
};

type CollectorOptions = TelemetryRequestContext & {
  ctx: GenericActionCtx<any>;
  source: "chatroom" | "gateway";
  functionId: string;
};

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type PendingSpan = {
  kind: "step" | "model" | "tool";
  name: string;
  status: "ok" | "error";
  startedAt: number;
  endedAt: number;
  durationMs: number;
  provider?: string;
  model?: string;
  stepNumber?: number;
  toolName?: string;
  toolCallId?: string;
  finishReason?: string;
  usage?: Usage;
  error?: string;
  inputJson?: string;
  outputJson?: string;
};

type TelemetryStartEvent = Parameters<NonNullable<Telemetry["onStart"]>>[0];
type TelemetryEndEvent = Parameters<NonNullable<Telemetry["onEnd"]>>[0];

const MAX_PAYLOAD_LENGTH = 32_000;
const MAX_SPANS = 100;
/** Build the local collector and, when configured, an OTLP integration for one request. */
export function createTelemetryIntegrations(options: CollectorOptions): Telemetry[] {
  const integrations: Telemetry[] = [new ConvexTelemetry(options)];
  const external = externalTelemetry(options.requestId, options.source);
  if (external) integrations.push(...external);
  return integrations;
}

class ConvexTelemetry implements Telemetry {
  private readonly startedAt = Date.now();
  private readonly stepStarts = new Map<number, number>();
  private readonly toolStarts = new Map<string, number>();
  private readonly spans: PendingSpan[] = [];
  private modelStartedAt: number | undefined;
  private traceId: Promise<Id<"telemetry_traces">> | undefined;
  private finalized = false;
  private toolCallCount = 0;

  constructor(private readonly options: CollectorOptions) {}

  onStart(event: TelemetryStartEvent) {
    if (event.operationId !== "ai.streamText") return;
    const textEvent = event as InferTelemetryEvent<GenerateTextStartEvent>;
    this.traceId = this.options.ctx.runMutation(internal.telemetry.startTrace, {
      balance: this.options.balance,
      key: this.options.key,
      userId: this.options.userId,
      chatId: this.options.chatId,
      source: this.options.source,
      requestId: this.options.requestId,
      callId: textEvent.callId,
      operationId: textEvent.operationId,
      functionId: textEvent.functionId ?? this.options.functionId,
      provider: textEvent.provider,
      model: textEvent.modelId,
      startedAt: this.startedAt,
      recordsInputs: this.options.settings.recordInputs,
      recordsOutputs: this.options.settings.recordOutputs,
      inputJson: this.options.settings.recordInputs
        ? safeJson({ instructions: textEvent.instructions, messages: textEvent.messages })
        : undefined,
    });
    return this.traceId.then(() => undefined);
  }

  onStepStart(event: InferTelemetryEvent<GenerateTextStepStartEvent>) {
    this.stepStarts.set(event.stepNumber, Date.now());
  }

  onStepEnd(event: InferTelemetryEvent<GenerateTextStepEndEvent>) {
    const endedAt = Date.now();
    const startedAt = this.stepStarts.get(event.stepNumber) ?? endedAt;
    this.insertSpan({
      kind: "step",
      name: `Step ${event.stepNumber + 1}`,
      status: "ok",
      startedAt,
      endedAt,
      provider: event.model.provider,
      model: event.model.modelId,
      stepNumber: event.stepNumber,
      finishReason: event.finishReason,
      usage: mapUsage(event.usage),
      outputJson: this.options.settings.recordOutputs ? safeJson(event.content) : undefined,
    });
  }

  onLanguageModelCallStart(event: InferTelemetryEvent<LanguageModelCallStartEvent>) {
    this.modelStartedAt = Date.now();
    if (this.options.settings.recordInputs) {
      this.modelInput = safeJson({ instructions: event.instructions, messages: event.messages });
    }
  }

  onLanguageModelCallEnd(event: InferTelemetryEvent<LanguageModelCallEndEvent>) {
    const endedAt = Date.now();
    const startedAt = this.modelStartedAt ?? endedAt - event.performance.responseTimeMs;
    this.insertSpan({
      kind: "model",
      name: `${event.provider} ${event.modelId}`,
      status: "ok",
      startedAt,
      endedAt,
      provider: event.provider,
      model: event.modelId,
      finishReason: event.finishReason,
      usage: mapUsage(event.usage),
      inputJson: this.modelInput,
      outputJson: this.options.settings.recordOutputs ? safeJson(event.content) : undefined,
    });
    this.modelStartedAt = undefined;
    this.modelInput = undefined;
  }

  onToolExecutionStart(event: InferTelemetryEvent<ToolExecutionStartEvent>) {
    this.toolCallCount++;
    this.toolStarts.set(event.toolCall.toolCallId, Date.now());
    if (this.options.settings.recordInputs) {
      this.toolInputs.set(event.toolCall.toolCallId, safeJson(event.toolCall.input));
    }
  }

  onToolExecutionEnd(event: InferTelemetryEvent<ToolExecutionEndEvent>) {
    const endedAt = Date.now();
    const startedAt = this.toolStarts.get(event.toolCall.toolCallId) ?? endedAt;
    const failed = event.toolOutput.type === "tool-error";
    this.insertSpan({
      kind: "tool",
      name: event.toolCall.toolName,
      status: failed ? "error" : "ok",
      startedAt,
      endedAt,
      toolName: event.toolCall.toolName,
      toolCallId: event.toolCall.toolCallId,
      error:
        failed && this.options.settings.recordOutputs
          ? errorMessage(event.toolOutput.error)
          : undefined,
      inputJson: this.toolInputs.get(event.toolCall.toolCallId),
      outputJson:
        this.options.settings.recordOutputs && !failed
          ? safeJson(event.toolOutput.output)
          : undefined,
    });
    this.toolStarts.delete(event.toolCall.toolCallId);
    this.toolInputs.delete(event.toolCall.toolCallId);
  }

  async onEnd(event: TelemetryEndEvent) {
    const textEvent = event as InferTelemetryEvent<GenerateTextEndEvent>;
    await this.finish({
      status: "ok",
      finishReason: textEvent.finishReason,
      usage: mapUsage(textEvent.usage),
      stepCount: textEvent.steps.length,
      outputJson: this.options.settings.recordOutputs
        ? safeJson({ content: textEvent.content, responseMessages: textEvent.responseMessages })
        : undefined,
    });
  }

  async onAbort(event: InferTelemetryEvent<GenerateTextAbortEvent>) {
    await this.finish({
      status: "aborted",
      stepCount: event.steps.length,
      error:
        this.options.settings.recordOutputs && event.reason !== undefined
          ? errorMessage(event.reason)
          : undefined,
    });
  }

  async onError(error: unknown) {
    await this.finish({
      status: "error",
      error: this.options.settings.recordOutputs ? errorMessage(error) : undefined,
    });
  }

  private modelInput: string | undefined;
  private readonly toolInputs = new Map<string, string | undefined>();

  private insertSpan(span: Omit<PendingSpan, "durationMs">) {
    this.spans.push({
      ...span,
      durationMs: Math.max(0, span.endedAt - span.startedAt),
    });
  }

  private async finish(fields: {
    status: "ok" | "error" | "aborted";
    finishReason?: string;
    usage?: Usage;
    stepCount?: number;
    error?: string;
    outputJson?: string;
  }) {
    if (this.finalized || !this.traceId) return;
    this.finalized = true;
    const endedAt = Date.now();
    await this.options.ctx.runMutation(internal.telemetry.finishTrace, {
      traceId: await this.traceId,
      spans: this.spans.slice(0, MAX_SPANS),
      ...fields,
      toolCallCount: this.toolCallCount,
      endedAt,
      durationMs: endedAt - this.startedAt,
    });
  }
}

let externalProvider: BasicTracerProvider | undefined;

function externalTelemetry(
  requestId: string,
  source: CollectorOptions["source"],
): Telemetry[] | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return undefined;
  }

  const endpoint = otlpTraceEndpoint();
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return undefined;
  }
  const isHttps = endpointUrl.protocol === "https:";
  const isLoopbackHttp =
    endpointUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(endpointUrl.hostname);
  if (!isHttps && !isLoopbackHttp) {
    return undefined;
  }

  externalProvider ??= new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "radium-gateway",
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        // The Node OTLP HTTP transport treats redirects as failures and never forwards the payload.
        new OTLPTraceExporter({
          url: endpoint,
          ...(isHttps ? { headers: otlpHeaders() } : {}),
        }),
      ),
    ],
  });

  return [
    new OpenTelemetry({
      tracer: externalProvider.getTracer("radium-gateway"),
      enrichSpan: () => ({ "radium.request.id": requestId, "radium.source": source }),
    }),
    {
      onEnd: () => externalProvider?.forceFlush(),
      onAbort: () => externalProvider?.forceFlush(),
      onError: () => externalProvider?.forceFlush(),
    },
  ];
}

function mapUsage(usage: LanguageModelUsage): Usage {
  return compact({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
  });
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function safeJson(value: unknown): string | undefined {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
    if (json === undefined) return undefined;
    return json.length > MAX_PAYLOAD_LENGTH ? truncateJson(json) : json;
  } catch {
    return "[Unserializable]";
  }
}

function truncateJson(json: string): string {
  const prefix = json.slice(0, MAX_PAYLOAD_LENGTH - 256);
  const commaPositions: number[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < prefix.length; index++) {
    const character = prefix[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === ",") commaPositions.push(index);
  }

  for (const candidate of [
    prefix,
    ...commaPositions.reverse().map((index) => prefix.slice(0, index)),
  ]) {
    const repaired = closeJsonPrefix(candidate);
    if (!repaired) continue;
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      // Try the previous complete field or array item.
    }
  }
  return JSON.stringify({ truncated: true });
}

function closeJsonPrefix(value: string): string | undefined {
  const stack: Array<"}" | "]"> = [];
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === "}" || character === "]") {
      if (stack.at(-1) !== character) return undefined;
      stack.pop();
    }
  }

  let repaired = value.trimEnd();
  if (inString) {
    repaired = repaired.replace(/\\u[\da-fA-F]{0,3}$/, "");
    if (repaired.endsWith("\\")) repaired = repaired.slice(0, -1);
    repaired += '…"';
  } else if (repaired.endsWith(":")) repaired += "null";
  else if (repaired.endsWith(",")) repaired = repaired.slice(0, -1);

  return repaired + stack.reverse().join("");
}

function errorMessage(error: unknown): string {
  const nestedError =
    typeof error === "object" && error !== null && "error" in error
      ? (error as { error: unknown }).error
      : error;
  const message =
    nestedError instanceof Error
      ? nestedError.message
      : typeof nestedError === "object" && nestedError !== null
        ? (safeJson(nestedError) ?? String(nestedError))
        : String(nestedError);
  return message.slice(0, 4_000);
}

function otlpTraceEndpoint(): string {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;
  return `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT!.replace(/\/$/, "")}/v1/traces`;
}

function otlpHeaders(): Record<string, string> {
  const value =
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!value) return {};

  return Object.fromEntries(
    value.split(",").flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) return [];
      try {
        return [
          [
            decodeURIComponent(entry.slice(0, separator).trim()),
            decodeURIComponent(entry.slice(separator + 1).trim()),
          ],
        ];
      } catch {
        return [];
      }
    }),
  );
}
