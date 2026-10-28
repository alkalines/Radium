import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import type { CompletionOptions } from "../translators/openai";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
} from "../types/openai/types";

export type InternalModelSelection = {
  provider?: string;
  serviceTier?: string;
  inferenceMode?: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
};

type Dispatch = (
  request: ChatCompletions_RequestBody_Type,
  options: CompletionOptions,
  rawBody: unknown,
  signal: AbortSignal,
) => Promise<Response>;

/**
 * A trusted in-process SDK adapter. Original SDK prompts, provider metadata and tool
 * declarations reach the selected upstream without an OpenAI-compatible JSON round-trip.
 * The ordinary Gateway response is drained to settle routing, accounting and capture.
 */
export function createInternalModel(
  modelId: string,
  selection: InternalModelSelection,
  dispatch: Dispatch,
): LanguageModelV4 {
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "radium.gateway",
    modelId,
    supportedUrls: { "*/*": [/^https?:\/\//] },
    async doStream(call) {
      const abort = new AbortController();
      const signal = call.abortSignal
        ? AbortSignal.any([abort.signal, call.abortSignal])
        : abort.signal;
      const request = requestForCall(modelId, selection, call);
      let committed = false;
      let canceled = false;
      let pending: LanguageModelV4StreamPart[] = [];
      let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
      let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          const options: CompletionOptions = {
            internalCall: call,
            onModelStreamStart() {
              // A failed pre-output attempt must not leak its metadata into the winner.
              if (!committed) {
                pending = [];
                finish = undefined;
              }
            },
            onModelStreamPart(part) {
              if (canceled) return;
              // Settlement callbacks run after the provider finish event. Hold it until
              // response draining finishes so outer message metadata sees every cost fact.
              if (part.type === "finish") {
                finish = part;
              } else if (part.type !== "raw") {
                if (committed) controller.enqueue(part);
                else pending.push(part);
              }
            },
          };
          try {
            const response = await dispatch(
              request,
              options,
              {
                ...request,
                messages: call.prompt,
                tools: call.tools ?? [],
              },
              signal,
            );
            if (!response.ok) {
              const body: unknown = await response.json().catch(() => undefined);
              const message = gatewayErrorMessage(body);
              throw new Error(message ?? `Gateway request failed (${response.status}).`);
            }
            if (canceled) {
              await response.body?.cancel();
              return;
            }
            committed = true;
            for (const part of pending) controller.enqueue(part);
            pending = [];
            responseReader = response.body?.getReader();
            if (responseReader) {
              const decoder = new TextDecoder();
              let buffered = "";
              while (true) {
                const next = await responseReader.read();
                if (next.done) break;
                buffered += decoder.decode(next.value, { stream: true });
                let end: number;
                while ((end = buffered.indexOf("\n\n")) >= 0) {
                  const event = buffered.slice(0, end);
                  buffered = buffered.slice(end + 2);
                  const data = event
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                  if (!data || data === "[DONE]") continue;
                  let value: unknown;
                  try {
                    value = JSON.parse(data);
                  } catch {
                    continue;
                  }
                  const error = gatewayErrorMessage(value);
                  if (error) throw new Error(error);
                }
              }
            }
            if (canceled) return;
            if (!finish) throw new Error("Gateway upstream ended without a completion event.");
            controller.enqueue(finish);
            controller.close();
          } catch (error) {
            if (!canceled) controller.error(error);
          } finally {
            responseReader?.releaseLock();
          }
        },
        async cancel(reason) {
          canceled = true;
          abort.abort(reason);
          await responseReader?.cancel(reason);
        },
      });
      return { stream };
    },
    async doGenerate(call) {
      const { stream } = await model.doStream(call);
      return collectGeneration(stream);
    },
  };
  return model;
}

