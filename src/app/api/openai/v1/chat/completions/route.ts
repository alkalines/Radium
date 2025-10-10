import { ChatCompletions_RequestBody } from "@/utils/types/openai/types";
import { NextRequest, NextResponse } from "next/server";
import AIBalancer from "@/utils/ai_balancer";
import * as z from "zod";

export async function POST(rawRequest: NextRequest) {
  try {
    const request = ChatCompletions_RequestBody.parse(await rawRequest.json());

    // TODO: Cost tracking, and BYOK.
    const providerConnector = await AIBalancer(request);
    if (request.stream) {
      const gen = await providerConnector.StreamCompletion(request);
      const encoder = new TextEncoder();

      const customReadable = new ReadableStream({
        async start(controller) {
          for await (const chunk of gen) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // End of the stream
          controller.enqueue(encoder.encode("data: [DONE]"));
          controller.close()
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
      const gen = await providerConnector.GenerateCompletion(request);

      return NextResponse.json(gen);
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(e.issues, { status: 400 });
    }
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
