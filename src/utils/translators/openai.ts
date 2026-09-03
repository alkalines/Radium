import {
  jsonSchema,
  type ModelMessage,
  streamText,
  type TelemetryOptions,
  tool,
  toUIMessageStream,
  type UIMessageChunk,
} from "ai";
import z from "zod";
import { completionUsage } from "../../../convex/key";
import AIBalancer from "../ai_balancer";
import { convertStreamToAsyncIterator } from "../tools/chunkReader";
import { ToolsSchema } from "../types/openai/tools";
import {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "../types/openai/types";

const emptyGenerationUsage = {
  inputTokens: 0,
  inputTokenDetails: { cacheReadTokens: null },
  outputTokens: 0,
  outputTokenDetails: { reasoningTokens: null },
};

function toolsParsing(reqData: ChatCompletions_RequestBody_Type) {
  let object: Record<string, any> = {};
  const rawTools = reqData.tools as ToolsSchema[];

  rawTools?.forEach((rawTool) => {
    if (rawTool.type === "function") {
      const toolInfo = rawTool.function;

      object[toolInfo.name] = tool({
        description: toolInfo.description,
        inputSchema: jsonSchema(toolInfo.parameters ?? { type: "object", properties: {} }),
        /**
         * Strict is non existent on the AISDK
         * @comment i don't know why.
         */
      });
    } else {
      const toolInfo = rawTool.custom;
      /**
       * @todo [dynamicTools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#dynamic-tools)
       */
      // Map "custom" tools to a simple string-input tool so the model can call them.
      // If a grammar is provided, we still accept string input; the provider enforces the grammar.
      const inputSchema =
        toolInfo?.format?.type === "grammar"
          ? z.object({ input: z.string() })
          : z.object({ input: z.string() });

      object[toolInfo.name] = tool({
        description: toolInfo.description,
        inputSchema,
      });
    }
  });

  return object;
}

function toolChoiceParse(reqData: ChatCompletions_RequestBody_Type) {
  const tc = reqData.tool_choice as any;
  if (tc == null) return;

  if (typeof tc === "string") return tc;

  if (tc.type === "function" && tc.function?.name)
    return { type: "tool", toolName: tc.function.name } as any;

  if (tc.type === "custom" && tc.custom?.name)
    return { type: "tool", toolName: tc.custom.name } as any;

  if (tc.type === "allowed_tools")
    return tc.allowed_tools?.mode === "required" ? "required" : "auto";

  // Unknown shape → fall back to default
  return undefined;
}

function openAIToModelMessages(
  messages: ChatCompletions_RequestBody_Type["messages"],
): ModelMessage[] {
  const toolNamesByCallId = new Map<string, string>();

  return messages.map<ModelMessage>((message) => {
    if (message.role === "developer" || message.role === "system") {
      return {
        role: "system",
        content: openAIContentToText(message.content),
      } satisfies ModelMessage;
    }

    if (message.role === "user") {
      return {
        role: "user",
        content: openAIContentToText(message.content),
      } satisfies ModelMessage;
    }

    if (message.role === "assistant") {
      const content: any[] = [];
      const text = openAIContentToText(message.content);

      if (text) {
        content.push({ type: "text", text });
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
          input: parseToolInput(inputText),
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

      return JSON.stringify(part);
    })
    .join("");
}

function parseToolInput(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return { input };
  }
}

function getAISDKStream(
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  abortSignal: AbortSignal,
  telemetry?: TelemetryOptions,
  onProviderCall?: () => void,
): ReturnType<typeof streamText> {
  const parsedToolChoice = toolChoiceParse(reqData);
  const modelMessages = openAIToModelMessages(reqData.messages);
  /**
   * @todo Reasoning parameter, and provider specific options
   */
  return streamText({
    model: provider.connector(provider.info.modelId, {
      logitBias: reqData.logit_bias,
      /**
       * @todo OpenRouter have this option currently bugged
       */
      //logprobs: reqData.logprobs ?? false,
      parallelToolCalls: reqData.parallel_tool_calls,
      plugins: reqData.plugins,
      reasoning:
        reqData.reasoning_effort || reqData.reasoning
          ? {
              effort: reqData.reasoning?.effort ?? reqData.reasoning_effort,
              enabled: reqData.reasoning?.enabled ?? undefined,
              max_tokens: reqData.reasoning?.max_tokens ?? undefined,
            }
          : undefined,
      /**
       * @todo
       */
      //web_search_options: reqData.web_search_options
      user: reqData.prompt_cache_key || reqData.user,
    }),
    messages: modelMessages,
    // OpenAI-compatible clients intentionally control their own system and
    // developer messages through this authenticated API endpoint.
    allowSystemInMessages: true,
    abortSignal,
    maxOutputTokens: reqData.max_completion_tokens ?? undefined,
    tools: toolsParsing(reqData) as any,
    toolChoice: parsedToolChoice,
    maxRetries: parseInt(process.env.AISDK_MaxRetries ?? "0"),
    temperature: reqData.temperature,
    topP: reqData.top_p,
    topK: reqData.top_k,
    presencePenalty: reqData.presence_penalty ?? undefined,
    frequencyPenalty: reqData.frequency_penalty ?? undefined,
    seed: reqData.seed,
    telemetry,
    onLanguageModelCallStart: onProviderCall,
  });
}

export type genCallbackType = (genCompletion: {
  genId?: string;
  usage: completionUsage;
  genTime: number;
  ttft: number;
}) => undefined | Promise<undefined>;

/**
 * Transform an OpenAI-Compatible request into a OpenAI-Compatible streamed response using the AISDK as an middleware
 * @param reqData OpenAI Compatible Request data
 * @param provider Provider message connector
 * @returns An Readable Stream of Chunks
 */
export async function StreamCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  genCallback: genCallbackType,
  telemetry?: TelemetryOptions,
  requestSignal?: AbortSignal | null,
): Promise<ReadableStream<ChatCompletions_Streaming_Chunk_Type | string>> {
  const abort = new AbortController();
  const requestStartedAt = Date.now();
  let providerDispatched = false;
  const result = await getAISDKStream(
    reqData,
    provider,
    requestSignal ? AbortSignal.any([abort.signal, requestSignal]) : abort.signal,
    telemetry,
    () => {
      providerDispatched = true;
    },
  );

  // Usage Callback
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;
  const markOutput = () => {
    const now = Date.now();
    firstTokenAt ??= now;
    lastTokenAt = now;
  };
  let completionSettlement: Promise<void> | undefined;
  const endOfCompletion = () => {
    if (completionSettlement) return completionSettlement;

    const settlement = (async () => {
      const r = await Promise.resolve(result.usage).catch(() => {
        if (!providerDispatched) return;
        return emptyGenerationUsage;
      });
      if (!r) return;

      try {
        await genCallback({
          genId: genID,
          usage: {
            completion_tokens: r.outputTokens || 0,
            completion_tokens_details: {
              reasoning_tokens: r.outputTokenDetails.reasoningTokens ?? null,
            },
            prompt_tokens: r.inputTokens || 0,
            prompt_tokens_details: {
              cached_tokens: r.inputTokenDetails.cacheReadTokens ?? null,
              // @todo: written_cache_tokens
            },
          },
          genTime:
            firstTokenAt !== undefined && lastTokenAt !== undefined
              ? lastTokenAt - firstTokenAt
              : 0,
          ttft: firstTokenAt !== undefined ? firstTokenAt - requestStartedAt : 0,
        });
      } catch (e) {}
    })();
    completionSettlement = settlement;
    return settlement;
  };

  // Transform to OpenAI Stream
  const aisdk_response = toUIMessageStream({ stream: result.stream });
  const chunkLoadStream = (async function* () {
    try {
      yield* convertStreamToAsyncIterator<UIMessageChunk>(aisdk_response);
    } finally {
      await endOfCompletion();
    }
  })();
  const createdDateUnix = Math.floor(requestStartedAt / 1000);
  let genID: string;
  let finishReasons = {
    toolCalls: false,
    text: false,
    max_tokens: false,
  };
  return new ReadableStream({
    async start(controller) {
      const controllerOutput = (text: string) => controller.enqueue(text);
      const openaiOutput = (response: ChatCompletions_Streaming_Chunk_Type) => {
        controllerOutput(JSON.stringify(response));
      };

      const emittedToolCalls = new Set<string>();
      const timedToolCalls = new Set<string>();
      for await (const chunk of chunkLoadStream) {
        // https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
        switch (chunk.type) {
          case "reasoning-start":
            if (!genID) genID = chunk.id;

            if (!reqData.reasoning?.exclude) {
              openaiOutput({
                id: genID || "not-available",
                created: createdDateUnix,
                model: reqData.model, // @todo Not fuck everything in case of routers
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "" },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              });
            }
            break;
          case "reasoning-delta":
            if (!genID) genID = chunk.id;
            if (chunk.delta === "[REDACTED]") break;
            if (chunk.delta) markOutput();
            if (!reqData.reasoning?.exclude) {
              openaiOutput({
                id: genID || "not-available",
                created: createdDateUnix,
                model: reqData.model, // @todo Not fuck everything in case of routers
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: "",
                      reasoning: chunk.delta,
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              });
            }
            break;
          case "reasoning-end":
            if (!genID) genID = chunk.id;

            if (!reqData.reasoning?.exclude) {
              openaiOutput({
                id: genID || "not-available",
                created: createdDateUnix,
                model: reqData.model, // @todo Not fuck everything in case of routers
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: "",
                      reasoning: null,
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              });
            }
            break;
          case "tool-input-start":
            emittedToolCalls.add(chunk.toolCallId);
            finishReasons.toolCalls = true;
            openaiOutput({
              id: genID || "not-available",
              created: createdDateUnix,
              model: reqData.model, // @todo Not fuck everything in case of routers
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: chunk.toolCallId,
                        index: 0,
                        type: "function", // @todo dynamicTools - According with OpenAI docs only function is currently supported.
                        function: {
                          name: chunk.toolName,
                          arguments: "",
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            });
            break;
          case "tool-input-delta":
            if (chunk.inputTextDelta) {
              markOutput();
              timedToolCalls.add(chunk.toolCallId);
            }
            openaiOutput({
              id: genID || "not-available",
              created: createdDateUnix,
              model: reqData.model, // @todo Not fuck everything in case of routers
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        index: 0,
                        type: "function", // @todo dynamicTools - According with OpenAI docs only function is currently supported.
                        function: {
                          arguments: chunk.inputTextDelta,
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            });
            break;
          case "tool-input-available":
            finishReasons.toolCalls = true;
            if (!timedToolCalls.has(chunk.toolCallId)) markOutput();
            if (!emittedToolCalls.has(chunk.toolCallId)) {
              emittedToolCalls.add(chunk.toolCallId);
              openaiOutput({
                id: genID || "not-available",
                created: createdDateUnix,
                model: reqData.model, // @todo Not fuck everything in case of routers
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: "",
                      tool_calls: [
                        {
                          id: chunk.toolCallId,
                          index: 0,
                          type: "function", // @todo dynamicTools - According with OpenAI docs only function is currently supported.
                          function: {
                            name: chunk.toolName,
                            arguments:
                              typeof chunk.input === "string"
                                ? chunk.input
                                : JSON.stringify(chunk.input),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              });
            }

            openaiOutput({
              id: genID || "not-available",
              created: createdDateUnix,
              model: reqData.model, // @todo Not fuck everything in case of routers
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "",
                  },
                  finish_reason: "tool_calls",
                  logprobs: null,
                },
              ],
            });
            break;
          case "text-delta":
            if (!genID) genID = chunk.id;
            if (chunk.delta) markOutput();
            openaiOutput({
              id: genID || "not-available",
              created: createdDateUnix,
              model: reqData.model, // @todo Not fuck everything in case of routers
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
            let finishReason = "stop";
            if (
              (reqData.max_tokens || reqData.max_completion_tokens) ===
              (await result.usage).outputTokens
            ) {
              finishReason = "length";
            } else if (finishReasons.toolCalls) {
              finishReason = "tool_calls";
            }

            openaiOutput({
              id: genID || "not-available",
              created: createdDateUnix,
              model: reqData.model, // @todo Not fuck everything in case of routers
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "",
                  },
                  finish_reason: finishReason as any,
                  logprobs: null,
                },
              ],
              usage: {
                prompt_tokens: (await result.usage).inputTokens || 0,
                completion_tokens: (await result.usage).outputTokens || 0,
                total_tokens: (await result.usage).totalTokens || 0,
                completion_tokens_details: {
                  reasoning_tokens: (await result.usage).outputTokenDetails.reasoningTokens,
                },
                prompt_tokens_details: {
                  cached_tokens: (await result.usage).inputTokenDetails.cacheReadTokens,
                },
              },
            });
            break;
          }
        }
      }

      // End of the stream
      controllerOutput("[DONE]");
      controller.close();
    },
    async cancel(reason?) {
      abort.abort(reason);
      await endOfCompletion();
    },
  });
}

