import {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "../types/openai/types";
import { streamText, tool, jsonSchema } from "ai";
import AIBalancer from "../ai_balancer";
import { ToolsSchema } from "../types/openai/tools";

function toolsParsing(reqData: ChatCompletions_RequestBody_Type) {
  let object = {} as { [key: string]: ReturnType<typeof tool> };
  const rawTools = reqData.tools as ToolsSchema[];

  rawTools?.forEach((rawTool) => {
    if (rawTool.type === "function") {
      const toolInfo = rawTool.function;
      object[toolInfo.name] = tool({
        name: toolInfo.name,
        description: toolInfo.description,
        inputSchema: jsonSchema(toolInfo.parameters), // Needs testing
        /**
         * Strict is non existent on the AISDK
         * @comment i don't know why.
         */
      });
    } else {
      const toolInfo = rawTool.custom;
    }
  });
}

function toolChoiceParse(reqData: ChatCompletions_RequestBody_Type) {
  const tc = reqData.tool_choice as any;

  if (typeof tc === "string") return tc;

  if (tc.type === "function" && tc.function?.name)
    return { type: "tool", toolName: tc.function.name } as any;

  if (tc.type === "custom" && tc.custom?.name)
    return { type: "tool", toolName: tc.custom.name } as any;

  if (tc.type === "allowed_tools")
    return tc.allowed_tools?.mode === "required" ? "required" : "auto";

  return "auto";
}

export async function StreamCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  abort?: AbortController
) {
  const result = streamText({
    model: provider.connector(reqData.model),
    messages: reqData.messages.map((m) => {
      if (m.role === "developer") m.role = "system";
      return m;
    }) as any,
    abortSignal: abort?.signal,
    maxOutputTokens: reqData.max_completion_tokens ?? undefined,
    tools: toolsParsing(reqData) as any,
    toolChoice: toolChoiceParse(reqData),
    maxRetries: parseInt(process.env.AISDK_MaxRetries ?? "0"),
    /**
     * @todo providerOptions
     **/
    // Customization
    temperature: reqData.temperature,
    topP: reqData.top_p,
    topK: reqData.top_k,
    presencePenalty: reqData.presence_penalty ?? undefined,
    frequencyPenalty: reqData.frequency_penalty ?? undefined,
    seed: reqData.seed,
  });
}
