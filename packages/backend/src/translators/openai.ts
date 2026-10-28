import {
  Output,
  jsonSchema,
  type ModelMessage,
  streamText,
  tool,
  toUIMessageStream,
  type UIMessageChunk,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import { openai } from "@ai-sdk/openai";
import * as z from "zod";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { completionUsage } from "../usage/completion";
import type { RoutedProvider } from "../routing/connector";
import { inferenceModeTier } from "../routing/selection";
import { convertStreamToAsyncIterator } from "../tools/chunkReader";
import { ReasoningDetail } from "../types/openai/messages_types";
import type {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "../types/openai/types";

const emptyGenerationUsage = {
  inputTokens: 0,
  inputTokenDetails: { cacheReadTokens: null, cacheWriteTokens: null },
  raw: undefined,
  outputTokens: 0,
  outputTokenDetails: { reasoningTokens: null },
};

/**
 * An upstream error reported inside the AI SDK stream. `outputStarted` is true once content
 * was produced, which makes the request unsafe to retry on another provider.
 */
export class CompletionStreamError extends Error {
  constructor(
    readonly upstreamError: unknown,
    readonly outputStarted: boolean,
  ) {
    super(upstreamError instanceof Error ? upstreamError.message : String(upstreamError));
    this.name = "CompletionStreamError";
  }
}

/** Keep the raw AI SDK error for routing while the UI stream carries only its message. */
function captureStreamError(onError: (error: unknown) => void) {
  return (error: unknown) => {
    onError(error);
    return error instanceof Error ? error.message : String(error);
  };
}

/** Invalid or unsupported Chat Completions semantics; safe to return as HTTP 400. */
export class CompletionRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "CompletionRequestError";
  }
}

function parseTools(request: ChatCompletions_RequestBody_Type, provider: RoutedProvider) {
  const tools: ToolSet = {};
  const choice = request.tool_choice;
  const allowed =
    typeof choice === "object" && choice.type === "allowed_tools"
      ? new Set(
          choice.allowed_tools.tools.map((entry) =>
            entry.type === "function" ? entry.function.name : entry.custom.name,
          ),
        )
      : undefined;
  for (const definition of request.tools ?? []) {
    const name = definition.type === "function" ? definition.function.name : definition.custom.name;
    if (allowed && !allowed.has(name)) continue;
    if (definition.type === "function") {
      tools[name] = tool({
        description: definition.function.description,
        inputSchema: jsonSchema(
          definition.function.parameters ?? { type: "object", properties: {} },
        ),
        ...(definition.function.strict !== undefined ? { strict: definition.function.strict } : {}),
        ...(definition.cache_control
          ? {
              providerOptions: {
                anthropic: { cacheControl: definition.cache_control },
                openrouter: { cacheControl: definition.cache_control },
              },
            }
          : {}),
      });
    } else {
      if (
        provider.info.npm !== "@ai-sdk/openai" &&
        provider.info.npm !== "@opencoredev/loginwithchatgpt-ai"
      ) {
        throw new CompletionRequestError("Custom tools require an OpenAI Responses provider.");
      }
      const format = definition.custom.format;
      tools[name] = openai.tools.customTool({
        description: definition.custom.description,
        format: format?.type === "grammar" ? { type: "grammar", ...format.grammar } : format,
      });
    }
  }
  if (allowed && [...allowed].some((name) => !(name in tools))) {
    throw new CompletionRequestError("allowed_tools must refer to declared tools.");
  }
  return tools;
}

function parseToolChoice(request: ChatCompletions_RequestBody_Type) {
  const choice = request.tool_choice;
  if (choice == null) return undefined;
  if (typeof choice === "string") {
    if (choice !== "auto" && choice !== "none" && choice !== "required") {
      throw new CompletionRequestError("Unsupported tool_choice.");
    }
    return choice;
  }
  if (choice.type === "allowed_tools") return choice.allowed_tools.mode;
  return {
    type: "tool" as const,
    toolName: choice.type === "function" ? choice.function.name : choice.custom.name,
  };
}

