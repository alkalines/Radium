import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import {
  ChatCompletions_RequestBody,
  ChatCompletions_RequestBody_Type,
} from "@/utils/types/openai/types";
import AIBalancer from "@/utils/ai_balancer";
import * as z from "zod";
import { StreamCompletion } from "@/utils/output/openai";

export const HTTP_Request_Chat_Completion = httpAction(async (ctx, req) => {
  try {
    const reqData = ChatCompletions_RequestBody.parse(await req.json());

    // Auth
    const authBearer = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!authBearer || authBearer === "")
      return Response.json(
        {
          error: {
            message: "The Authorization field is empty!",
            code: 401,
          },
        },
        { status: 401 }
      );
    const checkKey = await ctx
      .runQuery(api.key.getKeyInfo, {
        key: authBearer,
      })
      .catch((E) => {});
    if (!checkKey)
      return Response.json(
        {
          error: {
            message: "The Authorization is invalid!",
            code: 401,
          },
        },
        { status: 401 }
      );
    if (checkKey.usableCredits <= 0)
      return Response.json(
        {
          error: {
            message: "Not enough credits available.",
            code: 402
          },
        },
        { status: 402 }
      );

    // TODO: Cost tracking, and BYOK.
    const provider = await AIBalancer(reqData);
    return CreateCompletion(reqData, provider);
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return Response.json(e.issues, { status: 400 });
    }
    console.log(e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});

const CreateCompletion = async (
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>
) => {
  /* const genID = `gen-${crypto.randomUUID()}`;
  if (reqData.stream) {
    const gen = await provider.connector.StreamCompletion(reqData);
    let provider_genID: string;

    const customReadable = new ReadableStream({
      async start(controller) {
        const controllerOutput = (text: string) =>
          controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));

        for await (const providerChunk of gen.chunks) {
          let chunk = providerChunk;
          if (!provider_genID) provider_genID = chunk.id

          chunk.id = genID
          chunk.provider = provider.info.slug
          controllerOutput(JSON.stringify(chunk));
        }

        // End of the stream
        controllerOutput("[DONE]");
        controller.close();
      },
      cancel() {
        gen.abort.abort(`User cancelled.`)
      }
    });

    // Server Sent Events (SSE)
    return new Response(customReadable, {
      headers: {
        Connection: "keep-alive",
        "Content-Encoding": "none",
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  } else {
    const gen = await provider.connector.GenerateCompletion(reqData);

    return Response.json(gen);
  } */
  return StreamCompletion(reqData, provider)
};
