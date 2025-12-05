import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText } from "ai";
import { ChatCompletions_RequestBody } from "../../src/utils/types/openai/types";
import { httpAction } from "../_generated/server";
import { Internal_Chat_Completion } from "./chat_completion";

export const AISDK_POST_Chat = httpAction(
  async (ctx, req): Promise<Response> => {
    /**
     * @todo Make a User from Better Auth to User (better naming required) in convex table
     */
    const userID = "jd7e16947630dpnf0psta59dps7se1zc"; //await ctx.auth.getUserIdentity();

    if (!userID) {
      return Response.json(
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 }
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
