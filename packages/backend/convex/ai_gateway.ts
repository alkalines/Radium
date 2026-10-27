import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ActionCtx } from "./_generated/server";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
} from "@/types/openai/types";
import type { Id } from "./_generated/dataModel";
import { Internal_Chat_Completion } from "../src/http/chat_completion";
import type { genCallbackType } from "@/translators/openai";
import type { TelemetryRequestContext } from "@/telemetry/capture";

type ErrorResponse = (error: unknown) => Response;
type InternalChatContext = { userId: string; chatId: Id<"aisdk_chats"> };

/**
 * Build an AI SDK provider whose requests are parsed and routed through the
 * workspace's internal OpenAI-compatible gateway. The supplied error handler
 * converts routing or request failures into a response for the AI SDK.
 */
export function createInternalGatewayProvider(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  onError: ErrorResponse,
  providerSlug: string | undefined,
  onGeneration: ((generation: Parameters<genCallbackType>[0]) => void) | undefined,
  telemetry: Omit<TelemetryRequestContext, "requestId"> | undefined,
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
        const { requestBody, rawBody } = getGatewayRequestBody(init?.body);
        if (providerSlug) {
          requestBody.provider = providerSlug;
          rawBody.provider = providerSlug;
        }
        // Carry the same authenticated identity under each downstream contract's field name.
        const downstreamChatContext = {
          actor: chatContext.userId,
          userId: chatContext.userId,
          chatId: chatContext.chatId,
        };
        // One Chatroom turn can make several Gateway requests (tool-use steps); each is
        // captured under its own request ID.
        return await Internal_Chat_Completion(
          ctx,
          requestBody,
          workspaceId,
          onGeneration,
          telemetry && { ...telemetry, requestId: crypto.randomUUID() },
          init?.signal,
          downstreamChatContext,
          rawBody,
        );
      } catch (error) {
        console.error(error);
        return onError(error);
      }
    }) as typeof fetch,
  });
}

/** Parse the wire JSON, keeping the raw object so telemetry sees fields the schema drops. */
function getGatewayRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new Error("Expected OpenAI-compatible JSON request body.");
  }

  const rawBody = JSON.parse(body) as Record<string, unknown>;
  const requestBody = ChatCompletions_RequestBody.parse(
    rawBody,
  ) as ChatCompletions_RequestBody_Type;
  return { requestBody, rawBody };
}