export function openAIToModelMessages(
  messages: ChatCompletions_RequestBody_Type["messages"],
): ModelMessage[] {
  const toolNamesByCallId = new Map<string, string>();

  return messages.flatMap<ModelMessage>((message) => {
    if (message.role === "developer" || message.role === "system") {
      if (typeof message.content === "string") return { role: "system", content: message.content };
      return message.content.map((part) => ({
        role: "system" as const,
        content: part.text,
        ...(part.cache_control
          ? {
              providerOptions: {
                anthropic: { cacheControl: part.cache_control },
                openrouter: { cacheControl: part.cache_control },
              },
            }
          : {}),
      }));
    }

    if (message.role === "user") {
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map(
                (
                  part,
                ): Extract<
                  Extract<ModelMessage, { role: "user" }>["content"],
                  unknown[]
                >[number] => {
                  if (part.type === "text" && "text" in part)
                    return {
                      type: "text" as const,
                      text: part.text,
                      ...(part.cache_control
                        ? {
                            providerOptions: {
                              anthropic: { cacheControl: part.cache_control },
                              openrouter: { cacheControl: part.cache_control },
                            },
                          }
                        : {}),
                    };
                  if ("image_url" in part)
                    return {
                      type: "image" as const,
                      image: new URL(part.image_url.url),
                      ...(part.image_url.detail
                        ? { providerOptions: { openai: { imageDetail: part.image_url.detail } } }
                        : {}),
                    };
                  if ("input_audio" in part)
                    return {
                      type: "file" as const,
                      data: part.input_audio.data,
                      mediaType: `audio/${part.input_audio.format}`,
                    };
                  if ("file" in part && part.file.file_data) {
                    const data = part.file.file_data;
                    const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
                    if (!match)
                      throw new CompletionRequestError("file_data must be a base64 data URL.");
                    return {
                      type: "file" as const,
                      data: match[2]!,
                      mediaType: match[1]!,
                      filename: part.file.filename,
                    };
                  }
                  throw new CompletionRequestError("Unsupported user content part or file ID.");
                },
              ),
      } satisfies ModelMessage;
    }

    if (message.role === "assistant") {
      const content: Array<
        Extract<Extract<ModelMessage, { role: "assistant" }>["content"], unknown[]>[number]
      > = [];
      const text = openAIContentToText(message.content);

      if (text) {
        content.push({ type: "text", text });
      }
      const details = message.reasoning_details;
      if (details?.length) {
        for (const detail of details) {
          const text =
            typeof detail.text === "string"
              ? detail.text
              : typeof detail.summary === "string"
                ? detail.summary
                : "";
          const metadata = detail.provider_metadata;
          const { provider_metadata: _extension, ...fields } = detail;
          const canonical = z.record(z.string(), z.json().optional()).parse(fields);
          const native: NonNullable<LanguageModelV4CallOptions["providerOptions"]> = {
            openrouter: { reasoning_details: [canonical] },
          };
          if (detail.format === "openai-responses-v1") {
            native.openai = {
              ...(detail.id ? { itemId: detail.id } : {}),
              ...(typeof detail.data === "string"
                ? { reasoningEncryptedContent: detail.data }
                : {}),
            };
          } else if (detail.format === "anthropic-claude-v1") {
            native.anthropic = {
              ...(typeof detail.data === "string" ? { redactedData: detail.data } : {}),
              ...(typeof detail.signature === "string" ? { signature: detail.signature } : {}),
            };
          }
          if (!text && detail.format === "openai-responses-v1" && detail.id) {
            const previous = content.findLast(
              (part) =>
                part.type === "reasoning" && part.providerOptions?.openai?.itemId === detail.id,
            );
            if (previous?.type === "reasoning" && previous.providerOptions) {
              previous.providerOptions.openai = {
                ...previous.providerOptions.openai,
                ...native.openai,
              };
              const routerDetails = previous.providerOptions.openrouter?.reasoning_details;
              previous.providerOptions.openrouter = {
                reasoning_details: [
                  ...(Array.isArray(routerDetails) ? routerDetails : []),
                  canonical,
                ],
              };
              continue;
            }
          }
          content.push({
            type: "reasoning",
            text,
            providerOptions: metadata
              ? {
                  ...native,
                  ...z.record(z.string(), z.record(z.string(), z.json())).parse(metadata),
                }
              : native,
          });
        }
      } else if (message.reasoning_content ?? message.reasoning) {
        content.push({
          type: "reasoning",
          text: (message.reasoning_content ?? message.reasoning)!,
        });
      }

      for (const toolCall of message.tool_calls ?? []) {
        const toolName = "function" in toolCall ? toolCall.function.name : toolCall.custom.name;
        const inputText =
          "function" in toolCall ? toolCall.function.arguments : toolCall.custom.input;

        toolNamesByCallId.set(toolCall.id, toolName);
        content.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName,
          input: "function" in toolCall ? parseToolInput(inputText) : inputText,
          ...(toolCall.provider_metadata ? { providerOptions: toolCall.provider_metadata } : {}),
        });
      }

      return {
        role: "assistant",
        content: content.length > 0 ? content : "",
      } satisfies ModelMessage;
    }

    if (message.role === "tool") {
      const toolCallId = message.tool_call_id;
      if (!toolCallId) {
        throw new Error("Tool messages must include a tool_call_id.");
      }

      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolNamesByCallId.get(toolCallId) ?? toolCallId,
            output: {
              type: "text",
              value: openAIContentToText(message.content),
            },
          },
        ],
      } satisfies ModelMessage;
    }

    const toolCallId = message.name;
    if (!toolCallId) {
      throw new Error("Function messages must include a name.");
    }

    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: toolCallId,
          output: {
            type: "text",
            value: openAIContentToText(message.content),
          },
        },
      ],
    } satisfies ModelMessage;
  });
}

function openAIContentToText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part) {
        return typeof part.text === "string" ? part.text : "";
      }
      throw new CompletionRequestError("Unsupported non-text content in this message.");
    })
    .join("");
}

function parseToolInput(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    throw new CompletionRequestError("Function tool arguments must be valid JSON.");
  }
}
/** Trusted internal adapter hooks. Never populate these from an external HTTP request. */
export type CompletionOptions = {
  internalCall?: LanguageModelV4CallOptions;
  onModelStreamStart?: () => void;
  onModelStreamPart?: (part: LanguageModelV4StreamPart) => void;
};
type RawFacts = { serviceTier?: string; cacheWrite1h?: number };

