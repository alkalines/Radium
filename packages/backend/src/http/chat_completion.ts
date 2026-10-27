import { api, internal } from "../../convex/_generated/api";
import {
  ChatCompletions_RequestBody,
  type ChatCompletions_RequestBody_Type,
  type ChatCompletions_Streaming_Chunk_Type,
} from "@/types/openai/types";
import * as z from "zod";
import {
  CompletionStreamError,
  NonStreamingCompletion,
  StreamCompletion,
  type genCallbackType,
} from "@/translators/openai";
import type { RoutedProvider } from "@/routing/connector";
import {
  RoutingError,
  routeWithFailover,
  type AttemptOutcome,
  type RoutingRequest,
} from "@/routing/execute";
import { boundedMessage, upstreamFailureFromError, type UpstreamFailure } from "@/routing/failures";
import { routingPreferencesFromRequest } from "@/routing/preferences";
import { extractRoutingSession } from "@/routing/session";
import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import {
  startCapture,
  type CaptureResult,
  type TelemetryCapture,
  type TelemetryRequestContext,
} from "@/telemetry/capture";

/** Server-derived Chatroom identity carried through an internal Gateway call. */
export type ChatRequestContext = {
  actor: string;
  chatId: Id<"aisdk_chats">;
};

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
  /** Request JSON as received, before zod parsing drops unknown fields; captured for telemetry. */
  rawBody?: unknown;
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
    const rawBody: unknown = await req.json();
    const reqData = ChatCompletions_RequestBody.parse(rawBody);

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
      internal.observability.telemetry.getSettingsForWorkspace,
      { workspace: workspaceId },
    );
    // TODO: Check the model's maximum input and output limits before dispatch.
    return createCompletion(reqData, {
      rawBody,
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
  rawBody?: unknown,
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
    rawBody,
    abortSignal,
    chatContext: effectiveChatContext,
  });
};

/**
 * Persist shared completion attribution and usage after the caller notifies its generation
 * listener. Returns the stored completion's ID so telemetry can link to it.
 */
