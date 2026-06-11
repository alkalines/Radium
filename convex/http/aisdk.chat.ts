import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, tool, type UIMessage } from "ai";
import * as z from "zod";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
} from "../../src/utils/types/openai/types";
import { Internal_Chat_Completion } from "./chat_completion";
import type { Id } from "../_generated/dataModel";
import { authComponent, createAuth } from "../auth";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

type ResponseHeaders = Record<string, string>;

type AISDKChatRequestBody = {
  messages: UIMessage[];
  model: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
  id?: Id<"aisdk_chats">;
  chatId?: Id<"aisdk_chats">;
};

function jsonResponse(body: unknown, responseHeaders: ResponseHeaders, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      ...responseHeaders,
      ...init?.headers,
    },
  });
}

/** Handles the authenticated AI SDK chat request body and stream lifecycle. */
export async function handleAISDKChat(
  ctx: ActionCtx,
  req: Request,
  responseHeaders: ResponseHeaders,
): Promise<Response> {
  const authUser = await authComponent.safeGetAuthUser(ctx);
  const session = authUser?._id
    ? null
    : await createAuth(ctx).api.getSession({
        headers: req.headers,
      });
  const userId = authUser?._id ?? session?.user.id;

  if (!userId) {
    return jsonResponse({ error: { message: "Unauthorized", code: 401 } }, responseHeaders, {
      status: 401,
    });
  }

  const body = (await req.json()) as AISDKChatRequestBody;
  const chatId = (body?.chatId || body?.id)!;

  if (!chatId || !body.model || !Array.isArray(body.messages)) {
    return jsonResponse(
      { error: { message: "Invalid chat request", code: 400 } },
      responseHeaders,
      { status: 400 },
    );
  }

  const chatInfo = await ctx.runQuery(internal.aisdk.InternalChatInfo, {
    chatId,
  });

  if (!chatInfo || chatInfo.userId !== userId)
    return jsonResponse({ error: { message: "Unauthorized", code: 401 } }, responseHeaders, {
      status: 401,
    });

  const provider = createInternalGatewayProvider(ctx, chatInfo.balance, responseHeaders);

  await ctx.runMutation(internal.aisdk.EditChat, {
    chatId,
    activeStream: true,
    messages_queue: null,
  });

  const tools = {
    weather: tool({
      description: "Get the weather in a location",
      inputSchema: z.object({
        location: z.string().describe("The location to get the weather for"),
      }),
      needsApproval: true,
      execute: ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
  };

  const result = streamText({
    model: provider(body.model),
    messages: await convertToModelMessages(body.messages, { tools }),
    tools,
    providerOptions:
      body.reasoningEffort || body.reasoningBudget
        ? {
            openaiCompatible: {
              ...(body.reasoningEffort && body.reasoningEffort !== "none"
                ? { reasoningEffort: body.reasoningEffort }
                : {}),
              reasoning: {
                ...(body.reasoningEffort ? { effort: body.reasoningEffort } : {}),
                ...(body.reasoningBudget ? { max_tokens: body.reasoningBudget } : {}),
              },
            },
          }
        : undefined,
    abortSignal: req.signal,
  });

  // Track reasoning start time to calculate duration
  let reasoningStartTime: number | null = null;

  return result.toUIMessageStreamResponse({
    headers: responseHeaders,
    originalMessages: body.messages,
    sendSources: true,
    sendReasoning: true,
    messageMetadata({ part }) {
      // Track when reasoning starts
      if (part.type === "reasoning-start") {
        if (reasoningStartTime === null) {
          reasoningStartTime = Date.now();
        }
      }
      return {
        model: body.model,
      };
    },
    onFinish: async ({ messages }) => {
      // Calculate reasoning duration and add it to reasoning parts
      const messagesWithDuration = messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) => {
          if (part.type === "reasoning" && reasoningStartTime !== null) {
            const durationMs = Date.now() - reasoningStartTime;
            const durationSeconds = Math.ceil(durationMs / 1000);
            return {
              ...part,
              duration: durationSeconds,
            };
          }
          return part;
        }),
      }));

      const allMessages = [...body.messages, ...messagesWithDuration];
      await ctx.runMutation(internal.aisdk.EditChat, {
        chatId,
        messages: allMessages,
        activeStream: false,
      });
    },
  });
}

function createInternalGatewayProvider(
  ctx: ActionCtx,
  balanceId: Id<"balances">,
  responseHeaders: ResponseHeaders,
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
        return await Internal_Chat_Completion(ctx, requestBody, balanceId);
      } catch (error) {
        console.error(error);
        return jsonResponse(
          { error: { message: "Internal gateway request failed", code: 500 } },
          responseHeaders,
          { status: 500 },
        );
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

/**
 * https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams#3-implement-the-get-handler
 * We can't implement the GET handler. In case we wanted Convex needed to be compatible with an Redis library or create an extremely custom logic to store data into convex, but this aproach would add major pressure on the DB and be harder to maintain
 */
