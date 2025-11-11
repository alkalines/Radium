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
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  abort?: AbortController
) {
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
    abortSignal: abort?.signal,
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