async function recordCompletion(
  requestBody: ChatCompletions_RequestBody_Type,
  provider: RoutedProvider,
  info: CompletionInfo,
  generation: Parameters<genCallbackType>[0],
  details: CompletionRecordDetails,
): Promise<Id<"chat_completions"> | null> {
  const providerGenerationId =
    generation.genId || details.originalProviderGenerationId || details.generationId;

  return await info.ctx.runMutation(internal.keys.recordCompletion, {
    bill: completionBill(info),
    ...completionActor(info),
    request: {
      api: "chat_completions",
      byok: info.byok,
      canceled: details.canceled,
      model_slug: requestBody.model,
      provider: provider.info.slug,
      credential: provider.info.credential.id,
      stream: requestBody.stream ?? false,
      prompt_cache_key: requestBody.prompt_cache_key || requestBody.user,
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
 * Telemetry capture starts before routing and is finalized on every exit path.
 */
const createCompletion = async (
  reqData: ChatCompletions_RequestBody_Type,
  info: CompletionInfo,
): Promise<Response> => {
  const generationId = `gen-${crypto.randomUUID()}`;
  const routing: RoutingRequest = {
    workspace: info.workspaceId,
    model: reqData.model,
    preferences: routingPreferencesFromRequest(reqData.provider),
    session: extractRoutingSession(reqData, info.headers, info.chatContext?.chatId),
    signal: info.abortSignal,
  };
  const capture = info.telemetry
    ? startCapture(info.ctx, info.telemetry, {
        rawBody: info.rawBody ?? reqData,
        headers: info.headers,
        session: routing.session,
        source: info.telemetry.chatId ? "chatroom" : "gateway",
        model: reqData.model,
        stream: reqData.stream ?? false,
        startedAt: Date.now(),
      })
    : undefined;

  try {
    if (reqData.stream) {
      return await createStreamingCompletion(reqData, info, routing, generationId, capture);
    }

    const routed = await routeWithFailover(
      info.ctx,
      routing,
      withAttemptRecording(capture, info.abortSignal, async (provider) => {
        try {
          const generation = await NonStreamingCompletion(
            reqData,
            provider,
            async (genCompletion) => {
              capture?.recordGeneration(genCompletion);
              info.onGeneration?.(genCompletion);
              const completionId = await recordCompletion(reqData, provider, info, genCompletion, {
                generationId,
                canceled: false,
              });
              capture?.recordChatCompletion(completionId);
            },
            info.abortSignal,
          );
          return { ok: true as const, value: generation };
        } catch (error) {
          return { ok: false as const, failure: completionFailure(error, false) };
        }
      }),
    );

    const generation = routed.value;
    capture?.outputResponse(generation);
    generation.id = generationId;
    generation.provider = routed.provider.info.slug;
    await capture?.finish({ status: "ok" });
    return Response.json(generation);
  } catch (error) {
    await capture?.finish(captureFailure(error, info.abortSignal));
    if (error instanceof RoutingError) return routingErrorResponse(error);
    throw error;
  }
};

async function createStreamingCompletion(
  reqData: ChatCompletions_RequestBody_Type,
  info: CompletionInfo,
  routing: RoutingRequest,
  generationId: string,
  capture: TelemetryCapture | undefined,
): Promise<Response> {
  let originalProviderGenerationId: string | undefined;
  let finishReason: string | undefined;
  let streamCanceled = false;

  const routed = await routeWithFailover(
    info.ctx,
    routing,
    withAttemptRecording(capture, info.abortSignal, async (provider) => {
      // Only the committed attempt may record usage; failed attempts are retried elsewhere.
      let committed = false;
      try {
        const providerGen = await StreamCompletion(
          reqData,
          provider,
          async (genCompletion) => {
            if (!committed) return;
            capture?.recordGeneration(genCompletion);
            // The listener may synchronously cancel the stream; read its state afterward.
            info.onGeneration?.(genCompletion);
            const completionId = await recordCompletion(reqData, provider, info, genCompletion, {
              generationId,
              originalProviderGenerationId,
              finishReason,
              canceled: streamCanceled,
            });
            capture?.recordChatCompletion(completionId);
          },
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
    }),
  );

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
        // Capture reads the provider's own chunk, before its ID and provider are rewritten.
        capture?.outputChunk(chunk);
        if (!originalProviderGenerationId) originalProviderGenerationId = chunk.id;
        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

        chunk.id = generationId;
        chunk.provider = providerSlug;
        enqueueSseEvent(JSON.stringify(chunk));
      };

      let result: CaptureResult = { status: "ok" };
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
          result =
            failure.kind === "aborted" || info.abortSignal?.aborted
              ? { status: "aborted", canceled: true }
              : { status: "error", error: { message: failure.message, status: failure.status } };
        }
      }
      // A canceled stream is finalized by `cancel`, after the translator has settled usage.
      if (streamCanceled) return;
      await capture?.finish(result);
      controller.close();
    },
    async cancel(reason?) {
      streamCanceled = true;
      await reader.cancel(reason);
      await capture?.finish({ status: "aborted", canceled: true });
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

/**
 * Record each routing attempt on the capture, in dispatch order. A streaming attempt succeeds
 * once its first payload arrives, so its duration is the time to first payload.
 */
function withAttemptRecording<T>(
  capture: TelemetryCapture | undefined,
  signal: AbortSignal | null | undefined,
  attempt: (provider: RoutedProvider) => Promise<AttemptOutcome<T>>,
) {
  if (!capture) return attempt;
  return async (provider: RoutedProvider) => {
    const startedAt = Date.now();
    const outcome = await attempt(provider);
    const base = {
      provider: provider.info.slug,
      credential: provider.info.credential.id,
      providerModel: provider.info.modelId,
      startedAt,
      durationMs: Date.now() - startedAt,
    };
    if (outcome.ok) {
      capture.attempt({ ...base, outcome: "ok" });
    } else {
      const { failure } = outcome;
      capture.attempt({
        ...base,
        outcome: failure.kind === "aborted" || signal?.aborted ? "aborted" : "error",
        status: failure.status,
        errorKind: failure.kind,
        message: boundedMessage(failure.message),
      });
    }
    return outcome;
  };
}

/** Capture result for a request that failed before any response was committed. */
function captureFailure(error: unknown, signal: AbortSignal | null | undefined): CaptureResult {
  if (error instanceof RoutingError) {
    return { status: "error", error: { message: error.message, status: error.status } };
  }
  if (signal?.aborted) return { status: "aborted", canceled: true };
  return {
    status: "error",
    error: { message: error instanceof Error ? error.message : String(error) },
  };
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
