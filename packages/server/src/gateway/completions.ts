import { and, eq } from "drizzle-orm";
import type { Id } from "contracts/wire";
import type { Runtime } from "../runtime";
import { chatVisibleInWorkspace } from "../chatroom/access";
import { dispatchJobs } from "../jobs/outbox";
import {
  startCapture,
  type CaptureResult,
  type TelemetryCapture,
  type TelemetryRequestContext,
} from "../telemetry/capture";
import { estimateCompletionCost, servedTierQuote } from "../usage/pricing";
import { recordChatCompletion } from "../usage/completions";
import { scheduleBudgetRefresh } from "./limits/store";
import type {
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "./openai/types";
import type { RoutedProvider } from "./routing/connector";
import {
  RoutingError,
  routeWithFailover,
  type AttemptOutcome,
  type RoutingRequest,
} from "./routing/execute";
import {
  boundedMessage,
  gatewayErrorPayload,
  upstreamFailureFromError,
  type UpstreamFailure,
} from "./routing/failures";
import { createInternalModel, type InternalModelSelection } from "./routing/internal-model";
import { routingPreferencesFromRequest } from "./routing/preferences";
import { inferenceModeTier } from "./routing/selection";
import { clientSessionId, extractRoutingSession } from "./routing/session";
import { workspaceCredentials } from "./schema";
import {
  CompletionRequestError,
  CompletionStreamError,
  NonStreamingCompletion,
  StreamCompletion,
  type CompletionOptions,
  type genCallbackType,
} from "./translators/openai";

/**
 * Trusted in-process AI SDK models for Chatroom runs, served by the ordinary workspace Gateway
 * pipeline (routing, failover, completion recording, telemetry). Prompts, reasoning metadata
 * and provider-defined tools do not cross a lossy wire codec. The workspace and chat identity
 * must come from the caller's chat authorization; `telemetry` is the capture context when
 * capture is on (a fresh request id is added per model call).
 */
export function createInternalGatewayProvider(
  runtime: Runtime,
  workspace: string,
  selection: InternalModelSelection,
  chat: ChatRequestContext,
  options: {
    onGeneration?: (generation: SettledGeneration) => void;
    telemetry?: Omit<TelemetryRequestContext, "requestId">;
  } = {},
) {
  return (modelId: string) =>
    createInternalModel(modelId, selection, (request, completionOptions, rawBody, signal) =>
      createCompletion(runtime, request, {
        workspace,
        chat,
        rawBody,
        abortSignal: signal,
        completionOptions,
        onGeneration: options.onGeneration,
        telemetry: options.telemetry && { ...options.telemetry, requestId: crypto.randomUUID() },
      }),
    );
}

type Generation = Parameters<genCallbackType>[0];

/** A settled generation with its cost estimate, for listeners and telemetry. */
export type SettledGeneration = Generation & {
  estimatedCost?: number;
  costSource?: "reported" | "estimated";
  provider?: string;
  model?: string;
};

/**
 * Server-derived identity of one completion request: a direct Gateway call (`apiKey`) or a
 * trusted in-process Chatroom call (`chat`, whose identity comes from the caller's chat
 * authorization).
 */
export type CompletionRequestInfo = {
  workspace: string;
  /** The Gateway key of a direct call. */
  apiKey?: string;
  /** The Chatroom chat and the user it runs for. */
  chat?: ChatRequestContext;
  /** Client request headers: session-affinity key and telemetry header allowlist. */
  headers?: Headers;
  /** Telemetry capture context when capture is on for this request. */
  telemetry?: TelemetryRequestContext;
  /** Request JSON as received, before zod parsing drops unknown fields; captured for telemetry. */
  rawBody?: unknown;
  abortSignal?: AbortSignal | null;
  /** Notified once the committed generation settles (Chatroom usage display). */
  onGeneration?: (generation: SettledGeneration) => void;
  /** Trusted in-process model call; never accepted from public request JSON. */
  completionOptions?: CompletionOptions;
};

/** Server-derived Chatroom identity carried through an internal Gateway call. */
export type ChatRequestContext = { actor: string; chatId: string };

type CompletionRecordDetails = {
  generationId: string;
  originalProviderGenerationId?: string;
  finishReason?: string;
  canceled: boolean;
};

/**
 * Routes one OpenAI-compatible chat completion and produces its response. Streaming attempts
 * commit on the provider's first payload, so earlier failures fail over and later ones reach the
 * client as an SSE error event. Routing exhaustion maps to the last upstream status. Telemetry
 * capture starts before routing and is finalized on every exit path. Configuration errors
 * (`RoutingConfigurationError`) propagate to the caller.
 */
export async function createCompletion(
  runtime: Runtime,
  request: ChatCompletions_RequestBody_Type,
  info: CompletionRequestInfo,
): Promise<Response> {
  const generationId = `gen-${crypto.randomUUID()}`;
  const routing: RoutingRequest = {
    workspace: info.workspace,
    model: request.model,
    serviceTier: request.service_tier ?? undefined,
    inferenceMode: request.inference_mode,
    preferences: routingPreferencesFromRequest(request.provider),
    session: await extractRoutingSession(
      request,
      info.headers,
      info.chat?.chatId,
      info.workspace,
      runtime.config.TELEMETRY_HASH_SECRET,
    ),
    signal: info.abortSignal,
  };
  const capture = info.telemetry
    ? startCapture(runtime, info.telemetry, {
        rawBody: info.rawBody ?? request,
        headers: info.headers,
        session: routing.session,
        source: info.chat ? "chatroom" : "gateway",
        model: request.model,
        requestedServiceTier: routing.serviceTier,
        stream: request.stream ?? false,
        startedAt: Date.now(),
      })
    : undefined;

  try {
    if (request.stream) {
      return await createStreamingCompletion(runtime, request, info, routing, generationId, capture);
    }

    const routed = await routeWithFailover(
      runtime,
      routing,
      withAttemptRecording(capture, info.abortSignal, async (provider) => {
        try {
          const generation = await NonStreamingCompletion(
            request,
            provider,
            async (settled) => {
              await settle(runtime, request, provider, info, capture, settled, () => ({
                generationId,
                canceled: false,
              }));
            },
            info.abortSignal,
            info.completionOptions,
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
}

async function createStreamingCompletion(
  runtime: Runtime,
  request: ChatCompletions_RequestBody_Type,
  info: CompletionRequestInfo,
  routing: RoutingRequest,
  generationId: string,
  capture: TelemetryCapture | undefined,
): Promise<Response> {
  let originalProviderGenerationId: string | undefined;
  let finishReason: string | undefined;
  let streamCanceled = false;

  const routed = await routeWithFailover(
    runtime,
    routing,
    withAttemptRecording(capture, info.abortSignal, async (provider) => {
      // Only the committed attempt may record usage; failed attempts are retried elsewhere.
      let committed = false;
      try {
        const stream = await StreamCompletion(
          request,
          provider,
          async (settled) => {
            if (!committed) return;
            await settle(runtime, request, provider, info, capture, settled, () => ({
              generationId,
              originalProviderGenerationId,
              finishReason,
              canceled: streamCanceled,
            }));
          },
          info.abortSignal,
          info.completionOptions,
        );
        const reader = stream.getReader();
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
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const enqueueEvent = (text: string) => controller.enqueue(encoder.encode(`data: ${text}\n\n`));
      const forward = (providerChunk: unknown) => {
        if (typeof providerChunk !== "string") return;
        let chunk: ChatCompletions_Streaming_Chunk_Type;
        try {
          chunk = JSON.parse(providerChunk) as ChatCompletions_Streaming_Chunk_Type;
        } catch {
          // The translator's [DONE] marker is not a JSON chunk; the SSE sentinel follows below.
          return;
        }
        // Capture reads the provider's own chunk, before its id and provider are rewritten.
        capture?.outputChunk(chunk);
        originalProviderGenerationId ??= chunk.id;
        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        chunk.id = generationId;
        chunk.provider = providerSlug;
        enqueueEvent(JSON.stringify(chunk));
      };

      let result: CaptureResult = { status: "ok" };
      try {
        forward(first);
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          forward(next.value);
        }
        enqueueEvent("[DONE]");
      } catch (error) {
        if (!streamCanceled) {
          // Output already reached the client, so the failure is reported, never retried.
          const failure = completionFailure(error, true);
          await routed.reportLateFailure(failure);
          enqueueEvent(JSON.stringify({ error: gatewayErrorPayload(failure, providerSlug) }));
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
    async cancel(reason) {
      streamCanceled = true;
      await reader.cancel(reason);
      await capture?.finish({ status: "aborted", canceled: true });
    },
  });

  return new Response(body, {
    headers: {
      Connection: "keep-alive",
      "Content-Encoding": "none",
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}

/**
 * Settles a committed generation: telemetry, the caller's listener, then the completion row.
 * `details` is read after the listener, which may cancel the stream. Recording failures are
 * logged, never thrown into the response (the generation already reached the client).
 */
async function settle(
  runtime: Runtime,
  request: ChatCompletions_RequestBody_Type,
  provider: RoutedProvider,
  info: CompletionRequestInfo,
  capture: TelemetryCapture | undefined,
  generation: Generation,
  details: () => CompletionRecordDetails,
) {
  const quote = generation.usageUnavailable
    ? undefined
    : servedTierQuote(
        !request.service_tier || request.service_tier === "auto"
          ? inferenceModeTier(provider.info.inferenceMode?.provider_body)
          : request.service_tier,
        generation.serviceTier,
        provider.info.quote,
        provider.info.service_tiers,
        provider.info.pricing,
      );
  const estimatedCost = estimateCompletionCost(
    generation.usage,
    quote,
    generation.cacheWriteTtlUnknown,
  ).estimatedCost;
  const settled: SettledGeneration = {
    ...generation,
    estimatedCost,
    provider: provider.info.slug,
    model: request.model,
    costSource:
      generation.reportedCost !== undefined
        ? "reported"
        : estimatedCost !== undefined
          ? "estimated"
          : undefined,
  };
  capture?.recordGeneration(settled);
  // The listener may synchronously cancel the stream; the record reads that state afterwards.
  info.onGeneration?.(settled);
  try {
    const completion = await recordCompletion(
      runtime,
      request,
      provider,
      info,
      generation,
      quote,
      details(),
    );
    capture?.recordChatCompletion(completion);
  } catch (error) {
    console.error(
      "Failed to record a Gateway completion:",
      error instanceof Error ? error.name : "unknown error",
    );
  }
}

/**
 * Persists the completion (attribution, tokens, cost estimate) and, for a credential with a
 * metered budget, queues the debounced budget recompute in the same transaction. The serving
 * credential is locked `for key share`, so a concurrent removal waits for the row to commit
 * instead of failing it; a credential already removed is recorded as `null`.
 */
async function recordCompletion(
  runtime: Runtime,
  request: ChatCompletions_RequestBody_Type,
  provider: RoutedProvider,
  info: CompletionRequestInfo,
  generation: Generation,
  servedQuote: RoutedProvider["info"]["quote"],
  details: CompletionRecordDetails,
) {
  const { db } = runtime.drivers;
  // Direct Gateway calls keep the client's own session id, so Activity can join an agent's calls
  // to its session; Chatroom calls are attributed to their chat instead.
  const clientSession = info.chat ? undefined : clientSessionId(request, info.headers);
  const requestedTier = request.service_tier === "fast" ? "priority" : request.service_tier;
  const { id, jobs } = await db.transaction(async (tx) => {
    const [credential] = await tx
      .select()
      .from(workspaceCredentials)
      .where(
        and(
          eq(workspaceCredentials.id, provider.info.credential.id),
          eq(workspaceCredentials.workspace, info.workspace),
          eq(workspaceCredentials.provider, provider.info.slug),
        ),
      )
      .for("key share");
    // A chat completion must be for a chat its actor can see inside this workspace.
    if (
      info.chat &&
      !(await chatVisibleInWorkspace(tx, info.chat.actor, info.chat.chatId, info.workspace))
    ) {
      throw new Error("The completion's chat is not visible to its actor in its workspace.");
    }
    const id = await recordChatCompletion(tx, {
      workspace: info.workspace,
      apiKey: info.apiKey ?? null,
      ...(info.chat ? { chat: info.chat.chatId, userId: info.chat.actor } : {}),
      ...(clientSession ? { clientSession } : {}),
      modelSlug: request.model,
      provider: provider.info.slug,
      credential: credential?.id ?? null,
      streamed: request.stream ?? false,
      canceled: details.canceled,
      requestedServiceTier: request.service_tier ?? undefined,
      inferenceMode: provider.info.inferenceMode?.id,
      quote: provider.info.quote,
      quoteSource:
        provider.info.service_tiers?.find((tier) => tier.id === requestedTier)?.source ??
        (request.service_tier && !["auto", "default"].includes(request.service_tier)
          ? "configured"
          : "catalog"),
      genId: details.generationId,
      providerGenId:
        generation.genId || details.originalProviderGenerationId || details.generationId,
      finishReason: details.finishReason || "stop",
      genTime: generation.genTime,
      ttft: generation.ttft,
      usage: generation.usage,
      servedServiceTier: generation.serviceTier,
      servedQuote,
      reportedCost: generation.reportedCost,
      upstreamInferenceCost: generation.upstreamInferenceCost,
      cacheWriteTtlUnknown: generation.cacheWriteTtlUnknown,
    });
    const job = credential ? await scheduleBudgetRefresh(tx, credential) : null;
    return { id, jobs: [job] };
  });
  runtime.defer(dispatchJobs(runtime, jobs));
  return id;
}

/**
 * Records each routing attempt on the capture, in dispatch order. A streaming attempt succeeds
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
      // The telemetry contract brands ids; ours are plain text.
      credential: provider.info.credential.id as Id<"workspace_credentials">,
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
    error: { message: boundedMessage(error instanceof Error ? error.message : String(error)) },
  };
}

/** Unwraps translator errors so routing sees the upstream status and headers. */
function completionFailure(error: unknown, outputStarted: boolean): UpstreamFailure {
  if (error instanceof CompletionRequestError) {
    return { kind: "http", status: 400, message: boundedMessage(error.message), outputStarted };
  }
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
        code: error.upstreamCode ?? error.status,
        status: error.status,
        ...(error.upstreamType ? { type: error.upstreamType } : {}),
        ...(error.provider ? { provider: error.provider } : {}),
      },
    },
    { status: error.status, headers },
  );
}
