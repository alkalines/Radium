import {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "../types/openai/types";
import { streamText, tool, UIMessageChunk } from "ai";
import { convertJsonSchemaToZod } from "zod-from-json-schema";
import z from "zod";
import AIBalancer from "../ai_balancer";
import { ToolsSchema } from "../types/openai/tools";
import { streamChunkForAsyncIterator } from "../tools/chunkReader";

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

export async function StreamCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>
) {
  const abort = new AbortController();
  const parsedToolChoice = toolChoiceParse(reqData);
  /**
   * @todo Reasoning parameter, and provider specific options
   */
  const result = streamText({
    model: provider.connector(reqData.model),
    messages: reqData.messages.map((m) => {
      if (m.role === "developer") m.role = "system";
      return m;
    }) as any,
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

  // Transform to OpenAI Stream
  const aisdk_response = result.toUIMessageStream();
  const chunkLoadStream = streamChunkForAsyncIterator(
    aisdk_response
  ) as AsyncGenerator<UIMessageChunk>;
  const createdDateUnix = Date.now();
  let genID: string;
  if (reqData.stream) {
    const customReadable = new ReadableStream({
      async start(controller) {
        const controllerOutput = (text: string) =>
          controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
        const openaiOutput = (response: ChatCompletions_Streaming_Chunk_Type) =>
          controllerOutput(JSON.stringify(response));

        for await (const chunk of chunkLoadStream) {
          // https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
          switch (chunk.type) {
            case "reasoning-start":
              if (!genID) genID = chunk.id;
              openaiOutput({
                id: chunk.id,
                provider: provider.info.name,
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
              break;
            case "reasoning-delta":
              if (!genID) genID = chunk.id;
              openaiOutput({
                id: chunk.id,
                provider: provider.info.name,
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
              break;
            case "tool-input-start":
              openaiOutput({
                id: genID || "not-available",
                provider: provider.info.name,
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
                provider: provider.info.name,
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
                provider: provider.info.name,
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
            case "finish":
              openaiOutput({
                id: genID || "not-available",
                provider: provider.info.name,
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
                    reasoning_tokens: (await result.usage).reasoningTokens
                  },
                  prompt_tokens_details: {
                    cached_tokens: (await result.usage).cachedInputTokens
                  }
                },
              });
              break;
          }
        }

        // End of the stream
        controllerOutput("[DONE]");
        controller.close();
      },
      cancel(reason?) {
        abort.abort(reason);
      },
    });

    // Server Sent Events (SSE)
    return new Response(customReadable, {
      headers: {
        Connection: "keep-alive",
        "Content-Encoding": "none",
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  }

  return result;
}
