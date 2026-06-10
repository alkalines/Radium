import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  streamText,
  type UIMessage,
} from "ai";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
} from "../../src/utils/types/openai/types";
import { httpAction } from "../_generated/server";
import { Internal_Chat_Completion } from "./chat_completion";
import { Id } from "../_generated/dataModel";
import { authComponent, createAuth } from "../auth";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

type AISDKChatRequestBody = {
  messages: UIMessage[];
  model: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
  id?: Id<"aisdk_chats">;
  chatId?: Id<"aisdk_chats">;
};

function corsHeaders() {
  const origin = new URL(process.env.SITE_URL!).origin;

  return {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function jsonResponse(_req: Request, body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders(),
      ...init?.headers,
    },
  });
}

export const AISDK_OPTIONS_Chat = httpAction(async (_ctx, _req) => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
});

export const AISDK_POST_Chat = httpAction(
  async (ctx, req): Promise<Response> => {
    const userId = await getAuthenticatedUserId(ctx, req);

    if (!userId) {
      return jsonResponse(
        req,
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 },
      );
    }

    const body = (await req.json()) as AISDKChatRequestBody;
    const chatId = (body?.chatId || body?.id)!;

    if (!chatId || !body.model || !Array.isArray(body.messages)) {
      return jsonResponse(
        req,
        { error: { message: "Invalid chat request", code: 400 } },
        { status: 400 },
      );
    }

    const chatInfo = await ctx.runQuery(internal.aisdk.InternalChatInfo, {
      chatId,
    });

    if (!chatInfo || chatInfo.userId !== userId)
      return jsonResponse(
        req,
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 },
      );

    const provider = createInternalGatewayProvider(ctx, req, chatInfo.balance);

    await ctx.runMutation(internal.aisdk.EditChat, {
      chatId,
      activeStream: true,
      messages_queue: null,
    });

    const result = streamText({
      model: provider(body.model),
      messages: await convertToModelMessages(body.messages),
      providerOptions: body.reasoningEffort || body.reasoningBudget
        ? {
            openaiCompatible: {
              ...(body.reasoningEffort && body.reasoningEffort !== "none"
                ? { reasoningEffort: body.reasoningEffort }
                : {}),
              reasoning: {
                ...(body.reasoningEffort ? { effort: body.reasoningEffort } : {}),
                ...(body.reasoningBudget
                  ? { max_tokens: body.reasoningBudget }
                  : {}),
              },
            },
          }
        : undefined,
      abortSignal: req.signal,
    });

    // Track reasoning start time to calculate duration
    let reasoningStartTime: number | null = null;

    return result.toUIMessageStreamResponse({
      headers: corsHeaders(),
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
  },
);

async function getAuthenticatedUserId(ctx: ActionCtx, req: Request) {
  const authUser = await authComponent.safeGetAuthUser(ctx);

  if (authUser?._id) {
    return authUser._id;
  }

  const auth = createAuth(ctx);
  const session = await auth.api.getSession({
    headers: req.headers,
  });

  return session?.user.id;
}

function createInternalGatewayProvider(
  ctx: ActionCtx,
  req: Request,
  balanceId: Id<"balances">,
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
          req,
          { error: { message: "Internal gateway request failed", code: 500 } },
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

  return ChatCompletions_RequestBody.parse(
    JSON.parse(body),
  ) as ChatCompletions_RequestBody_Type;
}

/**
 * https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams#3-implement-the-get-handler
 * We can't implement the GET handler. In case we wanted Convex needed to be compatible with an Redis library or create an extremely custom logic to store data into convex, but this aproach would add major pressure on the DB and be harder to maintain
 */
