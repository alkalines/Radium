import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { GenericActionCtx } from "convex/server";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
} from "@/utils/types/openai/types";
import type { Id } from "./_generated/dataModel";
import { Internal_Chat_Completion } from "./http/chat_completion";

type ErrorResponse = (error: unknown) => Response;

/**
 * Build the AI SDK provider backed by Radium's internal OpenAI-compatible gateway.
 */
export function createInternalGatewayProvider(
  ctx: GenericActionCtx<any>,
  balanceId: Id<"balances">,
  onError: ErrorResponse,
  providerSlug?: string,
) {
  return createOpenAICompatible({
    name: "Radium Gateway",
    apiKey: "internal-gateway",
    baseURL: "https://radium.internal/openai/v1",
    headers: {
      "HTTP-Referer": "https://github.com/alkalines/Radium",
      "X-Title": "Radium Chatroom",
    },
    fetch: async (_input, init): Promise<Response> => {
      try {
        const requestBody = getGatewayRequestBody(init?.body);
        if (providerSlug) requestBody.provider = providerSlug;
        return await Internal_Chat_Completion(ctx, requestBody, balanceId);
      } catch (error) {
        console.error(error);
        return onError(error);
      }
    },
  });
}

function getGatewayRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new Error("Expected OpenAI-compatible JSON request body.");
  }

  return ChatCompletions_RequestBody.parse(JSON.parse(body)) as ChatCompletions_RequestBody_Type;
}