function getAISDKStream(
  reqData: ChatCompletions_RequestBody_Type,
  provider: RoutedProvider,
  abortSignal: AbortSignal,
  onProviderCall?: () => void,
  options?: CompletionOptions,
  rawFacts?: RawFacts,
): ReturnType<typeof streamText> {
  const parsedToolChoice = parseToolChoice(reqData);
  // The trusted internal prompt is already the provider's V4 prompt; middleware restores it
  // exactly after SDK setup so provider metadata and tool declarations remain untouched.
  const modelMessages = options?.internalCall
    ? (options.internalCall.prompt as unknown as ModelMessage[])
    : openAIToModelMessages(reqData.messages);
  const npm = provider.info.npm;
  const modeBody = provider.info.inferenceMode?.provider_body;
  const requestedTier = reqData.service_tier === "auto" ? undefined : reqData.service_tier;
  const modeTier = inferenceModeTier(modeBody);
  const effectiveTier = requestedTier ?? modeTier;
  const tier = effectiveTier === "fast" ? "priority" : effectiveTier;
  const modeHeaders =
    !requestedTier || tier === modeTier ? provider.info.inferenceMode?.provider_headers : undefined;
  if (
    modeBody?.reasoning &&
    npm !== "@ai-sdk/openai" &&
    npm !== "@opencoredev/loginwithchatgpt-ai"
  ) {
    throw new CompletionRequestError(
      "This connector does not support the selected reasoning mode.",
    );
  }
  if (reqData.n && reqData.n !== 1) throw new CompletionRequestError("Only n=1 is supported.");
  for (const key of [
    "audio",
    "modalities",
    "prediction",
    "logit_bias",
    "logprobs",
    "top_logprobs",
    "repetition_penalty",
    "min_p",
    "top_a",
    "plugins",
    "web_search_options",
    "functions",
    "function_call",
    "metadata",
    "safety_identifier",
    "verbosity",
  ] as const) {
    if (reqData[key] != null) throw new CompletionRequestError(`${key} is not supported.`);
  }
  if (reqData.store === true)
    throw new CompletionRequestError("Stored upstream responses are not supported.");
  if (reqData.stream_options?.include_obfuscation)
    throw new CompletionRequestError("Stream obfuscation is not supported.");
  if (
    reqData.response_format?.type === "json_schema" &&
    reqData.response_format.json_schema.strict === false
  ) {
    throw new CompletionRequestError("Non-strict JSON schema output is not supported.");
  }
  if (reqData.response_format?.type === "json_schema" && npm === "@ai-sdk/openai-compatible") {
    throw new CompletionRequestError(
      "This compatible connector cannot guarantee JSON schema output.",
    );
  }
  if (
    npm !== "@openrouter/ai-sdk-provider" &&
    npm !== "@ai-sdk/anthropic" &&
    (reqData.reasoning?.enabled != null || reqData.reasoning?.max_tokens != null)
  ) {
    throw new CompletionRequestError(
      "This provider does not support reasoning enabled or max_tokens.",
    );
  }
  if (
    npm === "@ai-sdk/openai-compatible" &&
    (reqData.reasoning_effort || reqData.reasoning?.effort)
  ) {
    throw new CompletionRequestError(
      "Reasoning effort is not supported by this compatible connector.",
    );
  }
  const explicitCaching =
    reqData.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => "cache_control" in part && part.cache_control),
    ) ||
    reqData.tools?.some((definition) => definition.type === "function" && definition.cache_control);
  if (npm !== "@openrouter/ai-sdk-provider" && npm !== "@ai-sdk/anthropic" && explicitCaching) {
    throw new CompletionRequestError(
      "Explicit cache directives are not supported by this provider.",
    );
  }
  const responsesProvider = npm === "@ai-sdk/openai" || npm === "@opencoredev/loginwithchatgpt-ai";
  if (
    responsesProvider &&
    (reqData.stop != null ||
      reqData.top_k != null ||
      reqData.seed != null ||
      reqData.frequency_penalty != null ||
      reqData.presence_penalty != null)
  ) {
    throw new CompletionRequestError(
      "OpenAI Responses does not support stop, top_k, seed, or frequency/presence penalties.",
    );
  }
  if (
    npm === "@ai-sdk/anthropic" &&
    (reqData.seed != null || reqData.frequency_penalty != null || reqData.presence_penalty != null)
  ) {
    throw new CompletionRequestError(
      "Anthropic does not support seed or frequency/presence penalties.",
    );
  }
  if (npm === "@ai-sdk/openai-compatible" && reqData.top_k != null)
    throw new CompletionRequestError("This compatible connector does not support top_k.");
  const settings = {
    parallelToolCalls: reqData.parallel_tool_calls,
    reasoning:
      reqData.reasoning_effort || reqData.reasoning
        ? {
            effort: reqData.reasoning?.effort ?? reqData.reasoning_effort,
            enabled: reqData.reasoning?.enabled ?? undefined,
            max_tokens: reqData.reasoning?.max_tokens ?? undefined,
          }
        : undefined,
    user: reqData.user,
    ...(npm === "@openrouter/ai-sdk-provider" && tier ? { extraBody: { service_tier: tier } } : {}),
  };
  const baseModel = provider.connector(provider.info.modelId, settings);
  if (typeof baseModel === "string")
    throw new CompletionRequestError("A routed provider must supply a concrete model.");
  const requestedFeatures = new Set<string>();
  const explicitSettings = {
    stopSequences: reqData.stop,
    topK: reqData.top_k,
    topP: reqData.top_p,
    temperature: reqData.temperature,
    seed: reqData.seed,
    presencePenalty: reqData.presence_penalty,
    frequencyPenalty: reqData.frequency_penalty,
    serviceTier: tier,
    reasoningEffort: reqData.reasoning?.effort ?? reqData.reasoning_effort,
    reasoningMode: modeBody?.reasoning?.mode,
    responseFormat: reqData.response_format?.type === "text" ? undefined : reqData.response_format,
  };
  for (const [name, value] of Object.entries(explicitSettings))
    if (value != null) requestedFeatures.add(name);
  for (const name of [
    "stopSequences",
    "topK",
    "topP",
    "temperature",
    "seed",
    "presencePenalty",
    "frequencyPenalty",
    "responseFormat",
  ] as const) {
    if (options?.internalCall?.[name] != null) requestedFeatures.add(name);
  }
  const model = wrapLanguageModel({
    model: baseModel,
    middleware: {
      specificationVersion: "v4",
      async transformParams({ params }) {
        if (!options?.internalCall) return params;
        const providerOptions = { ...options.internalCall.providerOptions };
        for (const [name, values] of Object.entries(params.providerOptions ?? {})) {
          providerOptions[name] = { ...providerOptions[name], ...values };
        }
        return {
          ...params,
          ...options.internalCall,
          abortSignal: params.abortSignal,
          headers: { ...options.internalCall.headers, ...params.headers },
          providerOptions,
        };
      },
      async wrapStream({ doStream }) {
        options?.onModelStreamStart?.();
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "stream-start") {
                  const unsupported = part.warnings.find(
                    (warning) =>
                      warning.type === "unsupported" && requestedFeatures.has(warning.feature),
                  );
                  if (unsupported?.type === "unsupported")
                    throw new CompletionRequestError(
                      unsupported.details ??
                        `Unsupported provider setting: ${unsupported.feature}.`,
                    );
                }
                options?.onModelStreamPart?.(part);
                if (
                  part.type === "raw" &&
                  rawFacts &&
                  part.rawValue &&
                  typeof part.rawValue === "object"
                ) {
                  const event = part.rawValue as Record<string, unknown>;
                  const message =
                    event.message && typeof event.message === "object"
                      ? (event.message as Record<string, unknown>)
                      : event.response && typeof event.response === "object"
                        ? (event.response as Record<string, unknown>)
                        : event;
                  const usage =
                    message.usage && typeof message.usage === "object"
                      ? (message.usage as Record<string, unknown>)
                      : {};
                  const tierValue = message.service_tier ?? usage.service_tier;
                  const speed = usage.speed;
                  if (npm === "@ai-sdk/anthropic") {
                    const creation = usage.cache_creation;
                    if (
                      creation &&
                      typeof creation === "object" &&
                      "ephemeral_1h_input_tokens" in creation &&
                      typeof creation.ephemeral_1h_input_tokens === "number"
                    )
                      rawFacts.cacheWrite1h = creation.ephemeral_1h_input_tokens;
                    if (speed === "fast") rawFacts.serviceTier = "priority";
                    else if (speed === "standard") rawFacts.serviceTier = "default";
                  } else if (typeof tierValue === "string") rawFacts.serviceTier = tierValue;
                }
                controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
  const openaiOptions = {
    store: false,
    reasoningSummary: "auto",
    ...(modeBody?.reasoning ? { reasoningMode: modeBody.reasoning.mode } : {}),
    ...(tier ? { serviceTier: tier === "fast" ? "priority" : tier } : {}),
    ...(reqData.reasoning_effort || reqData.reasoning?.effort
      ? { reasoningEffort: reqData.reasoning?.effort ?? reqData.reasoning_effort }
      : {}),
    ...(reqData.prompt_cache_key ? { promptCacheKey: reqData.prompt_cache_key } : {}),
    ...(reqData.parallel_tool_calls !== undefined
      ? { parallelToolCalls: reqData.parallel_tool_calls }
      : {}),
  };
  if (
    tier &&
    npm === "@ai-sdk/anthropic" &&
    tier !== "default" &&
    tier !== "priority" &&
    tier !== "fast"
  )
    throw new CompletionRequestError(`Anthropic does not support service tier ${tier}.`);
  if (
    tier &&
    npm === "@ai-sdk/openai-compatible" &&
    !provider.info.service_tiers?.some(
      (entry) => entry.id === tier || (tier === "priority" && entry.id === "fast"),
    )
  )
    throw new CompletionRequestError(
      "This compatible model does not advertise the requested service tier.",
    );
  return streamText({
    model,
    messages: modelMessages,
    // OpenAI-compatible clients intentionally control their own system and
    // developer messages through this authenticated API endpoint.
    allowSystemInMessages: true,
    abortSignal,
    headers: modeHeaders,
    maxOutputTokens: reqData.max_completion_tokens ?? reqData.max_tokens ?? undefined,
    stopSequences:
      reqData.stop == null
        ? undefined
        : Array.isArray(reqData.stop)
          ? reqData.stop
          : [reqData.stop],
    tools: parseTools(reqData, provider),
    toolChoice: parsedToolChoice,
    maxRetries: 0,
    ...(reqData.response_format?.type === "json_schema"
      ? {
          output: Output.object({
            schema: jsonSchema(reqData.response_format.json_schema.schema ?? {}),
            name: reqData.response_format.json_schema.name,
            description: reqData.response_format.json_schema.description,
          }),
        }
      : reqData.response_format?.type === "json_object"
        ? { output: Output.json() }
        : {}),
    providerOptions:
      npm === "@ai-sdk/openai" || npm === "@opencoredev/loginwithchatgpt-ai"
        ? { openai: openaiOptions }
        : npm === "@ai-sdk/anthropic"
          ? {
              anthropic: {
                ...(tier ? { speed: tier === "default" ? "standard" : "fast" } : {}),
                ...(reqData.reasoning?.max_tokens
                  ? { thinking: { type: "enabled", budgetTokens: reqData.reasoning.max_tokens } }
                  : reqData.reasoning?.enabled === false
                    ? { thinking: { type: "disabled" } }
                    : reqData.reasoning?.enabled === true
                      ? { thinking: { type: "adaptive" } }
                      : {}),
                ...(reqData.reasoning?.effort || reqData.reasoning_effort
                  ? {
                      effort:
                        (reqData.reasoning?.effort ?? reqData.reasoning_effort) === "minimal"
                          ? "low"
                          : (reqData.reasoning?.effort ?? reqData.reasoning_effort),
                    }
                  : {}),
              },
            }
          : npm === "@ai-sdk/openai-compatible" && tier
            ? {
                [provider.info.name.split(".")[0]?.trim() ?? provider.info.name]: {
                  service_tier: tier,
                },
              }
            : undefined,
    temperature: reqData.temperature,
    topP: reqData.top_p,
    includeRawChunks: true,
    topK: reqData.top_k,
    presencePenalty: reqData.presence_penalty ?? undefined,
    frequencyPenalty: reqData.frequency_penalty ?? undefined,
    seed: reqData.seed,
    onLanguageModelCallStart: onProviderCall,
  });
}

/** Called after a generation settles; timing values are milliseconds and callback failures are non-fatal. */
export type genCallbackType = (genCompletion: {
  genId?: string;
  usage: completionUsage;
  genTime: number;
  ttft: number;
  serviceTier?: string;
  reportedCost?: number;
  upstreamInferenceCost?: number;
  estimatedCost?: number;
  costSource?: "reported" | "estimated";
  provider?: string;
  model?: string;
  usageUnavailable?: boolean;
  cacheWriteTtlUnknown?: boolean;
}) => undefined | Promise<undefined>;
function finishReason(
  reason: string | undefined,
): "stop" | "length" | "content_filter" | "tool_calls" {
  if (reason === "length") return "length";
  if (reason === "content-filter") return "content_filter";
  if (reason === "tool-calls") return "tool_calls";
  return "stop";
}

async function settlementMetadata(result: ReturnType<typeof streamText>) {
  const metadata = await Promise.resolve(result.providerMetadata).catch(() => undefined);
  const openai = metadata?.openai;
  const router = metadata?.openrouter;
  const usage = router?.usage;
  const routerUsage =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : undefined;
  const costDetails = routerUsage?.costDetails;
  const costs =
    costDetails && typeof costDetails === "object" && !Array.isArray(costDetails)
      ? (costDetails as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof openai?.serviceTier === "string" ? { serviceTier: openai.serviceTier } : {}),
    ...(typeof routerUsage?.cost === "number" ? { reportedCost: routerUsage.cost } : {}),
    ...(typeof costs?.upstreamInferenceCost === "number"
      ? { upstreamInferenceCost: costs.upstreamInferenceCost }
      : {}),
  };
}
function cacheWriteFacts(
  request: ChatCompletions_RequestBody_Type,
  usage: { inputTokenDetails: { cacheWriteTokens?: number | null }; raw?: unknown },
  rawFacts: RawFacts,
) {
  const creation =
    usage.raw && typeof usage.raw === "object" && "cache_creation" in usage.raw
      ? usage.raw.cache_creation
      : undefined;
  const native1h =
    rawFacts.cacheWrite1h ??
    (creation &&
    typeof creation === "object" &&
    "ephemeral_1h_input_tokens" in creation &&
    typeof creation.ephemeral_1h_input_tokens === "number"
      ? creation.ephemeral_1h_input_tokens
      : undefined);
  const ttls = new Set<string>();
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if ("cache_control" in part && part.cache_control) ttls.add(part.cache_control.ttl ?? "5m");
    }
  }
  for (const definition of request.tools ?? []) {
    if (definition.type === "function" && definition.cache_control) {
      ttls.add(definition.cache_control.ttl ?? "5m");
    }
  }
  const oneHour =
    native1h ??
    (ttls.size === 1 && ttls.has("1h")
      ? (usage.inputTokenDetails.cacheWriteTokens ?? undefined)
      : undefined);
  return {
    oneHour,
    unknown:
      native1h === undefined &&
      ttls.size > 1 &&
      (usage.inputTokenDetails.cacheWriteTokens ?? 0) > 0,
  };
}
/** Convert SDK continuation metadata into OpenRouter reasoning details without treating ciphertext as text. */
function opaqueReasoningDetails(
  metadata: LanguageModelV4CallOptions["providerOptions"],
  id: string,
  index: number,
): Array<z.infer<typeof ReasoningDetail>> {
  if (!metadata) return [];
  const routerDetails = metadata.openrouter?.reasoning_details;
  if (Array.isArray(routerDetails)) {
    return routerDetails.flatMap((detail) => {
      const parsed = ReasoningDetail.safeParse(detail);
      return parsed.success ? [{ ...parsed.data, provider_metadata: metadata }] : [];
    });
  }
  const encrypted = metadata.openai?.reasoningEncryptedContent;
  const redacted = metadata.anthropic?.redactedData;
  const data =
    typeof encrypted === "string" ? encrypted : typeof redacted === "string" ? redacted : undefined;
  return data
    ? [
        {
          type: "reasoning.encrypted",
          id: typeof metadata.openai?.itemId === "string" ? metadata.openai.itemId : id,
          index,
          data,
          format: typeof encrypted === "string" ? "openai-responses-v1" : "anthropic-claude-v1",
          provider_metadata: metadata,
        },
      ]
    : [];
}

