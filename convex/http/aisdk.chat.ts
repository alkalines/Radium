import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, UIMessage } from "ai";
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
    const auth = createAuth(ctx)
    const identity = await auth.api.getSession({
      headers: req.headers,
    })
    
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
          const reqData = JSON.parse(init?.body as string) as ChatCompletions_RequestBody_Type
          return Internal_Chat_Completion(ctx, reqData, identity.user.id as any);
        } catch (e) {
          console.log(e)
          return Response.json({ text: 'Internal Server Error!' }, { status: 500 })
        }
      },
    });

    // Parse the incoming request
    const body: {
      messages: UIMessage[];
      model: string;
      id?: Id<"aisdk_chats">;
      chatId?: Id<"aisdk_chats">; // When creating an chat we can't create an chat ID on the fly
    } = await req.json();
    const chatId = (body?.chatId || body?.id)!;
    
    await ctx.runMutation(internal.aisdk.EditChat, {
      chatId,
      messages_queue: null,
    });
    const result = streamText({
      model: provider(body.model),
      messages: convertToModelMessages(body.messages),
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
        const allMessages = [...body.messages, ...messages]
        await ctx.runMutation(internal.aisdk.EditChat, {
          chatId,
          messages: allMessages,
          activeStreamId: null,
        });
      },
    });
  },
);
