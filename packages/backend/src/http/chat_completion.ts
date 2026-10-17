import { api, internal } from "../../convex/_generated/api";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
  type ChatCompletions_Streaming_Chunk_Type,
} from "@/types/openai/types";
import AIBalancer from "@/ai_balancer";
import * as z from "zod";
import {
  NonStreamingCompletion,
  StreamCompletion,
  type genCallbackType,
} from "@/translators/openai";
import { convertStreamToAsyncIterator } from "@/tools/chunkReader";
import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import {
  createTelemetryIntegrations,
  type ChatRequestContext,
  type TelemetryRequestContext,
} from "@/telemetry/convex";

type CompletionInfo = {
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
};

type CompletionRecordDetails = {
  generationId: string;
  originalProviderGenerationId?: string;
  finishReason?: string;
  canceled: boolean;
};

/** Handle an authenticated OpenAI-compatible chat-completion request. */
export async function handleChatCompletion(ctx: ActionCtx, req: Request): Promise<Response> {
  try {
    const reqData = ChatCompletions_RequestBody.parse(await req.json());

    const bearerToken = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!bearerToken || bearerToken === "")
      return Response.json(
        {
          error: {
            message: "The Authorization field is empty!",
            code: 401,
          },
        },
        { status: 401 },
      );
    // Treat lookup failures like an invalid key rather than exposing backend errors.
    const keyInfo = await ctx
      .runQuery(api.keys.getKeyInfo, {
        key: bearerToken,
      })
      .catch(() => {});
    if (!keyInfo)
      return Response.json(
        {
          error: {
            message: "The Authorization is invalid!",
            code: 401,
          },
        },
        { status: 401 },
      );
    const apiKey = "apiKey" in keyInfo ? keyInfo.apiKey : undefined;
    const legacyBalance = "legacyBalance" in keyInfo ? keyInfo.legacyBalance : undefined;
    const legacyKey = "legacyKey" in keyInfo ? keyInfo.legacyKey : undefined;
    const workspaceId =
      keyInfo.workspace ??
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
    const telemetrySettings = await ctx.runQuery(
      internal.observability.aiTraces.getSettingsForWorkspace,
      {
        workspace: workspaceId,
      },
    );
    // TODO: Check the model's maximum input and output limits before dispatch.
    return createCompletion(reqData, provider, {
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
            userId: keyInfo.userId,
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
}

/**
 * Run a chat completion for a server-authorized workspace. Callers that provide
 * chat context must derive its identity and chat ID from their authorization
 * check; completion persistence revalidates that attribution.
 */
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
  // TODO: Check the model's maximum input and output limits before dispatch.
  return createCompletion(reqData, provider, {
    ctx,
    workspaceId,
    byok: true,
    onGeneration,
    telemetry,
    abortSignal,
    chatContext: effectiveChatContext,
  });
};

/** Persist shared completion attribution and usage after the caller notifies its generation listener. */
async function recordCompletion(
  requestBody: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  info: CompletionInfo,
  generation: Parameters<genCallbackType>[0],
  details: CompletionRecordDetails,
): Promise<void> {
  const providerGenerationId =
    generation.genId || details.originalProviderGenerationId || details.generationId;

  await info.ctx.runMutation(internal.keys.recordCompletion, {
    bill: completionBill(info),
    ...completionActor(info),
    request: {
      api: "chat_completions",
      byok: info.byok,
      canceled: details.canceled,
      model_slug: requestBody.model,
      provider: provider.info.slug,
      stream: requestBody.stream ?? false,
      prompt_cache_key: requestBody.prompt_cache_key || requestBody.user,
      telemetry_request_id: info.telemetry?.requestId,
    },
    response: {
      gen_id: details.generationId,
      finish_reason: details.finishReason || "stop",
      gen_time: generation.genTime,
      ttft: generation.ttft,
      provider_gen_id: providerGenerationId,
      usage: {
        completion_tokens: generation.usage.completion_tokens,
        prompt_tokens: generation.usage.prompt_tokens,
        completion_tokens_details: {
          reasoning_tokens:
            generation.usage.completion_tokens_details.reasoning_tokens ?? undefined,
        },
        prompt_tokens_details: {
          cached_tokens: generation.usage.prompt_tokens_details.cached_tokens ?? undefined,
          written_cache_tokens:
            generation.usage.prompt_tokens_details.written_cache_tokens ?? undefined,
        },
        total_tokens: generation.usage.completion_tokens + generation.usage.prompt_tokens,
      },
    },
  });
}

const createCompletion = async (
  reqData: ChatCompletions_RequestBody_Type,
  provider: Awaited<ReturnType<typeof AIBalancer>>,
  info: CompletionInfo,
): Promise<Response> => {
  const generationId = `gen-${crypto.randomUUID()}`;
  const aiSdkTelemetry = info.telemetry
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
    let originalProviderGenerationId: string | undefined;
    let finishReason: string | undefined;
    let streamCanceled = false;

    const providerGen = await StreamCompletion(
      reqData,
      provider,
      async (genCompletion) => {
        // The listener may synchronously cancel the stream; read its state afterward.
        info.onGeneration?.(genCompletion);
        await recordCompletion(reqData, provider, info, genCompletion, {
          generationId,
          originalProviderGenerationId,
          finishReason,
          canceled: streamCanceled,
        });
      },
      aiSdkTelemetry,
      info.abortSignal,
    );

    const sseStream = new ReadableStream({
      async start(controller) {
        const enqueueSseEvent = (text: string) =>
          controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));

        for await (const providerChunk of convertStreamToAsyncIterator<string>(providerGen)) {
          try {
            const chunk = JSON.parse(providerChunk) as ChatCompletions_Streaming_Chunk_Type;
            if (!originalProviderGenerationId) originalProviderGenerationId = chunk.id;
            if (chunk.choices[0].finish_reason) finishReason = chunk.choices[0].finish_reason;

            chunk.id = generationId;
            chunk.provider = provider.info.slug;
            enqueueSseEvent(JSON.stringify(chunk));
          } catch {
            // The inner translator's [DONE] marker is not a JSON chunk; emit the SSE sentinel below.
          }
        }

        enqueueSseEvent("[DONE]");
        controller.close();
      },
      async cancel(reason?) {
        streamCanceled = true;
        await (providerGen as ReadableStream<any>).cancel(reason);
      },
    });

    return new Response(sseStream, {
      headers: {
        Connection: "keep-alive",
        "Content-Encoding": "none",
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  } else {
    const generation = await NonStreamingCompletion(
      reqData,
      provider,
      async (genCompletion) => {
        info.onGeneration?.(genCompletion);
        await recordCompletion(reqData, provider, info, genCompletion, {
          generationId,
          canceled: false,
        });
      },
      aiSdkTelemetry,
      info.abortSignal,
    );
    generation.id = generationId;
    generation.provider = provider.info.slug;

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
