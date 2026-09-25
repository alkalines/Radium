import { httpAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import {
  ChatCompletions_RequestBody,
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "@/types/openai/types";
import AIBalancer from "@/ai_balancer";
import * as z from "zod";
import {
  NonStreamingCompletion,
  StreamCompletion,
  type genCallbackType,
} from "@/translators/openai";
import { convertStreamToAsyncIterator } from "@/tools/chunkReader";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  createTelemetryIntegrations,
  type ChatRequestContext,
  type TelemetryRequestContext,
} from "@/telemetry/convex";

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
    const apiKey = "apiKey" in checkKey ? checkKey.apiKey : undefined;
    const legacyBalance = "legacyBalance" in checkKey ? checkKey.legacyBalance : undefined;
    const legacyKey = "legacyKey" in checkKey ? checkKey.legacyKey : undefined;
    const workspaceId =
      checkKey.workspace ??
      (legacyBalance
        ? await ctx.runMutation(internal.workspaces.ensureForLegacyBalance, {
            balance: legacyBalance,
          })
        : null);
    if (!workspaceId) {
      return Response.json(
        { error: { message: "The API key is not assigned to a workspace.", code: 503 } },
        { status: 503 },
      );
    }

    const provider = await AIBalancer(ctx, workspaceId, reqData);
    const telemetrySettings = await ctx.runQuery(internal.telemetry.getSettingsForWorkspace, {
      workspace: workspaceId,
    });
    // TODO: Check the MAX Output + Input of the model and them check if the user can afford it.
    return CreateCompletion(reqData, provider, {
      ctx,
      workspaceId,
      apiKeyId: apiKey,
      legacyBalanceId: legacyBalance,
      legacyKeyId: legacyKey,
      byok: true,
      abortSignal: req.signal,
      telemetry: telemetrySettings.enabled
        ? {
            workspace: workspaceId,
            apiKey,
            userId: checkKey.userId,
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
  ctx: ActionCtx,
  reqData: ChatCompletions_RequestBody_Type,
  workspaceId: Id<"workspaces">,
  onGeneration?: (generation: Parameters<genCallbackType>[0]) => void,
  telemetry?: TelemetryRequestContext,
  abortSignal?: AbortSignal | null,
  chatContext?: ChatRequestContext,
) => {
  const provider = await AIBalancer(ctx, workspaceId, reqData);
  const effectiveChatContext =
    chatContext ??
    (telemetry?.chatId ? { actor: telemetry.userId, chatId: telemetry.chatId } : undefined);
  // TODO: Check the MAX Output + Input of the model and them check if the user can afford it.
  return CreateCompletion(reqData, provider, {
    ctx,
    workspaceId,
    byok: true,
    onGeneration,
    telemetry,
    abortSignal,
    chatContext: effectiveChatContext,
  });
};

const CreateCompletion = async (
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  info: {
    ctx: ActionCtx;
    workspaceId: Id<"workspaces">;
    apiKeyId?: Id<"api_keys">;
    legacyBalanceId?: Id<"balances">;
    legacyKeyId?: Id<"keys">;
    chatContext?: ChatRequestContext;
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
        await info.ctx.runMutation(internal.key.recordCompletion, {
          bill: completionBill(info),
          ...completionActor(info),
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
        await info.ctx.runMutation(internal.key.recordCompletion, {
          bill: completionBill(info),
          ...completionActor(info),
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

function completionBill(info: {
  workspaceId: Id<"workspaces">;
  apiKeyId?: Id<"api_keys">;
  legacyBalanceId?: Id<"balances">;
  legacyKeyId?: Id<"keys">;
}) {
  return {
    workspace: info.workspaceId,
    ...(info.apiKeyId ? { apiKey: info.apiKeyId } : {}),
    ...(info.legacyBalanceId ? { balance: info.legacyBalanceId } : {}),
    ...(info.legacyKeyId ? { key: info.legacyKeyId } : {}),
  };
}

function completionActor(info: { chatContext?: ChatRequestContext }) {
  return info.chatContext ? { actor: info.chatContext.actor, chatId: info.chatContext.chatId } : {};
}
