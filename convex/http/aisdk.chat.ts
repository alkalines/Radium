import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText } from "ai";
import { ChatCompletions_RequestBody } from "../../src/utils/types/openai/types";
import { httpAction } from "../_generated/server";
import { Internal_Chat_Completion } from "./chat_completion";
import { createAuth } from "../auth";

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
        init?: RequestInit
      ): Promise<Response> => {
        try {
          // Parse the request body from init
          const bodyText =
            typeof init?.body === "string"
              ? init.body
              : await new Response(init?.body).text();
          const reqData = ChatCompletions_RequestBody.parse(
            JSON.parse(bodyText)
          );
          return Internal_Chat_Completion(ctx, reqData, userID as any);
        } catch (e) {
          return Response.json({ text: "FUCK" });
        }
      },
    });

    // Parse the incoming request
    const body = await req.json();

    const result = streamText({
      model: provider(body.model),
      messages: convertToModelMessages(body.messages),
    });

    return result.toUIMessageStreamResponse({
      sendSources: true,
      sendReasoning: true,
    });
  }
);
