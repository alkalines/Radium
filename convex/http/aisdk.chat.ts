import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  generateId,
  streamText,
  UI_MESSAGE_STREAM_HEADERS,
  UIMessage,
} from "ai";
import { ChatCompletions_RequestBody_Type } from "../../src/utils/types/openai/types";
import { httpAction } from "../_generated/server";
import { Internal_Chat_Completion } from "./chat_completion";
import { Id } from "../_generated/dataModel";
import { createAuth } from "../auth";
import { api, components, internal } from "../_generated/api";
import {
  PersistentTextStreaming,
  StreamId,
} from "@convex-dev/persistent-text-streaming";
import { convertStreamToAsyncIterator } from "@/utils/tools/chunkReader";

const streaming = new PersistentTextStreaming(
  components.persistentTextStreaming
);

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
          const reqData = JSON.parse(
            init?.body as string
          ) as ChatCompletions_RequestBody_Type;
          return Internal_Chat_Completion(
            ctx,
            reqData,
            identity.user.id as any
          );
        } catch (e) {
          console.log(e);
          return Response.json(
            { text: "Internal Server Error!" },
            { status: 500 }
          );
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

    const chatOwner = await ctx.runQuery(internal.aisdk.GetChatOwner, {
      chatId,
    })

    if (chatOwner && chatOwner !== identity.user.id)
      return Response.json(
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 }
      );

    await ctx.runMutation(internal.aisdk.EditChat, {
      chatId,
      activeStreamId: null,
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
        const allMessages = [...body.messages, ...messages];
        await ctx.runMutation(internal.aisdk.EditChat, {
          chatId,
          messages: allMessages,
          activeStreamId: null,
        });
      },
      async consumeSseStream({ stream }) {
        const streamId = await streaming.createStream(ctx);
        await ctx.runMutation(internal.aisdk.EditChat, {
          chatId,
          activeStreamId: streamId,
        });
        await streaming.stream(
          ctx,
          req,
          streamId,
          async (ctx, req, streamId, append) => {
            for await (const chunk of convertStreamToAsyncIterator<string>(
              stream
            ))
              append(`${chunk}[NEXT-CHUNK]`);
            await ctx.runMutation(internal.aisdk.EditChat, {
              chatId,
              activeStreamId: null,
            });
          }
        );
      },
    });
  }
);

export const AISDK_GET_Chat_Stream = httpAction(
  async (ctx, req): Promise<Response> => {
    const url = new URL(req.url);
    const chatId = url.pathname.split("/")[5] as Id<"aisdk_chats">;

    const auth = createAuth(ctx);
    const identity = await auth.api.getSession({
      headers: req.headers,
    });

    if (!identity) {
      return Response.json(
        { error: { message: "Unauthorized", code: 401 } },
        { status: 401 }
      );
    }

    let stream;
    try {
      stream = await ctx.runQuery(internal.aisdk.GetChatStream, {
        chatId,
      });
    } catch (E) {
      return new Response(null, { status: 204 });
    }

    const chatOwner = await ctx.runQuery(internal.aisdk.GetChatOwner, {
      chatId,
    });

    if (chatOwner && chatOwner !== identity.user.id)
      return new Response(null, { status: 204 });

    let lastChunk = -1; // -1 = Not Recived anything yet

    console.log("here");
    return new Response(
      new ReadableStream({
        start(controller) {
          console.log("started!");
          const controllerOutput = (text: string) => {
            controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
            console.log(text);
          };

          let streamFinished = false;
          while (!streamFinished) {
            if (stream) {
              if (
                stream.status === "done" ||
                stream.status === "error" ||
                stream.status === "timeout"
              ) {
                streamFinished = true;
                controller.close()
              }

              const nextChunk = stream.chunks[lastChunk + 1];
              if (nextChunk) {
                controllerOutput(nextChunk);
                lastChunk += 1;
              }
            }
          }
        },
      }),
      { headers: UI_MESSAGE_STREAM_HEADERS }
    );
  }
);

// https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams#3-implement-the-get-handler
