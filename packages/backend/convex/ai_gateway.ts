import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ActionCtx } from "./_generated/server";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
} from "@/types/openai/types";
import type { Id } from "./_generated/dataModel";
import { Internal_Chat_Completion } from "./http/chat_completion";
import type { genCallbackType } from "@/translators/openai";
import type { TelemetryRequestContext } from "@/telemetry/convex";

type ErrorResponse = (error: unknown) => Response;
type InternalChatContext = { userId: string; chatId: Id<"aisdk_chats"> };

/**
 * Build the AI SDK provider backed by Radium's internal OpenAI-compatible gateway.
 */
export function createInternalGatewayProvider(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  onError: ErrorResponse,
  providerSlug: string | undefined,
  onGeneration: ((generation: Parameters<genCallbackType>[0]) => void) | undefined,
  telemetry: TelemetryRequestContext | undefined,
  chatContext: InternalChatContext,
) {
  return createOpenAICompatible({
    name: "Radium Gateway",
    apiKey: "internal-gateway",
    baseURL: "https://radium.internal/openai/v1",
    headers: {
      "HTTP-Referer": "https://github.com/alkalines/Radium",
      "X-Title": "Radium Chatroom",
    },
    fetch: (async (_input, init): Promise<Response> => {
      try {
        const requestBody = getGatewayRequestBody(init?.body);
        if (providerSlug) requestBody.provider = providerSlug;
        const downstreamChatContext = {
          actor: chatContext.userId,
          userId: chatContext.userId,
          chatId: chatContext.chatId,
        };
        return await Internal_Chat_Completion(
          ctx,
          requestBody,
          workspaceId,
          onGeneration,
          telemetry,
          init?.signal,
          downstreamChatContext,
        );
      } catch (error) {
        console.error(error);
        return onError(error);
      }
    }) as typeof fetch,
  });
}

function getGatewayRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new Error("Expected OpenAI-compatible JSON request body.");
  }

  return ChatCompletions_RequestBody.parse(JSON.parse(body)) as ChatCompletions_RequestBody_Type;
}
