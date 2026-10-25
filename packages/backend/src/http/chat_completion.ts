import { api, internal } from "../../convex/_generated/api";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
  type ChatCompletions_Streaming_Chunk_Type,
} from "@/types/openai/types";
import * as z from "zod";
import type { TelemetryOptions } from "ai";
import {
  CompletionStreamError,
  NonStreamingCompletion,
  StreamCompletion,
  type genCallbackType,
} from "@/translators/openai";
import type { RoutedProvider } from "@/routing/connector";
import { RoutingError, routeWithFailover, type RoutingRequest } from "@/routing/execute";
import { upstreamFailureFromError, type UpstreamFailure } from "@/routing/failures";
import { routingPreferencesFromRequest } from "@/routing/preferences";
import { extractRoutingSession } from "@/routing/session";
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
  /** Client request headers, used only to derive the session-affinity key. */
  headers?: Headers;
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

    const telemetrySettings = await ctx.runQuery(
      internal.observability.aiTraces.getSettingsForWorkspace,
      {
        workspace: workspaceId,
      },
    );
    // TODO: Check the model's maximum input and output limits before dispatch.
    return createCompletion(reqData, {
      ctx,
      headers: req.headers,
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
  const effectiveChatContext =
    chatContext ??
    (telemetry?.chatId ? { actor: telemetry.userId, chatId: telemetry.chatId } : undefined);
  // TODO: Check the model's maximum input and output limits before dispatch.
  return createCompletion(reqData, {
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
  provider: RoutedProvider,
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

/**
 * Route the request and produce the OpenAI-compatible response. Streaming attempts commit on
 * the provider's first payload, so earlier failures fail over and later ones are reported to
 * the client as an SSE error event. Routing exhaustion maps to the last upstream status.
 */
const createCompletion = async (
  reqData: ChatCompletions_RequestBody_Type,
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
  const routing: RoutingRequest = {
    workspace: info.workspaceId,
    model: reqData.model,
    preferences: routingPreferencesFromRequest(reqData.provider),
    session: extractRoutingSession(reqData, info.headers, info.chatContext?.chatId),
    signal: info.abortSignal,
  };

  try {
    if (reqData.stream) {
      return await createStreamingCompletion(reqData, info, routing, generationId, aiSdkTelemetry);
    }

    const routed = await routeWithFailover(info.ctx, routing, async (provider) => {
      try {
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
        return { ok: true as const, value: generation };
      } catch (error) {
        return { ok: false as const, failure: completionFailure(error, false) };
      }
    });

    const generation = routed.value;
    generation.id = generationId;
    generation.provider = routed.provider.info.slug;
    return Response.json(generation);
  } catch (error) {
    if (error instanceof RoutingError) return routingErrorResponse(error);
    throw error;
  }
};

async function createStreamingCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  info: CompletionInfo,
  routing: RoutingRequest,
  generationId: string,
  aiSdkTelemetry: TelemetryOptions,
): Promise<Response> {
  let originalProviderGenerationId: string | undefined;
  let finishReason: string | undefined;
  let streamCanceled = false;

  const routed = await routeWithFailover(info.ctx, routing, async (provider) => {
    // Only the committed attempt may record usage; failed attempts are retried elsewhere.
    let committed = false;
    try {
      const providerGen = await StreamCompletion(
        reqData,
        provider,
        async (genCompletion) => {
          if (!committed) return;
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
      const reader = providerGen.getReader();
      const first = await reader.read();
      if (first.done) {
        const failure: UpstreamFailure = {
          kind: "empty_stream",
          message: "Upstream returned an empty stream.",
          outputStarted: false,
        };
        return { ok: false as const, failure };
      }
      committed = true;
      return { ok: true as const, value: { reader, first: first.value } };
    } catch (error) {
      return { ok: false as const, failure: completionFailure(error, false) };
    }
  });

  const { reader, first } = routed.value;
  const providerSlug = routed.provider.info.slug;
  const sseStream = new ReadableStream({
    async start(controller) {
      const enqueueSseEvent = (text: string) =>
        controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
      const forward = (providerChunk: unknown) => {
        if (typeof providerChunk !== "string") return;
        let chunk: ChatCompletions_Streaming_Chunk_Type;
        try {
          chunk = JSON.parse(providerChunk) as ChatCompletions_Streaming_Chunk_Type;
        } catch {
          // The inner translator's [DONE] marker is not a JSON chunk; emit the SSE sentinel below.
          return;
        }
        if (!originalProviderGenerationId) originalProviderGenerationId = chunk.id;
        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

        chunk.id = generationId;
        chunk.provider = providerSlug;
        enqueueSseEvent(JSON.stringify(chunk));
      };

      try {
        forward(first);
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          forward(next.value);
        }
        enqueueSseEvent("[DONE]");
      } catch (error) {
        if (!streamCanceled) {
          // Output already reached the client, so the failure is reported, never retried.
          const failure = completionFailure(error, true);
          await routed.reportLateFailure(failure);
          enqueueSseEvent(
            JSON.stringify({
              error: {
                message: failure.message,
                code: failure.status ?? 502,
                provider: providerSlug,
              },
            }),
          );
        }
      }
      controller.close();
    },
    async cancel(reason?) {
      streamCanceled = true;
      await reader.cancel(reason);
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
}

/** Unwrap translator stream errors so routing sees the upstream status and headers. */
function completionFailure(error: unknown, outputStarted: boolean) {
  if (error instanceof CompletionStreamError) {
    return upstreamFailureFromError(error.upstreamError, outputStarted || error.outputStarted);
  }
  return upstreamFailureFromError(error, outputStarted);
}

/** OpenAI-style error body with the last upstream status; cooling exhaustion adds Retry-After. */
function routingErrorResponse(error: RoutingError) {
  const headers = new Headers();
  if (error.retryAfterMs !== undefined) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  return Response.json(
    {
      error: {
        message: error.message,
        code: error.status,
        ...(error.provider ? { provider: error.provider } : {}),
      },
    },
    { status: error.status, headers },
  );
}

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
