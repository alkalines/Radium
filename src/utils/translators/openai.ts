import { convertToModelMessages, streamText, tool, UIMessageChunk } from "ai";
import z from "zod";
import { convertJsonSchemaToZod } from "zod-from-json-schema";
import { completionUsage } from "../../../convex/key";
import AIBalancer from "../ai_balancer";
import { convertStreamToAsyncIterator } from "../tools/chunkReader";
import { ToolsSchema } from "../types/openai/tools";
import {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "../types/openai/types";

function toolsParsing(reqData: ChatCompletions_RequestBody_Type) {
  let object: Record<string, any> = {};
  const rawTools = reqData.tools as ToolsSchema[];

  rawTools?.forEach((rawTool) => {
    if (rawTool.type === "function") {
      const toolInfo = rawTool.function;
      const inputSchema =
        convertJsonSchemaToZod(toolInfo.parameters) || z.any();

      object[toolInfo.name] = tool({
        name: toolInfo.name,
        description: toolInfo.description,
        inputSchema, // Needs a lot of testing
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
        name: toolInfo.name,
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

function getAISDKStream(
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  abort: AbortController
): ReturnType<typeof streamText> {
  const parsedToolChoice = toolChoiceParse(reqData);
  /**
   * @todo Reasoning parameter, and provider specific options
   */
  const uiMessages = convertToModelMessages(
    reqData.messages.map((m) => {
      const role: "system" | "user" | "assistant" =
        m.role === "developer"
          ? "system"
          : m.role === "function" || m.role === "tool"
            ? "assistant"
            : (m.role as any);

      const raw: any = m;
      const content = raw.content;
      const parts: { type: "text"; text: string }[] = [];

      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (
            c &&
            typeof c === "object" &&
            "text" in c &&
            typeof (c as any).text === "string"
          ) {
            parts.push({ type: "text", text: (c as any).text });
          } else {
            try {
              parts.push({
                type: "text",
                text: `[${(c as any).type ?? "part"}] ${JSON.stringify(c)}`,
              });
            } catch {
              parts.push({ type: "text", text: "[unrepresentable part]" });
            }
          }
        }
      } else {
        parts.push({ type: "text", text: "" });
      }

      return {
        role,
        content: parts.map((p) => p.text).join(""),
        parts,
      };
    })
  );

  return streamText({
    model: provider.connector(reqData.model, {
      logitBias: reqData.logit_bias,
      /**
       * @todo OpenRouter have this option currently bugged
       */
      //logprobs: reqData.logprobs ?? false,
      parallelToolCalls: reqData.parallel_tool_calls,
      plugins: reqData.plugins,
      reasoning: {
        effort: reqData.reasoning_effort ?? "medium",
        enabled:
          reqData.reasoning?.enabled || reqData.reasoning ? undefined : true,
        max_tokens: reqData.reasoning?.max_tokens ?? undefined,
      },
      /**
       * @todo
       */
      //web_search_options: reqData.web_search_options
      user: reqData.prompt_cache_key || reqData.user,
    }),
    messages: uiMessages,
    abortSignal: abort.signal,
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
  });
}

export type genCallbackType = (genCompletion: {
  usage: completionUsage;
  genTime: number;
  ttft: number;
}) => undefined;

/**
 * Transform an OpenAI-Compatible request into a OpenAI-Compatible streamed response using the AISDK as an middleware
 * @param reqData OpenAI Compatible Request data
 * @param provider Provider message connector
 * @returns An Readable Stream of Chunks
 */
export function StreamCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  genCallback: genCallbackType
): ReadableStream<ChatCompletions_Streaming_Chunk_Type | string> {
  const abort = new AbortController();
  const result = getAISDKStream(reqData, provider, abort);

  // Usage Callback
  let genTime: string;
  let ttft: string;
  result.usage.then((r) => {
    genCallback({
      usage: {
        completion_tokens: r.outputTokens || 0,
        completion_tokens_details: {
          reasoning_tokens: r.reasoningTokens ?? null,
        },
        prompt_tokens: r.inputTokens || 0,
        prompt_tokens_details: {
          cached_tokens: r.cachedInputTokens ?? null,
          // @todo: written_cache_tokens
        },
      },
      genTime: parseFloat(genTime),
      ttft: parseFloat(ttft),
    });
  });

  // Transform to OpenAI Stream
  const aisdk_response = result.toUIMessageStream();
  const chunkLoadStream = convertStreamToAsyncIterator(
    aisdk_response
  ) as AsyncGenerator<UIMessageChunk>;
  const genTimeFirst = Date.now() / 1000;
  const createdDateUnix = Math.floor(genTimeFirst);
  let genID: string;
  return new ReadableStream({
    async start(controller) {
      const controllerOutput = (text: string) => controller.enqueue(text);
      const openaiOutput = (response: ChatCompletions_Streaming_Chunk_Type) => {
        if (!ttft) ttft = (Date.now() / 1000 - genTimeFirst).toFixed(3);
        controllerOutput(JSON.stringify(response));
      };

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
          case "finish":
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
                  logprobs: null,
                },
              ],
              usage: {
                prompt_tokens: (await result.usage).inputTokens || 0,
                completion_tokens: (await result.usage).outputTokens || 0,
                total_tokens: (await result.usage).totalTokens || 0,
                completion_tokens_details: {
                  reasoning_tokens: (await result.usage).reasoningTokens,
                },
                prompt_tokens_details: {
                  cached_tokens: (await result.usage).cachedInputTokens,
                },
              },
            });
            break;
        }
      }
      genTime = (Date.now() / 1000 - genTimeFirst).toFixed(3);

      // End of the stream
      controllerOutput("[DONE]");
      controller.close();
    },
    cancel(reason?) {
      abort.abort(reason);
      genTime = (Date.now() / 1000 - genTimeFirst).toFixed(3);
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
  genCallback: genCallbackType
): Promise<ChatCompletions_NotStreaming_ResponseBody_Type> {
  const abort = new AbortController();
  const result = getAISDKStream(reqData, provider, abort);

  // Usage Callback
  let genTime: string;
  let ttft: string = '';
  result.usage.then((r) => {
    genCallback({
      usage: {
        completion_tokens: r.outputTokens || 0,
        completion_tokens_details: {
          reasoning_tokens: r.reasoningTokens ?? null,
        },
        prompt_tokens: r.inputTokens || 0,
        prompt_tokens_details: {
          cached_tokens: r.cachedInputTokens ?? null,
          // @todo: written_cache_tokens
        },
      },
      genTime: parseFloat(genTime),
      ttft: parseFloat(ttft),
    });
  });

  const aisdk_response = result.toUIMessageStream();
  const chunkLoadStream = convertStreamToAsyncIterator(
    aisdk_response
  ) as AsyncGenerator<UIMessageChunk>;

  const genTimeFirst = Date.now() / 1000;
  const createdDateUnix = Math.floor(genTimeFirst);

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
        if (!reqData.reasoning?.exclude)
          openAIResponse.choices[0].message.reasoning = "";
        break;
      case "reasoning-delta":
        if (ttft === '') ttft = (Date.now() / 1000 - genTimeFirst).toFixed(3);
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        if (chunk.delta === "[REDACTED]") break;

        if (!reqData.reasoning?.exclude)
          openAIResponse.choices[0].message.reasoning += chunk.delta;
        break;
      case "text-start":
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        openAIResponse.choices[0].message.content = "";
        break;
      case "text-delta":
        if (ttft === '') ttft = (Date.now() / 1000 - genTimeFirst).toFixed(3);
        if (openAIResponse.id === "") openAIResponse.id = chunk.id;
        openAIResponse.choices[0].message.content += chunk.delta;
        break;
      case "tool-input-start":
        if (ttft === '') ttft = (Date.now() / 1000 - genTimeFirst).toFixed(3);
        openAIResponse.choices[0].message.tool_calls = [];
        break;
      case "tool-input-available":
        if (ttft === '') ttft = (Date.now() / 1000 - genTimeFirst).toFixed(3);
        openAIResponse.choices[0].message.tool_calls![0] = {
          type: "function", // @todo dynamicTools
          id: chunk.toolCallId,
          function: {
            name: chunk.toolName,
            arguments: chunk.input as string,
          },
        };
        break;
      case "finish":
        openAIResponse.usage = {
          completion_tokens: (await result.usage).outputTokens || 0,
          completion_tokens_details: {
            reasoning_tokens: (await result.usage).reasoningTokens,
          },
          prompt_tokens: (await result.usage).inputTokens || 0,
          prompt_tokens_details: {
            cached_tokens: (await result.usage).cachedInputTokens,
          },
          total_tokens: (await result.usage).totalTokens || 0,
        };
        break;
    }
  }
  genTime = (Date.now() / 1000 - genTimeFirst).toFixed(3);

  return openAIResponse!;
}
