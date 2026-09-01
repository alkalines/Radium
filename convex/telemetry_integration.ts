import { OpenTelemetry } from "@ai-sdk/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type {
  GenerateTextStartEvent,
  GenerateTextStepEndEvent,
  GenerateTextStepStartEvent,
  InferTelemetryEvent,
  Telemetry,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "ai";
import type { GenericActionCtx } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export type TelemetrySettings = {
  enabled: boolean;
  recordInputs: boolean;
  recordOutputs: boolean;
};

export type TelemetryRequestContext = {
  correlationId: string;
  settings: TelemetrySettings;
  chatId?: Id<"aisdk_chats">;
};

type CollectorOptions = TelemetryRequestContext & {
  ctx: GenericActionCtx<any>;
  source: "chatroom" | "gateway";
  getCompletionIds?: () => Id<"chat_completions">[];
  onStepCollected?: (step: CompletionTelemetryContext) => void;
};

type PendingTool = {
  name: string;
  status: "ok" | "error";
  startedAt: number;
  endedAt: number;
  durationMs: number;
  toolCallId?: string;
  error?: string;
  inputJson?: string;
  outputJson?: string;
};

export type CompletionTelemetryContext = {
  stepNumber: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  inputJson?: string;
  outputJson?: string;
  tools: PendingTool[];
};

type TelemetryStartEvent = Parameters<NonNullable<Telemetry["onStart"]>>[0];
const MAX_PAYLOAD_LENGTH = 8_000;
const MAX_STORED_PAYLOAD_CHARS = 120_000;

/** Build AI SDK chat context collection and optional external OTLP export. */
export function createTelemetryIntegrations(options: CollectorOptions): Telemetry[] {
  const integrations: Telemetry[] = [new ConvexTelemetry(options)];
  const external = externalTelemetry(options.correlationId, options.source);
  if (external) integrations.push(...external);
  return integrations;
}

class ConvexTelemetry implements Telemetry {
  private readonly stepStarts = new Map<number, number>();
  private readonly toolStarts = new Map<string, { startedAt: number; stepNumber: number }>();
  private readonly toolInputs = new Map<string, string | undefined>();
  private readonly toolsByStep = new Map<number, PendingTool[]>();
  private readonly steps: CompletionTelemetryContext[] = [];
  private currentStep = 0;
  private rootInput: string | undefined;
  private finalized = false;

  constructor(private readonly options: CollectorOptions) {}

  onStart(event: TelemetryStartEvent) {
    if (event.operationId !== "ai.streamText" || !this.options.settings.recordInputs) return;
    const textEvent = event as InferTelemetryEvent<GenerateTextStartEvent>;
    this.rootInput = safeJson({
      instructions: textEvent.instructions,
      messages: textEvent.messages,
    });
  }

  onStepStart(event: InferTelemetryEvent<GenerateTextStepStartEvent>) {
    this.currentStep = event.stepNumber;
    this.stepStarts.set(event.stepNumber, Date.now());
  }

  onStepEnd(event: InferTelemetryEvent<GenerateTextStepEndEvent>) {
    const endedAt = Date.now();
    const startedAt = this.stepStarts.get(event.stepNumber) ?? endedAt;
    const step = {
      stepNumber: event.stepNumber,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      inputJson: event.stepNumber === 0 ? this.rootInput : undefined,
      outputJson: this.options.settings.recordOutputs ? safeJson(event.content) : undefined,
      tools: this.toolsByStep.get(event.stepNumber) ?? [],
    };
    this.steps.push(step);
    this.options.onStepCollected?.(fitStepPayloads(step));
  }

  onToolExecutionStart(event: InferTelemetryEvent<ToolExecutionStartEvent>) {
    this.toolStarts.set(event.toolCall.toolCallId, {
      startedAt: Date.now(),
      stepNumber: this.currentStep,
    });
    if (this.options.settings.recordInputs) {
      this.toolInputs.set(event.toolCall.toolCallId, safeJson(event.toolCall.input));
    }
  }

  onToolExecutionEnd(event: InferTelemetryEvent<ToolExecutionEndEvent>) {
    const endedAt = Date.now();
    const start = this.toolStarts.get(event.toolCall.toolCallId);
    const startedAt = start?.startedAt ?? endedAt;
    const stepNumber = start?.stepNumber ?? this.currentStep;
    const failed = event.toolOutput.type === "tool-error";
    const tools = this.toolsByStep.get(stepNumber) ?? [];
    tools.push({
      name: event.toolCall.toolName,
      status: failed ? "error" : "ok",
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
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
    this.toolsByStep.set(stepNumber, tools);
    this.toolStarts.delete(event.toolCall.toolCallId);
    this.toolInputs.delete(event.toolCall.toolCallId);
  }

  async onEnd() {
    await this.finish();
  }

  async onAbort() {
    await this.finish();
  }

  async onError() {
    await this.finish();
  }

  private async finish() {
    if (this.finalized || !this.options.chatId || !this.options.getCompletionIds) return;
    this.finalized = true;
    const completionIds = this.options.getCompletionIds();
    const contexts = completionIds.flatMap((completionId, index) => {
      const step = this.steps[index];
      return step
        ? [
            {
              completionId,
              telemetry: { chatId: this.options.chatId, ...fitStepPayloads(step) },
            },
          ]
        : [];
    });
    if (contexts.length === 0) return;
    await this.options.ctx.runMutation(internal.telemetry.attachChatSteps, {
      chatId: this.options.chatId,
      contexts,
    });
  }
}

function fitStepPayloads(step: CompletionTelemetryContext): CompletionTelemetryContext {
  let payloadChars = (step.inputJson?.length ?? 0) + (step.outputJson?.length ?? 0);
  return {
    ...step,
    tools: step.tools.map((tool) => {
      const size = (tool.inputJson?.length ?? 0) + (tool.outputJson?.length ?? 0);
      if (payloadChars + size > MAX_STORED_PAYLOAD_CHARS) {
        return { ...tool, inputJson: undefined, outputJson: undefined };
      }
      payloadChars += size;
      return tool;
    }),
  };
}

let externalProvider: BasicTracerProvider | undefined;

function externalTelemetry(
  correlationId: string,
  source: CollectorOptions["source"],
): Telemetry[] | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return undefined;
  }

  externalProvider ??= new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "radium-gateway",
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: otlpTraceEndpoint(),
          headers: otlpHeaders(),
        }),
      ),
    ],
  });

  return [
    new OpenTelemetry({
      tracer: externalProvider.getTracer("radium-gateway"),
      enrichSpan: () => ({ "radium.correlation.id": correlationId, "radium.source": source }),
    }),
    {
      onEnd: () => externalProvider?.forceFlush(),
      onAbort: () => externalProvider?.forceFlush(),
      onError: () => externalProvider?.forceFlush(),
    },
  ];
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
    return json.length > MAX_PAYLOAD_LENGTH ? `${json.slice(0, MAX_PAYLOAD_LENGTH)}...` : json;
  } catch {
    return "[Unserializable]";
  }
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