/**
 * Adapt an OpenAI-compatible request to completion chunks using the AI SDK.
 * The returned stream ends with `[DONE]`; the caller frames its chunks for the
 * transport. Usage callback settlement is idempotent across completion and cancellation.
 */
export async function StreamCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  provider: RoutedProvider,
  genCallback: genCallbackType,
  requestSignal?: AbortSignal | null,
  options?: CompletionOptions,
): Promise<ReadableStream<ChatCompletions_Streaming_Chunk_Type | string>> {
  const abort = new AbortController();
  const requestStartedAt = Date.now();
  let providerDispatched = false;
  const rawFacts: RawFacts = {};
  const result = await getAISDKStream(
    reqData,
    provider,
    requestSignal ? AbortSignal.any([abort.signal, requestSignal]) : abort.signal,
    () => {
      providerDispatched = true;
    },
    options,
    rawFacts,
  );

  // Cancellation and generator finalization can both settle usage; cache the
  // promise so persistence and the generation callback run at most once.
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;
  const markOutput = () => {
    const now = Date.now();
    firstTokenAt ??= now;
    lastTokenAt = now;
  };
  let completionSettlement: Promise<void> | undefined;
  let streamError: unknown;
  const endOfCompletion = () => {
    if (completionSettlement) return completionSettlement;

    const settlement = (async () => {
      // An attempt that failed before any output is retried elsewhere; record only the winner.
      if (streamError !== undefined && firstTokenAt === undefined) return;
      let usageUnavailable = false;
      const usage = await Promise.resolve(result.usage).catch(() => {
        // Some adapters reject usage after dispatch; retain the zero-usage fallback only then.
        if (!providerDispatched) return;
        usageUnavailable = true;
        return emptyGenerationUsage;
      });
      if (!usage) return;
      const cacheFacts = cacheWriteFacts(reqData, usage, rawFacts);

      try {
        await genCallback({
          genId: generationId,
          ...(!usageUnavailable ? await settlementMetadata(result) : {}),
          ...(rawFacts.serviceTier ? { serviceTier: rawFacts.serviceTier } : {}),
          usageUnavailable,
          cacheWriteTtlUnknown: cacheFacts.unknown,
          usage: {
            completion_tokens: usage.outputTokens || 0,
            completion_tokens_details: {
              reasoning_tokens: usage.outputTokenDetails.reasoningTokens ?? null,
            },
            prompt_tokens: usage.inputTokens || 0,
            prompt_tokens_details: {
              cached_tokens: usage.inputTokenDetails.cacheReadTokens ?? null,
              written_cache_tokens: usage.inputTokenDetails.cacheWriteTokens ?? null,
              ...(cacheFacts.oneHour !== undefined
                ? { written_cache_tokens_1h: cacheFacts.oneHour }
                : {}),
            },
          },
          genTime:
            firstTokenAt !== undefined && lastTokenAt !== undefined
              ? lastTokenAt - firstTokenAt
              : 0,
          ttft: firstTokenAt !== undefined ? firstTokenAt - requestStartedAt : 0,
        });
      } catch {
        // A generation callback failure must not fail the model response.
      }
    })();
    completionSettlement = settlement;
    return settlement;
  };

  const aiSdkResponse = toUIMessageStream({
    stream: result.stream,
    onError: captureStreamError((error) => {
      streamError = error;
    }),
  });
  const uiMessageChunks = (async function* () {
    try {
      yield* convertStreamToAsyncIterator<UIMessageChunk>(aiSdkResponse);
    } finally {
      await endOfCompletion();
    }
  })();
  const createdDateUnix = Math.floor(requestStartedAt / 1000);
  let generationId: string;
  let hasToolCalls = false;
  return new ReadableStream({
    async start(controller) {
      const writeOpenAIChunk = (response: ChatCompletions_Streaming_Chunk_Type) => {
        controller.enqueue(JSON.stringify(response));
      };

      const emittedToolCalls = new Set<string>();
      const timedToolCalls = new Set<string>();
      const toolIndexes = new Map<string, number>();
      const toolKinds = new Map<string, "function" | "custom">();
      const reasoningIndexes = new Map<string, number>();
      const emitDelta = (
        delta: ChatCompletions_Streaming_Chunk_Type["choices"][number]["delta"],
      ) => {
        writeOpenAIChunk({
          id: generationId || "not-available",
          created: createdDateUnix,
          model: reqData.model,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      };
      const customNames = new Set(
        (reqData.tools ?? [])
          .filter((entry) => entry.type === "custom")
          .map((entry) => entry.custom.name),
      );
      for await (const chunk of uiMessageChunks) {
        // https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
        switch (chunk.type) {
          case "error":
            throw new CompletionStreamError(
              streamError ?? new Error(chunk.errorText),
              firstTokenAt !== undefined,
            );
          case "reasoning-start":
          case "reasoning-delta":
          case "reasoning-end": {
            if (!generationId) generationId = chunk.id;
            let index = reasoningIndexes.get(chunk.id);
            if (index === undefined) {
              index = reasoningIndexes.size;
              reasoningIndexes.set(chunk.id, index);
            }
            const text =
              chunk.type === "reasoning-delta" && chunk.delta !== "[REDACTED]" ? chunk.delta : "";
            if (text) markOutput();
            const metadata = chunk.providerMetadata;
            const detail: z.infer<typeof ReasoningDetail> = {
              type:
                provider.info.npm === "@ai-sdk/openai" ||
                provider.info.npm === "@opencoredev/loginwithchatgpt-ai"
                  ? "reasoning.summary"
                  : "reasoning.text",
              id: chunk.id,
              index,
              ...(provider.info.npm === "@ai-sdk/openai" ||
              provider.info.npm === "@opencoredev/loginwithchatgpt-ai"
                ? {
                    format: "openai-responses-v1",
                    id:
                      typeof metadata?.openai?.itemId === "string"
                        ? metadata.openai.itemId
                        : chunk.id.replace(/:\d+$/, ""),
                  }
                : {}),
              ...(text && !reqData.reasoning?.exclude
                ? provider.info.npm === "@ai-sdk/openai" ||
                  provider.info.npm === "@opencoredev/loginwithchatgpt-ai"
                  ? { summary: text }
                  : { text }
                : {}),
              ...(typeof metadata?.anthropic?.signature === "string"
                ? { signature: metadata.anthropic.signature, format: "anthropic-claude-v1" }
                : {}),
              ...(metadata ? { provider_metadata: metadata } : {}),
            };
            const opaque =
              chunk.type === "reasoning-end"
                ? opaqueReasoningDetails(metadata, chunk.id, index).map((item) => {
                    if (item.type === "reasoning.encrypted") return item;
                    const { text: _text, summary: _summary, ...snapshot } = item;
                    return snapshot;
                  })
                : [];
            emitDelta({
              role: "assistant",
              content: "",
              ...(text && !reqData.reasoning?.exclude ? { reasoning: text } : {}),
              reasoning_details: [detail, ...opaque],
            });
            break;
          }
          case "tool-input-start": {
            hasToolCalls = true;
            emittedToolCalls.add(chunk.toolCallId);
            const index = toolIndexes.size;
            toolIndexes.set(chunk.toolCallId, index);
            const kind = customNames.has(chunk.toolName) ? "custom" : "function";
            toolKinds.set(chunk.toolCallId, kind);
            emitDelta({
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: chunk.toolCallId,
                  index,
                  type: kind,
                  ...(kind === "custom"
                    ? { custom: { name: chunk.toolName, input: "" } }
                    : { function: { name: chunk.toolName, arguments: "" } }),
                  ...(chunk.providerMetadata ? { provider_metadata: chunk.providerMetadata } : {}),
                },
              ],
            });
            break;
          }
          case "tool-input-delta": {
            if (chunk.inputTextDelta) {
              markOutput();
              timedToolCalls.add(chunk.toolCallId);
            }
            const index = toolIndexes.get(chunk.toolCallId);
            if (index === undefined)
              throw new CompletionStreamError(
                new Error("Tool input arrived before its start."),
                firstTokenAt !== undefined,
              );
            const kind = toolKinds.get(chunk.toolCallId) ?? "function";
            emitDelta({
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  index,
                  type: kind,
                  ...(kind === "custom"
                    ? { custom: { input: chunk.inputTextDelta } }
                    : { function: { arguments: chunk.inputTextDelta } }),
                },
              ],
            });
            break;
          }
          case "tool-input-available": {
            hasToolCalls = true;
            if (!timedToolCalls.has(chunk.toolCallId)) markOutput();
            if (!emittedToolCalls.has(chunk.toolCallId)) {
              const index = toolIndexes.size;
              toolIndexes.set(chunk.toolCallId, index);
              const kind = customNames.has(chunk.toolName) ? "custom" : "function";
              const input =
                kind === "custom" && typeof chunk.input === "string"
                  ? chunk.input
                  : JSON.stringify(chunk.input);
              emitDelta({
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: chunk.toolCallId,
                    index,
                    type: kind,
                    ...(kind === "custom"
                      ? { custom: { name: chunk.toolName, input } }
                      : { function: { name: chunk.toolName, arguments: input } }),
                    ...(chunk.providerMetadata
                      ? { provider_metadata: chunk.providerMetadata }
                      : {}),
                  },
                ],
              });
            } else if (chunk.providerMetadata) {
              const kind = toolKinds.get(chunk.toolCallId) ?? "function";
              emitDelta({
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    index: toolIndexes.get(chunk.toolCallId)!,
                    type: kind,
                    provider_metadata: chunk.providerMetadata,
                    ...(kind === "custom"
                      ? { custom: { input: "" } }
                      : { function: { arguments: "" } }),
                  },
                ],
              });
            }
            break;
          }
          case "text-delta":
            if (!generationId) generationId = chunk.id;
            if (chunk.delta) markOutput();
            writeOpenAIChunk({
              id: generationId || "not-available",
              created: createdDateUnix,
              model: reqData.model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: chunk.delta,
                  },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            });
            break;
          case "finish": {
            const metadata = { ...(await settlementMetadata(result)), ...rawFacts };
            writeOpenAIChunk({
              id: generationId || "not-available",
              created: createdDateUnix,
              model: reqData.model,
              object: "chat.completion.chunk",
              ...(metadata.serviceTier ? { service_tier: metadata.serviceTier } : {}),
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "" },
                  finish_reason: finishReason(chunk.finishReason),
                },
              ],
            });
            if (reqData.stream_options?.include_usage) {
              const usage = await result.usage;
              writeOpenAIChunk({
                id: generationId || "not-available",
                created: createdDateUnix,
                model: reqData.model,
                object: "chat.completion.chunk",
                choices: [],
                ...(metadata.serviceTier ? { service_tier: metadata.serviceTier } : {}),
                usage: {
                  prompt_tokens: usage.inputTokens ?? 0,
                  completion_tokens: usage.outputTokens ?? 0,
                  total_tokens: usage.totalTokens ?? 0,
                  completion_tokens_details: {
                    reasoning_tokens: usage.outputTokenDetails.reasoningTokens,
                  },
                  prompt_tokens_details: {
                    cached_tokens: usage.inputTokenDetails.cacheReadTokens,
                    cache_write_tokens: usage.inputTokenDetails.cacheWriteTokens,
                  },
                },
              });
            }
            break;
          }
        }
      }

      // End of the stream
      controller.enqueue("[DONE]");
      controller.close();
    },
    async cancel(reason?) {
      abort.abort(reason);
      await endOfCompletion();
    },
  });
}