/**
 * Transform an OpenAI-Compatible request into a OpenAI-Compatible standard response using the AISDK as an middleware
 * @param reqData OpenAI Compatible Request data
 * @param provider Provider message connector
 * @returns An Object with an ready response
 */
export async function NonStreamingCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  genCallback: genCallbackType,
  telemetry?: TelemetryOptions,
  requestSignal?: AbortSignal | null,
): Promise<ChatCompletions_NotStreaming_ResponseBody_Type> {
  const abort = new AbortController();
  const requestStartedAt = Date.now();
  let providerDispatched = false;
  const result = await getAISDKStream(
    reqData,
    provider,
    requestSignal ? AbortSignal.any([abort.signal, requestSignal]) : abort.signal,
    telemetry,
    () => {
      providerDispatched = true;
    },
  );

  // Usage Callback
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;
  const markOutput = () => {
    const now = Date.now();
    firstTokenAt ??= now;
    lastTokenAt = now;
  };
  let completionSettlement: Promise<void> | undefined;
  const endOfCompletion = () => {
    if (completionSettlement) return completionSettlement;

    const settlement = (async () => {
      const r = await Promise.resolve(result.usage).catch(() => {
        if (!providerDispatched) return;
        return emptyGenerationUsage;
      });
      if (!r) return;

      try {
        await genCallback({
          genId: openAIResponse.id || undefined,
          usage: {
            completion_tokens: r.outputTokens || 0,
            completion_tokens_details: {
              reasoning_tokens: r.outputTokenDetails.reasoningTokens ?? null,
            },
            prompt_tokens: r.inputTokens || 0,
            prompt_tokens_details: {
              cached_tokens: r.inputTokenDetails.cacheReadTokens ?? null,
              // @todo: written_cache_tokens
            },
          },
          genTime:
            firstTokenAt !== undefined && lastTokenAt !== undefined
              ? lastTokenAt - firstTokenAt
              : 0,
          ttft: firstTokenAt !== undefined ? firstTokenAt - requestStartedAt : 0,
        });
      } catch (e) {}
    })();
    completionSettlement = settlement;
    return settlement;
  };

  const aisdk_response = toUIMessageStream({ stream: result.stream });
  const chunkLoadStream = (async function* () {
    try {
      yield* convertStreamToAsyncIterator<UIMessageChunk>(aisdk_response);
    } finally {
      await endOfCompletion();
    }
  })();

  const createdDateUnix = Math.floor(requestStartedAt / 1000);

  let openAIResponse: ChatCompletions_NotStreaming_ResponseBody_Type = {
    created: createdDateUnix,
    model: reqData.model, // @todo Not fuck everything in case of routers
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

  for await (const chunk of chunkLoadStream) {
    // https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
    switch (chunk.type) {
      case "reasoning-start":
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        if (!reqData.reasoning?.exclude) openAIResponse.choices[0].message.reasoning = "";
        break;
      case "reasoning-delta":
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        if (chunk.delta === "[REDACTED]") break;
        if (chunk.delta) markOutput();

        if (!reqData.reasoning?.exclude) openAIResponse.choices[0].message.reasoning += chunk.delta;
        break;
      case "text-start":
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        openAIResponse.choices[0].message.content = "";
        break;
      case "text-delta":
        if (chunk.delta) markOutput();
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        openAIResponse.choices[0].message.content += chunk.delta;
        break;
      case "tool-input-start":
        openAIResponse.choices[0].message.tool_calls = [];
        break;
      case "tool-input-available":
        markOutput();
        openAIResponse.choices[0].message.tool_calls![0] = {
          type: "function", // @todo dynamicTools
          id: chunk.toolCallId,
          function: {
            name: chunk.toolName,
            arguments: chunk.input as string,
          },
        };
        break;
      case "finish": {
        let finishReason = "stop";
        const generationUsage = await result.usage;
        if (
          (reqData.max_tokens || reqData.max_completion_tokens) === generationUsage.outputTokens
        ) {
          finishReason = "length";
        } else if (openAIResponse.choices[0].message.tool_calls?.[0]) {
          finishReason = "tool_calls";
        }
        openAIResponse.choices[0].finish_reason = finishReason;

        openAIResponse.usage = {
          completion_tokens: generationUsage.outputTokens || 0,
          completion_tokens_details: {
            reasoning_tokens: generationUsage.outputTokenDetails.reasoningTokens,
          },
          prompt_tokens: generationUsage.inputTokens || 0,
          prompt_tokens_details: {
            cached_tokens: generationUsage.inputTokenDetails.cacheReadTokens,
          },
          total_tokens: generationUsage.totalTokens || 0,
        };
        break;
      }
    }
  }

  return openAIResponse!;
}