function requestForCall(
  model: string,
  selection: InternalModelSelection,
  call: LanguageModelV4CallOptions,
): ChatCompletions_RequestBody_Type {
  const tools: NonNullable<ChatCompletions_RequestBody_Type["tools"]> = [];
  for (const definition of call.tools ?? []) {
    if (definition.type === "function") {
      tools.push({
        type: "function",
        function: {
          name: definition.name,
          description: definition.description,
          parameters: definition.inputSchema,
          strict: definition.strict,
        },
      });
    } else if (definition.id === "openai.custom") {
      const args = definition.args;
      const format = args.format;
      tools.push({
        type: "custom",
        custom: {
          name: definition.name,
          description: typeof args.description === "string" ? args.description : undefined,
          ...(format &&
          typeof format === "object" &&
          !Array.isArray(format) &&
          "type" in format &&
          format.type === "grammar" &&
          "definition" in format &&
          typeof format.definition === "string" &&
          "syntax" in format &&
          (format.syntax === "regex" || format.syntax === "lark")
            ? {
                format: {
                  type: "grammar",
                  grammar: { definition: format.definition, syntax: format.syntax },
                },
              }
            : {}),
        },
      });
    }
  }
  const namedTool = call.toolChoice?.type === "tool" ? call.toolChoice.toolName : undefined;
  const custom =
    namedTool && tools.some((entry) => entry.type === "custom" && entry.custom.name === namedTool);
  return ChatCompletions_RequestBody.parse({
    model,
    messages: [],
    stream: true,
    provider: selection.provider,
    service_tier: selection.serviceTier,
    inference_mode: selection.inferenceMode,
    ...(selection.reasoningEffort || selection.reasoningBudget
      ? { reasoning: { effort: selection.reasoningEffort, max_tokens: selection.reasoningBudget } }
      : {}),
    max_completion_tokens: call.maxOutputTokens,
    temperature: call.temperature,
    top_p: call.topP,
    top_k: call.topK,
    presence_penalty: call.presencePenalty,
    frequency_penalty: call.frequencyPenalty,
    stop: call.stopSequences,
    seed: call.seed,
    tools,
    tool_choice: namedTool
      ? custom
        ? { type: "custom", custom: { name: namedTool } }
        : { type: "function", function: { name: namedTool } }
      : call.toolChoice?.type,
  });
}

async function collectGeneration(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4GenerateResult["content"] = [];
  const blocks = new Map<
    string,
    Extract<LanguageModelV4GenerateResult["content"][number], { type: "text" | "reasoning" }>
  >();
  let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
  let warnings: LanguageModelV4GenerateResult["warnings"] = [];
  let response: LanguageModelV4GenerateResult["response"];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value;
      switch (part.type) {
        case "stream-start":
          warnings = part.warnings;
          break;
        case "response-metadata":
          response = { id: part.id, modelId: part.modelId, timestamp: part.timestamp };
          break;
        case "text-start":
        case "reasoning-start": {
          const block = {
            type: part.type === "text-start" ? ("text" as const) : ("reasoning" as const),
            text: "",
            providerMetadata: part.providerMetadata,
          };
          blocks.set(part.id, block);
          content.push(block);
          break;
        }
        case "text-delta":
        case "reasoning-delta": {
          const block = blocks.get(part.id);
          if (block) {
            block.text += part.delta;
            if (part.providerMetadata)
              block.providerMetadata = { ...block.providerMetadata, ...part.providerMetadata };
          }
          break;
        }
        case "text-end":
        case "reasoning-end": {
          const block = blocks.get(part.id);
          if (block && part.providerMetadata)
            block.providerMetadata = { ...block.providerMetadata, ...part.providerMetadata };
          if (block?.type === "text" && part.type === "text-end" && part.citations)
            block.citations = part.citations;
          break;
        }
        case "finish":
          finish = part;
          break;
        case "error":
          throw part.error;
        case "tool-call":
        case "tool-result":
        case "tool-approval-request":
        case "file":
        case "reasoning-file":
        case "source":
        case "custom":
          content.push(part);
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!finish) throw new Error("Gateway upstream ended without a completion event.");
  return {
    content,
    warnings,
    response,
    usage: finish.usage,
    finishReason: finish.finishReason,
    providerMetadata: finish.providerMetadata,
  };
}

function gatewayErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  const error = value.error;
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined;
}
