import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  streamText,
  UIMessage,
} from "ai";
import { ChatCompletions_RequestBody_Type } from "../../src/utils/types/openai/types";
import { httpAction } from "../_generated/server";
import { Internal_Chat_Completion } from "./chat_completion";
import { Id } from "../_generated/dataModel";
import { authComponent, createAuth } from "../auth";
import { internal } from "../_generated/api";

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "*";

  return {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function jsonResponse(req: Request, body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders(req),
      ...init?.headers,
    },
  });
}

export const AISDK_OPTIONS_Chat = httpAction(async (_ctx, req) => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req),
  });
});

export const AISDK_POST_Chat = httpAction(
  async (ctx, req): Promise<Response> => {
    /**
     * @comment Default `ctx.auth.getUserIdentity()` used on the `authComponent.getAuthUser(ctx);` doesn't work
     */
    const auth = createAuth(ctx);
    const authUser = await authComponent.safeGetAuthUser(ctx);
    let userId = authUser?._id;

    if (!userId) {
      const identity = await auth.api.getSession({
        headers: req.headers,
      });

      userId = identity?.user.id;

      if (!userId) {
        return jsonResponse(
          req,
          { error: { message: "Unauthorized", code: 401 } },
          { status: 401 },
        );
      }
    }

    const userInfo = await ctx.runQuery(internal.auth.internalUserInfo, {
      userId,
    });

    const provider = createOpenAICompatible({
      name: "Radium",
      headers: {
        "HTTP-Referer": "https://github.com/alkalines/Radium",
        "X-Title": "Radium Chatroom",
      },
      apiKey: process.env.PROVIDER_API_KEY,
      baseURL: "https://api.there_is_no_need_for_this.com/v1",
      fetch: async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        try {
          // Parse the request body from init
          const reqData = JSON.parse(
            init?.body as string,
          ) as ChatCompletions_RequestBody_Type;
          return Internal_Chat_Completion(
            ctx,
            reqData,
            userInfo.balances[0]._id, // 0 for the moment
          );
        } catch (e) {
          console.log(e);
          return jsonResponse(
            req,
            { text: "Internal Server Error!" },
            { status: 500 },
          );
        }
      },
    });

    // Parse the incoming request
    const body: {
      messages: UIMessage[];
      model: string;
      reasoningEffort?: "low" | "medium" | "high";
      id?: Id<"aisdk_chats">;
      chatId?: Id<"aisdk_chats">; // When creating an chat we can't create an chat ID on the fly
    } = await req.json();
    const chatId = (body?.chatId || body?.id)!;

    const chatInfo = await ctx.runQuery(internal.aisdk.InternalChatInfo, {
      chatId,
    });

    if (!chatInfo || chatInfo.userId !== userId)
      return jsonResponse(
        req,
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 },
      );

    await ctx.runMutation(internal.aisdk.EditChat, {
      chatId,
      activeStream: true,
      messages_queue: null,
    });

    const result = streamText({
      model: provider(body.model),
      messages: await convertToModelMessages(body.messages),
      providerOptions: body.reasoningEffort
        ? {
            openaiCompatible: {
              reasoningEffort: body.reasoningEffort,
            },
          }
        : undefined,
      abortSignal: req.signal,
    });

    // Track reasoning start time to calculate duration
    let reasoningStartTime: number | null = null;

    return result.toUIMessageStreamResponse({
      headers: corsHeaders(req),
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

/**
 * https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams#3-implement-the-get-handler
 * We can't implement the GET handler. In case we wanted Convex needed to be compatible with an Redis library or create an extremely custom logic to store data into convex, but this aproach would add major pressure on the DB and be harder to maintain
 */
