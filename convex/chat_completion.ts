import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { ChatCompletions_RequestBody } from "@/utils/types/openai/types";
import AIBalancer from "@/utils/ai_balancer";
import * as z from "zod";

export const CreateCompletion = httpAction(async (ctx, req) => {
  try {
    const reqData = ChatCompletions_RequestBody.parse(await req.json())

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
    const providerConnector = await AIBalancer(reqData);
    if (reqData.stream) {
      const gen = await providerConnector.StreamCompletion(reqData);
      const encoder = new TextEncoder();

      const customReadable = new ReadableStream({
        async start(controller) {
          for await (const chunk of gen) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
            );
          }

          // End of the stream
          controller.enqueue(encoder.encode("data: [DONE]"));
          controller.close();
        },
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
      const gen = await providerConnector.GenerateCompletion(reqData);

      return Response.json(gen);
    }
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return Response.json(e.issues, { status: 400 });
    } 
    console.log(e)
    return Response.json({ error: e.message }, { status: 500 });
  }
});
