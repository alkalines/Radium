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
import { createAuth } from "../auth";
import { internal } from "../_generated/api";

export const AISDK_POST_Chat = httpAction(
  async (ctx, req): Promise<Response> => {
    /**
     * @comment Default `ctx.auth.getUserIdentity()` used on the `authComponent.getAuthUser(ctx);` doesn't work
     */
    const auth = createAuth(ctx);
    const identity = await auth.api.getSession({
      headers: req.headers,
    });

    if (!identity) {
      return Response.json(
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 },
      );
    }

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
            identity.user.id as any,
          );
        } catch (e) {
          console.log(e);
          return Response.json(
            { text: "Internal Server Error!" },
            { status: 500 },
          );
        }
      },
    });

    // Parse the incoming request
    const body: {
      message: UIMessage[];
      model: string;
      id?: Id<"aisdk_chats">;
      chatId?: Id<"aisdk_chats">; // When creating an chat we can't create an chat ID on the fly
    } = await req.json();
    const chatId = (body?.chatId || body?.id)!;

    const chatInfo = await ctx.runQuery(internal.aisdk.InternalChatInfo, {
      chatId,
    });

    if (!chatInfo || chatInfo.userId !== identity.user.id)
      return Response.json(
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 },
      );

    await ctx.runMutation(internal.aisdk.EditChat, {
      chatId,
      activeStream: true,
      messages_queue: null,
    });

    const chatMessages = [...(chatInfo.messages as any[]), body.message];

    const result = streamText({
      model: provider(body.model),
      messages: convertToModelMessages(chatMessages),
    });

    return result.toUIMessageStreamResponse({
      sendSources: true,
      sendReasoning: true,
      messageMetadata() {
        return {
          model: body.model,
        };
      },
      onFinish: async ({ messages }) => {
        const allMessages = [...chatMessages, ...messages];
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