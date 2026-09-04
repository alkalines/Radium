import { httpAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import {
  ChatCompletions_RequestBody,
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "@/utils/types/openai/types";
import AIBalancer from "@/utils/ai_balancer";
import * as z from "zod";
import {
  NonStreamingCompletion,
  StreamCompletion,
  type genCallbackType,
} from "@/utils/translators/openai";
import { convertStreamToAsyncIterator } from "@/utils/tools/chunkReader";
import { completionUsage } from "../key";
import { GenericActionCtx } from "convex/server";
import { Id } from "../_generated/dataModel";
import {
  createTelemetryIntegrations,
  type TelemetryRequestContext,
} from "../telemetry_integration";

export const HTTP_Request_Chat_Completion = httpAction(async (ctx, req): Promise<Response> => {
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
        { status: 401 },
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
        { status: 401 },
      );
    if (checkKey.usableCredits <= 0)
      return Response.json(
        {
          error: {
            message: "Not enough credits available.",
            code: 402,
          },
        },
        { status: 402 },
      );

    const provider = await AIBalancer(ctx, checkKey.balance!._id, reqData);
    const telemetrySettings = await ctx.runQuery(internal.telemetry.getSettingsForUser, {
      userId: checkKey.balance!.userId,
    });
    // TODO: Check the MAX Output + Input of the model and them check if the user can afford it.
    return CreateCompletion(reqData, provider, {
      ctx,
      balanceId: checkKey.balance!._id,
      keyId: checkKey._id,
      byok: true,
      abortSignal: req.signal,
      telemetry: telemetrySettings.enabled
        ? {
            balance: checkKey.balance!._id,
            key: checkKey._id,
            userId: checkKey.balance!.userId,
            requestId: crypto.randomUUID(),
            settings: telemetrySettings,
          }
        : undefined,
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return Response.json(e.issues, { status: 400 });
    }
    console.log(e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});

export const Internal_Chat_Completion = async (
  ctx: GenericActionCtx<any>,
  reqData: ChatCompletions_RequestBody_Type,
  balanceId: Id<"balances">,
  onGeneration?: (generation: Parameters<genCallbackType>[0]) => void,
  telemetry?: TelemetryRequestContext,
  abortSignal?: AbortSignal | null,
) => {
  const provider = await AIBalancer(ctx, balanceId, reqData);
  // TODO: Check the MAX Output + Input of the model and them check if the user can afford it.
  return CreateCompletion(reqData, provider, {
    ctx,
    balanceId,
    byok: true,
    onGeneration,
    telemetry,
    abortSignal,
  });
};

const CreateCompletion = async (
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  info: {
    ctx: GenericActionCtx<any>;
    balanceId: Id<"balances">;
    keyId?: Id<"keys">;
    byok: boolean;
    onGeneration?: (generation: Parameters<genCallbackType>[0]) => void;
    telemetry?: TelemetryRequestContext;
    abortSignal?: AbortSignal | null;
  },
): Promise<Response> => {
  const genID = `gen-${crypto.randomUUID()}`;
  const telemetry = info.telemetry
    ? {
        isEnabled: true,
        functionId: "radium.gateway",
        recordInputs: info.telemetry.settings.recordInputs,
        recordOutputs: info.telemetry.settings.recordOutputs,
        integrations: createTelemetryIntegrations({
          ctx: info.ctx,
          ...info.telemetry,
          source: "gateway" as const,
          functionId: "radium.gateway",
        }),
      }
    : { isEnabled: false };

  if (reqData.stream) {
    let originalGenID: string;
    let finishedReason: string;
    let streamCanceled = false;

    const providerGen = await StreamCompletion(
      reqData,
      provider,
      async (genCompletion) => {
        // End of the stream
        info.onGeneration?.(genCompletion);
        await info.ctx.runMutation(internal.key.billKey, {
          bill: {
            balance: info.balanceId,
            key: info.keyId,
          },
          request: {
            api: "chat_completions",
            //app
            byok: info.byok,
            canceled: streamCanceled,
            model_slug: reqData.model,
            provider: provider.info.slug,
            stream: reqData.stream ?? false,
            prompt_cache_key: reqData.prompt_cache_key || reqData.user,
            telemetry_request_id: info.telemetry?.requestId,
          },
          response: {
            gen_id: genCompletion.genId || originalGenID || genID,
            finish_reason: finishedReason || "stop",
            gen_time: genCompletion.genTime,
            ttft: genCompletion.ttft,
            provider_gen_id: genCompletion.genId || originalGenID || genID,
            usage: {
              completion_tokens: genCompletion.usage.completion_tokens,
              prompt_tokens: genCompletion.usage.prompt_tokens,
              completion_tokens_details: {
                reasoning_tokens:
                  genCompletion.usage.completion_tokens_details.reasoning_tokens ?? undefined,
              },
              prompt_tokens_details: {
                cached_tokens: genCompletion.usage.prompt_tokens_details.cached_tokens ?? undefined,
                written_cache_tokens:
                  genCompletion.usage.prompt_tokens_details.written_cache_tokens ?? undefined,
              },
              total_tokens:
                genCompletion.usage.completion_tokens + genCompletion.usage.prompt_tokens,
            },
          },
        });
      },
      telemetry,
      info.abortSignal,
    );

    const customReadable = new ReadableStream({
      async start(controller) {
        const controllerOutput = (text: string) =>
          controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));

        for await (const providerChunk of convertStreamToAsyncIterator<string>(providerGen)) {
          try {
            let chunk = JSON.parse(providerChunk) as ChatCompletions_Streaming_Chunk_Type;
            if (!originalGenID) originalGenID = chunk.id;
            if (chunk.choices[0].finish_reason) finishedReason = chunk.choices[0].finish_reason;

            chunk.id = genID;
            chunk.provider = provider.info.slug;
            controllerOutput(JSON.stringify(chunk));
          } catch (E) {}
        }

        controllerOutput("[DONE]");
        controller.close();
      },
      async cancel(reason?) {
        streamCanceled = true;
        await (providerGen as ReadableStream<any>).cancel(reason);
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
    let originalGenID;
    let finishedReason: string;
    let generation = await NonStreamingCompletion(
      reqData,
      provider,
      async (genCompletion) => {
        // End of the stream
        info.onGeneration?.(genCompletion);
        await info.ctx.runMutation(internal.key.billKey, {
          bill: {
            balance: info.balanceId,
            key: info.keyId,
          },
          request: {
            api: "chat_completions",
            //app
            byok: info.byok,
            canceled: false, //streamCanceled
            model_slug: reqData.model,
            provider: provider.info.slug,
            stream: reqData.stream ?? false,
            prompt_cache_key: reqData.prompt_cache_key || reqData.user,
            telemetry_request_id: info.telemetry?.requestId,
          },
          response: {
            gen_id: genCompletion.genId || originalGenID || genID,
            finish_reason: finishedReason || "stop",
            gen_time: genCompletion.genTime,
            ttft: genCompletion.ttft,
            provider_gen_id: genCompletion.genId || originalGenID || genID,
            usage: {
              completion_tokens: genCompletion.usage.completion_tokens,
              prompt_tokens: genCompletion.usage.prompt_tokens,
              completion_tokens_details: {
                reasoning_tokens:
                  genCompletion.usage.completion_tokens_details.reasoning_tokens ?? undefined,
              },
              prompt_tokens_details: {
                cached_tokens: genCompletion.usage.prompt_tokens_details.cached_tokens ?? undefined,
                written_cache_tokens:
                  genCompletion.usage.prompt_tokens_details.written_cache_tokens ?? undefined,
              },
              total_tokens:
                genCompletion.usage.completion_tokens + genCompletion.usage.prompt_tokens,
            },
          },
        });
      },
      telemetry,
      info.abortSignal,
    );
    generation.id = genID;
    generation.provider = provider.info.slug;
    finishedReason = generation.choices[0].finish_reason || "stop";

    return Response.json(generation);
  }
};