/** Adapt an OpenAI-compatible request to a non-streaming completion response using the AI SDK. */
export async function NonStreamingCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  provider: RoutedProvider,
  genCallback: genCallbackType,
  requestSignal?: AbortSignal | null,
  options?: CompletionOptions,
): Promise<ChatCompletions_NotStreaming_ResponseBody_Type> {
  const abort = new AbortController();
  const requestStartedAt = Date.now();
  let providerDispatched = false;
  const rawFacts: RawFacts = {};
  const result = await getAISDKStream(
    reqData,
    provider,
    requestSignal ? AbortSignal.any([abort.signal, requestSignal]) : abort.signal,
    () => {
      providerDispatched = true;
    },
    options,
    rawFacts,
  );

  // Keep settlement idempotent because generator cleanup can happen on both
  // normal completion and cancellation.
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;
  const markOutput = () => {
    const now = Date.now();
    firstTokenAt ??= now;
    lastTokenAt = now;
  };
  let completionSettlement: Promise<void> | undefined;
  let streamError: unknown;
  const endOfCompletion = () => {
    if (completionSettlement) return completionSettlement;

    const settlement = (async () => {
      // An attempt that failed before any output is retried elsewhere; record only the winner.
      if (streamError !== undefined && firstTokenAt === undefined) return;
      let usageUnavailable = false;
      const usage = await Promise.resolve(result.usage).catch(() => {
        // Some adapters reject usage after dispatch; retain the zero-usage fallback only then.
        if (!providerDispatched) return;
        usageUnavailable = true;
        return emptyGenerationUsage;
      });
      if (!usage) return;
      const cacheFacts = cacheWriteFacts(reqData, usage, rawFacts);

      try {
        await genCallback({
          genId: openAIResponse.id || undefined,
          ...(!usageUnavailable ? await settlementMetadata(result) : {}),
          ...(rawFacts.serviceTier ? { serviceTier: rawFacts.serviceTier } : {}),
          usageUnavailable,
          cacheWriteTtlUnknown: cacheFacts.unknown,
          usage: {
            completion_tokens: usage.outputTokens || 0,
            completion_tokens_details: {
              reasoning_tokens: usage.outputTokenDetails.reasoningTokens ?? null,
            },
            prompt_tokens: usage.inputTokens || 0,
            prompt_tokens_details: {
              cached_tokens: usage.inputTokenDetails.cacheReadTokens ?? null,
              written_cache_tokens: usage.inputTokenDetails.cacheWriteTokens ?? null,
              ...(cacheFacts.oneHour !== undefined
                ? { written_cache_tokens_1h: cacheFacts.oneHour }
                : {}),
            },
          },
          genTime:
            firstTokenAt !== undefined && lastTokenAt !== undefined
              ? lastTokenAt - firstTokenAt
              : 0,
          ttft: firstTokenAt !== undefined ? firstTokenAt - requestStartedAt : 0,
        });
      } catch {
        // A generation callback failure must not fail the model response.
      }
    })();
    completionSettlement = settlement;
    return settlement;
  };

  const aiSdkResponse = toUIMessageStream({
    stream: result.stream,
    onError: captureStreamError((error) => {
      streamError = error;
    }),
  });
  const uiMessageChunks = (async function* () {
    try {
      yield* convertStreamToAsyncIterator<UIMessageChunk>(aiSdkResponse);
    } finally {
      await endOfCompletion();
    }
  })();

  const createdDateUnix = Math.floor(requestStartedAt / 1000);

  const openAIResponse: ChatCompletions_NotStreaming_ResponseBody_Type = {
    created: createdDateUnix,
    model: reqData.model,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: null,
        message: {
          content: null,
          role: "assistant",
          reasoning: null,
        },
      },
    ],
    id: "",
    usage: {},
  };
  const choice = openAIResponse.choices[0]!;
  const reasoningParts = new Map<string, z.infer<typeof ReasoningDetail>>();
  const customNames = new Set(
    (reqData.tools ?? [])
      .filter((entry) => entry.type === "custom")
      .map((entry) => entry.custom.name),
  );

  for await (const chunk of uiMessageChunks) {
    // https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
    switch (chunk.type) {
      case "error":
        throw new CompletionStreamError(
          streamError ?? new Error(chunk.errorText),
          firstTokenAt !== undefined,
        );
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end": {
        if (!openAIResponse.id) openAIResponse.id = chunk.id;
        let detail = reasoningParts.get(chunk.id);
        if (!detail) {
          detail =
            provider.info.npm === "@ai-sdk/openai" ||
            provider.info.npm === "@opencoredev/loginwithchatgpt-ai"
              ? { type: "reasoning.summary", id: chunk.id, index: reasoningParts.size, summary: "" }
              : { type: "reasoning.text", id: chunk.id, index: reasoningParts.size, text: "" };
          reasoningParts.set(chunk.id, detail);
          if (detail.type === "reasoning.summary") {
            detail.format = "openai-responses-v1";
            detail.id =
              typeof chunk.providerMetadata?.openai?.itemId === "string"
                ? chunk.providerMetadata.openai.itemId
                : chunk.id.replace(/:\d+$/, "");
          }
        }
        if (chunk.providerMetadata) detail.provider_metadata = chunk.providerMetadata;
        if (typeof chunk.providerMetadata?.anthropic?.signature === "string") {
          detail.signature = chunk.providerMetadata.anthropic.signature;
          detail.format = "anthropic-claude-v1";
        }
        if (chunk.type === "reasoning-delta" && chunk.delta !== "[REDACTED]") {
          if (chunk.delta) markOutput();
          if (!reqData.reasoning?.exclude) {
            const field = detail.type === "reasoning.summary" ? "summary" : "text";
            detail[field] = String(detail[field] ?? "") + chunk.delta;
            choice.message.reasoning = (choice.message.reasoning ?? "") + chunk.delta;
          }
        }
        const opaque =
          chunk.type === "reasoning-end"
            ? opaqueReasoningDetails(chunk.providerMetadata, chunk.id, Number(detail.index))
            : [];
        for (const part of opaque)
          reasoningParts.set(`${chunk.id}:opaque:${reasoningParts.size}`, part);
        choice.message.reasoning_details = [...reasoningParts.values()];
        break;
      }
      case "text-start":
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        choice.message.content ??= "";
        break;
      case "text-delta":
        if (chunk.delta) markOutput();
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        choice.message.content = (choice.message.content ?? "") + chunk.delta;
        break;
      case "tool-input-available": {
        markOutput();
        const calls = (choice.message.tool_calls ??= []);
        if (customNames.has(chunk.toolName)) {
          if (typeof chunk.input !== "string")
            throw new CompletionStreamError(new Error("Custom tool input must be a string."), true);
          calls.push({
            type: "custom",
            id: chunk.toolCallId,
            custom: { name: chunk.toolName, input: chunk.input },
            ...(chunk.providerMetadata ? { provider_metadata: chunk.providerMetadata } : {}),
          });
        } else {
          calls.push({
            type: "function",
            id: chunk.toolCallId,
            function: { name: chunk.toolName, arguments: JSON.stringify(chunk.input) },
            ...(chunk.providerMetadata ? { provider_metadata: chunk.providerMetadata } : {}),
          });
        }
        break;
      }
      case "finish": {
        const generationUsage = await result.usage;
        choice.finish_reason = finishReason(chunk.finishReason);
        const metadata = { ...(await settlementMetadata(result)), ...rawFacts };
        if (metadata.serviceTier) openAIResponse.service_tier = metadata.serviceTier;

        openAIResponse.usage = {
          completion_tokens: generationUsage.outputTokens || 0,
          completion_tokens_details: {
            reasoning_tokens: generationUsage.outputTokenDetails.reasoningTokens,
          },
          prompt_tokens: generationUsage.inputTokens || 0,
          prompt_tokens_details: {
            cached_tokens: generationUsage.inputTokenDetails.cacheReadTokens,
            cache_write_tokens: generationUsage.inputTokenDetails.cacheWriteTokens,
          },
          total_tokens: generationUsage.totalTokens || 0,
        };
        break;
      }
    }
  }

  return openAIResponse!;
}
