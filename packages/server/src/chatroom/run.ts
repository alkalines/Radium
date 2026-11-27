import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { webSearch } from "@exalabs/ai-sdk";
import {
  convertToModelMessages,
  generateId,
  isStepCount,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type ToolApprovalConfiguration,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { ENCRYPTION_PUBLIC_KEY_BYTES } from "radium-crypto";
import { z } from "zod";
import { CODE_MODE_TOOL_NAME, type CodeModeInteractionKind } from "contracts/chatroom/code-mode";
import { createCodeMode, type CodeModeInventory } from "contracts/chatroom/code-mode-runtime";
import { chatInterruption, type ChatInterruption } from "contracts/chatroom/interruption";
import { buildSessionTools } from "contracts/chatroom/session-tools";
import {
  CODE_MODE_TOOL_SET_ID,
  QUESTION_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from "contracts/chatroom/tools";
import { decodeExactBytes } from "contracts/e2ee/contract";
import { sessionNotificationKind } from "contracts/notifications/session";
import { validateChatWorkerSelection } from "contracts/worker/chat-config";
import {
  parseWorkerApprovals,
  workerCodeModeInteractions,
  type WorkerApprovalSignature,
} from "contracts/worker/chat-tools";
import { isAcpChat } from "../acp/sessions";
import type { Database } from "../drivers/types";
import { currentChatPublicKey, type PinnedChatRecipient } from "../e2ee/chat-keys";
import {
  createInternalGatewayProvider,
  type SettledGeneration,
} from "../gateway/completions";
import { modelSupportsTools } from "../gateway/models";
import {
  GatewayInferenceError,
  gatewayErrorPayload,
  upstreamFailureFromError,
  type GatewayErrorPayload,
} from "../gateway/routing/failures";
import { AppError } from "../errors";
import { dispatchJobs } from "../jobs/outbox";
import { kvDelete, kvGet } from "../kv";
import { notify } from "../notifications/notify";
import type { Runtime } from "../runtime";
import { deferChatEvent } from "../streams/events";
import { telemetrySettingsFor, type TelemetryRequestContext } from "../telemetry/capture";
import { chatWorkerSelection } from "../worker/chat-selection";
import {
  buildWorkerChatTools,
  resolveWorkerChatTransport,
  workerChatApprovalSecret,
} from "../worker/chat-tools";
import { activeWorkspaceWorkers } from "../worker/workers";
import { chatAccess, requireChatAccess, type Chat, type ChatWorkspace } from "./access";
import { EXA_TOOL_CREDENTIAL_PROVIDER, toolNamePrefix, uniqueToolName } from "./aisdk-tools";
import { touchChat, saveSealedTitle } from "./chats";
import { awaitInteractionResponse, closeInteraction, openInteraction } from "./code-mode";
import { resolveStoredFiles, storedFileUrls } from "./files";
import { requestRunStop, runStopKey, runStreamPath } from "./run-streams";
import { chatMessageHeads, saveSealedChatMessages } from "./messages";
import { chatRuns, chats } from "./schema";
import { openFileBytes, parseFileFragment, sealChatMessages, sealChatTitle, stripFileFragment } from "./sealing";
import { resolveChatTools, resolveSystemPrompt, titleModelFor } from "./settings";
import { chatSystemPrompt } from "./system-prompt";
import { firstUserMessageText, generateChatTitle } from "./titles";
import { builtinToolCredential, mcpBearerToken } from "./tools";
import { toExaCountry } from "./user-location";

/**
 * `POST /api/chat`: one built-in reply generation (Convex `src/http/aisdk.chat.ts`), written to
 * the run's stream `c/<chat>/runs/<run>` (`docs/Backend_Migration/Live_Data.md`, Built-in Chat
 * Runs). The response is `201` with the stream's location; the sender reads it like every other
 * Tab and device, through the authorizing `/api/streams` proxy, and a reload resumes from the start.
 *
 * - Session auth, then the Chatroom access function; ACP chats use the Worker transport.
 * - Every chat is keyed: the turn is sealed to exactly the key the sender's client prepared
 *   (`recipientKey`), checked before the billed generation and again when saving.
 * - Admission is the `chat_runs` partial unique index: one active run per chat, a second sender
 *   gets `409`. The run row ends on finish, error and stop; its lease is renewed while it runs
 *   and the retention job fails runs whose lease went stale.
 * - The run is detached: on long-lived presets generation continues after the sender's request
 *   ends, and only `chats.stop` (a Valkey flag the generator polls) stops it.
 * - The stream holds the reply in plaintext, like the backend's own processing of the turn. It
 *   is closed when the run ends and deleted with the run row by retention, 10 to 15 minutes
 *   later; the sealed `chat_messages` rows remain the only stored copy.
 * - Worker tools (`src/worker/chat-tools.ts`) are the workspace owner's only: each stage is sealed
 *   to the paired Worker, approved calls carry the user's signature (`approvals`), and the tool
 *   waits for the result on the chat's signal stream, ending with the run on `chats.stop`.
 */

/** Model calls one request may make before it stops with a `step_limit` interruption. */
const MAX_CHAT_STEPS = 50;
/** Largest request body (the full plaintext history of the turn). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Lease renewal interval of an active run; the retention job fails runs past {@link RUN_LEASE_MS}. */
const LEASE_RENEW_MS = 15_000;
/** An active run whose lease is older than this has lost its generator. */
export const RUN_LEASE_MS = 60_000;
/** Ended runs (and their streams) are kept this long, so late readers can still replay them. */
const ENDED_RUN_RETENTION_MS = 10 * 60_000;
/**
 * Sliding expiry of a run stream: only a backstop, since retention deletes it explicitly (an
 * expired stream's bytes stay on disk until deleted, task 14 Phase 0).
 */
const RUN_STREAM_TTL_SECONDS = 600;
/** Batching of stream appends: about three appends a second while tokens arrive. */
const RUN_STREAM_LINGER_MS = 300;
/** How often a running generator checks the stop flag that `chats.stop` sets. */
const STOP_POLL_MS = 500;
const MAX_TITLE_PROMPT = 8000;

const optionalText = z.string().max(256).optional();
const chatRequest = z.object({
  id: z.string().min(1).max(256).optional(),
  chatId: z.string().min(1).max(256).optional(),
  messages: z.array(z.looseObject({ id: z.string().max(256).optional() })).max(10_000),
  revisions: z.record(z.string().max(256), z.number().int()).optional(),
  model: z.string().min(1).max(256),
  provider: optionalText,
  serviceTier: optionalText,
  inferenceMode: optionalText,
  reasoningEffort: optionalText,
  reasoningBudget: z.number().int().nonnegative().optional(),
  /** User approval signatures by tool call ID (`parseWorkerApprovals`); paired Workers need them. */
  approvals: z.unknown().optional(),
  /** The exact current chat key the client encrypted this turn's files to and expects. */
  recipientKey: z
    .object({
      e2eeId: z.string().min(1).max(128),
      epoch: z.number().int().positive(),
      publicKey: z.string().max(Math.ceil((ENCRYPTION_PUBLIC_KEY_BYTES * 4) / 3)),
    })
    .optional(),
});

function failure(status: number, message: string) {
  return Response.json({ error: { message, code: status } }, { status });
}

/** Handles one authenticated chat request; see the module comment. */
export async function handleChat(runtime: Runtime, request: Request): Promise<Response> {
  const { db } = runtime.drivers;
  const session = await runtime.auth.api.getSession({ headers: request.headers });
  if (!session) return failure(401, "Unauthorized");
  const userId = session.user.id;

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return failure(413, "Chat request too large");
  let body: z.output<typeof chatRequest>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return failure(413, "Chat request too large");
    body = chatRequest.parse(JSON.parse(text));
  } catch {
    return failure(400, "Invalid chat request");
  }
  const chatId = body.chatId ?? body.id;
  const publicKey = body.recipientKey
    ? decodeExactBytes(body.recipientKey.publicKey, ENCRYPTION_PUBLIC_KEY_BYTES)
    : null;
  const approvals = parseWorkerApprovals(body.approvals);
  if (!chatId || !approvals || (body.recipientKey && !publicKey)) {
    return failure(400, "Invalid chat request");
  }

  const access = await chatAccess(db, userId, chatId);
  if (!access) return failure(404, "Chat not found");
  const { chat, workspace } = access;
  if (await isAcpChat(db, chat.id)) return failure(409, "ACP chats use the Worker transport");
  // Historical plaintext lives in a sidecar; the browser creates the chat's keys first.
  if (!chat.e2eeId) return failure(409, "Enable encryption for this chat before sending.");
  // Sealed only to the exact key the sender's client prepared, checked before a billed generation
  // and again when saving: a rotation or audience change in between fails the turn.
  const recipient: PinnedChatRecipient | undefined =
    body.recipientKey && publicKey ? { ...body.recipientKey, publicKey, userId } : undefined;
  if (!recipient || !(await currentChatPublicKey(db, chat, workspace, recipient))) {
    return failure(409, "This chat's key must be rotated before sending.");
  }
  const messages = body.messages as unknown as UIMessage[];
  for (const message of messages) {
    if (!message.id) message.id = generateId();
  }

  // Aborted only by `chats.stop`: the run outlives the sender's request.
  const abort = new AbortController();
  const run = await prepareRun(runtime, {
    chat,
    workspace,
    userId,
    body,
    messages,
    approvals,
    signal: abort.signal,
  });
  if (run instanceof Response) return run;

  const admitted = await admitRun(db, chat.id, userId);
  if (!admitted) {
    await run.closeTools();
    return failure(409, "This chat is already replying.");
  }
  const path = runStreamPath(chat.id, admitted);
  try {
    await runtime.streams.create(path, { ttlSeconds: RUN_STREAM_TTL_SECONDS });
  } catch {
    console.error("chat: run stream could not be created");
    await run.closeTools();
    await endRun(db, admitted, "failed");
    return failure(503, "Replies are unavailable right now.");
  }
  deferChatEvent(runtime, chat.id, "chats");
  runtime.defer(
    generateRun(runtime, { ...run, chat, workspace, userId, body, messages, recipient, runId: admitted, path, abort }),
  );
  const streamUrl = `/api/streams/${path}`;
  return Response.json({ streamUrl }, { status: 201, headers: { Location: streamUrl } });
}

type PreparedRun = ChatTools & {
  modelMessages: ModelMessage[];
  instructions: string | undefined;
};

/**
 * Everything a run needs before admission: tools (MCP connections included), the system prompt
 * and the model messages with stored files inlined. Failing here leaves nothing to reset; a
 * selected Worker that is no longer active refuses the request (`400`).
 */
async function prepareRun(
  runtime: Runtime,
  input: {
    chat: Chat;
    workspace: ChatWorkspace;
    userId: string;
    body: z.output<typeof chatRequest>;
    messages: UIMessage[];
    approvals: Map<string, WorkerApprovalSignature>;
    /** The run's stop signal; Code Mode waits end with it. */
    signal: AbortSignal;
  },
): Promise<PreparedRun | Response> {
  const { db } = runtime.drivers;
  const systemPrompt = await resolveSystemPrompt(db, input.workspace.id, input.body.model);
  let tools: ChatTools;
  try {
    tools = await buildChatTools(runtime, input, { systemPrompt: systemPrompt !== null });
  } catch (error) {
    if (error instanceof AppError) return failure(400, error.message);
    throw error;
  }
  try {
    const modelMessages = await inlineStoredFiles(
      runtime,
      input.workspace.id,
      await convertToModelMessages(input.messages, { tools: tools.tools }),
    );
    const instructions = systemPrompt
      ? chatSystemPrompt({ model: systemPrompt.model, codeMode: tools.codeModeInstructions })
      : undefined;
    return { ...tools, modelMessages, instructions };
  } catch {
    await tools.closeTools();
    console.error("chat: model messages could not be prepared");
    return failure(500, "The chat messages could not be prepared.");
  }
}

/**
 * Admits a run: inserts the chat's one active `chat_runs` row (the partial unique index refuses a
 * second), clears the previous interruption and the queued first prompt (this turn consumes it),
 * and moves the chat up in Home. Returns the run id, or `null` when a run is already active.
 */
export async function admitRun(db: Database, chatId: string, userId: string) {
  return await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(chatRuns)
      .values({ chat: chatId, userId, leaseAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: chatRuns.id });
    if (!run) return null;
    await touchChat(tx, chatId, {
      interruption: null,
      sealedQueueEpoch: null,
      sealedQueueBox: null,
    });
    await tx.update(chats).set({ messagesQueue: null }).where(eq(chats.id, chatId));
    return run.id;
  });
}

/** Ends an active run (`finished` or `failed`); a run that already ended is left alone. */
export async function endRun(db: Database, runId: string, status: "finished" | "failed") {
  await db
    .update(chatRuns)
    .set({ status, endedAt: new Date() })
    .where(and(eq(chatRuns.id, runId), eq(chatRuns.status, "active")));
}

/**
 * Generates one admitted run into its stream, detached from the request that started it: UI
 * message chunks go through an idempotent producer (batched; a retried batch is never stored
 * twice), the turn is sealed and saved when the model finishes, and the stream is closed last.
 * Stops when `chats.stop` sets the run's stop flag. Never throws: a failure ends the run as
 * `failed`.
 */
async function generateRun(
  runtime: Runtime,
  run: PreparedRun & {
    chat: Chat;
    workspace: ChatWorkspace;
    userId: string;
    body: z.output<typeof chatRequest>;
    messages: UIMessage[];
    recipient: PinnedChatRecipient;
    runId: string;
    path: string;
    abort: AbortController;
  },
): Promise<void> {
  const { db, kv } = runtime.drivers;
  const { chat, workspace, userId, body, messages, recipient, runId } = run;
  // The producer does not retry a failed batch, and every later batch is refused after the gap.
  // So the first failure ends live delivery: later chunks are dropped (the saved turn is
  // unaffected) and the stream is closed with an error by a plain append in `finally`.
  let streamBroken = false;
  const producer = runtime.streams.producer(run.path, runId, {
    lingerMs: RUN_STREAM_LINGER_MS,
    onError: () => {
      if (!streamBroken) console.error("chat: run stream append failed");
      streamBroken = true;
    },
  });
  const lease = setInterval(() => {
    void db
      .update(chatRuns)
      .set({ leaseAt: new Date() })
      .where(and(eq(chatRuns.id, runId), eq(chatRuns.status, "active")))
      .catch(() => console.error("chat: run lease renewal failed"));
  }, LEASE_RENEW_MS);
  const stopWatch = setInterval(() => {
    kvGet(kv, runStopKey(runId)).then(
      (stop) => {
        if (stop !== null) run.abort.abort();
      },
      () => console.error("chat: stop flag unavailable"),
    );
  }, STOP_POLL_MS);
  let ended = false;
  let saved = false;
  const finish = async (status: "finished" | "failed") => {
    if (ended) return;
    ended = true;
    clearInterval(lease);
    await run.closeTools();
    await endRun(db, runId, status);
  };

  try {
    // Viewers attaching from another Tab or after a reload replay the stream before the turn is
    // saved; this transient part carries the prompt they would otherwise not see. Plaintext like
    // the reply chunks after it, and deleted with them.
    const prompt = messages.findLast((message) => message.role === "user");
    if (prompt) {
      producer.append(JSON.stringify({ type: "data-radium-prompt", data: { message: prompt }, transient: true }));
    }
    const previous = messages.at(-1);
    const previousMetadata =
      previous?.role === "assistant" && previous.metadata && typeof previous.metadata === "object"
        ? (previous.metadata as Record<string, unknown>)
        : undefined;
    const previousPerformance = parsePerformance(previousMetadata?.performance);
    const gatewayExecutions: unknown[] = Array.isArray(previousMetadata?.gatewayExecutions)
      ? [...previousMetadata.gatewayExecutions]
      : [];
    const generations: Array<{ completionTokens: number; generationTimeMs: number }> = [];
    const provider = createInternalGatewayProvider(
      runtime,
      workspace.id,
      {
        provider: body.provider,
        serviceTier: body.serviceTier,
        inferenceMode: body.inferenceMode,
        reasoningEffort: body.reasoningEffort,
        reasoningBudget: body.reasoningBudget,
      },
      { actor: userId, chatId: chat.id },
      {
        onGeneration: (generation: SettledGeneration) => {
          generations.push({
            completionTokens: generation.usage.completion_tokens,
            generationTimeMs: generation.genTime,
          });
          gatewayExecutions.push({
            model: generation.model ?? body.model,
            provider: generation.provider,
            requestedServiceTier: body.serviceTier,
            serviceTier: generation.serviceTier,
            estimatedCost: generation.estimatedCost,
            reportedCost: generation.reportedCost,
            upstreamInferenceCost: generation.upstreamInferenceCost,
            costSource: generation.costSource,
          });
        },
        telemetry: run.telemetry,
      },
    );

    // Title work uses the first request's in-memory prompt only, never a stored job payload. A chat
    // whose historical title sits in a sidecar keeps it: the server cannot see it.
    const titlePromise =
      !chat.sealedTitleBox && !chat.title && !chat.legacyContent
        ? generateTitle(runtime, chat, workspace.id, userId, messages)
        : Promise.resolve(undefined);

    let inferenceError: GatewayErrorPayload | undefined;
    let stepCount = 0;
    let stepLimitReached = false;
    const result = streamText({
      model: provider(body.model),
      instructions: run.instructions,
      messages: run.modelMessages,
      tools: run.tools,
      toolApproval: run.toolApproval,
      experimental_toolApprovalSecret: run.approvalSecret,
      stopWhen: isStepCount(MAX_CHAT_STEPS),
      onStepEnd({ finishReason }) {
        stepCount++;
        stepLimitReached = stepCount >= MAX_CHAT_STEPS && finishReason === "tool-calls";
      },
      onError({ error }) {
        inferenceError = gatewayErrorPayload(
          upstreamFailureFromError(error, false),
          error instanceof GatewayInferenceError ? error.details.provider : undefined,
        );
      },
      abortSignal: run.abort.signal,
    });

    const reasoningStarts = new Map<string, { startedAt: number; index: number }>();
    const reasoningDurations: number[] = [];
    // Streamed to the client only; the saved interruption never stores error text.
    let streamFailure: string | undefined;
    const modelMetadata = {
      model: body.model,
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.serviceTier ? { serviceTier: body.serviceTier } : {}),
      ...(body.inferenceMode ? { inferenceMode: body.inferenceMode } : {}),
    };

    const uiStream = toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      sendSources: true,
      sendReasoning: true,
      onError(error) {
        const details =
          inferenceError ?? gatewayErrorPayload(upstreamFailureFromError(error, false));
        streamFailure = formatInferenceError(details);
        return streamFailure;
      },
      messageMetadata({ part }) {
        if (part.type === "reasoning-start") {
          reasoningStarts.set(part.id, { startedAt: Date.now(), index: reasoningDurations.length });
          reasoningDurations.push(0);
        } else if (part.type === "reasoning-end") {
          const timing = reasoningStarts.get(part.id);
          if (timing) {
            reasoningDurations[timing.index] = Math.ceil((Date.now() - timing.startedAt) / 1000);
          }
        }
        if (part.type === "finish") {
          const performance = aggregatePerformance(generations, previousPerformance);
          return {
            ...modelMetadata,
            gatewayExecutions,
            usage: part.totalUsage,
            ...(performance ? { performance } : {}),
          };
        }
        return modelMetadata;
      },
      onEnd: async ({ messages: final, isAborted, isCancelled, outcome, responseMessage }) => {
        let reasoningIndex = 0;
        const originalParts = new Map(messages.map((message) => [message.id, message.parts.length]));
        const withDurations = final.map((message) => ({
          ...message,
          parts: message.parts.map((part, index) => {
            if (part.type !== "reasoning" || index < (originalParts.get(message.id) ?? 0)) {
              return part;
            }
            const duration = reasoningDurations[reasoningIndex++];
            return duration === undefined ? part : { ...part, duration };
          }),
        }));
        const end = {
          isAborted,
          isCancelled,
          outcome,
          failed: streamFailure !== undefined,
          responseMessage,
        };
        const interruption = chatInterruption(end, stepLimitReached) ?? null;
        try {
          await saveTurn(runtime, {
            chatId: chat.id,
            workspace,
            recipient,
            messages: withDurations,
            revisions: body.revisions,
            responseMessageId: responseMessage.id,
            interruption,
            runId,
          });
          saved = true;
        } catch {
          await finish("failed");
          throw new Error("The chat response could not be saved securely.");
        } finally {
          clearInterval(lease);
          await run.closeTools();
        }
        await saveTitle(runtime, chat.id, workspace, recipient, await titlePromise);
        // Notifications are a side channel: a failure here must not fail the saved request.
        const kind = sessionNotificationKind(end);
        if (kind) {
          try {
            const jobs: (string | null)[] = [];
            await db.transaction((tx) =>
              notify(tx, { userId, workspace: workspace.id, chat: chat.id, kind }, jobs),
            );
            runtime.defer(dispatchJobs(runtime, jobs));
          } catch {
            console.error("chat: session notification failed");
          }
        }
      },
    });
    const chunks = uiStream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (chunk.type === "error" && inferenceError) {
            controller.enqueue({
              type: "data-gateway-error",
              data: inferenceError,
              transient: true,
            });
          }
          controller.enqueue(chunk);
        },
      }),
    );
    for await (const chunk of chunks) {
      if (!streamBroken) producer.append(JSON.stringify(chunk));
    }
  } catch {
    console.error("chat: run failed");
    // Readers end on an error, not a silent close; the message holds no upstream detail.
    if (!streamBroken) producer.append(JSON.stringify(RUN_FAILED_CHUNK));
  } finally {
    clearInterval(stopWatch);
    clearInterval(lease);
    // `onEnd` saved and ended the run; anything else fails it.
    if (!saved) await finish("failed").catch(() => console.error("chat: run end failed"));
    const closed = await producer.close().then(
      () => !streamBroken,
      () => false,
    );
    if (!closed) {
      // Without a close every viewer would wait on the stream until retention deletes it.
      await runtime.streams
        .append(run.path, [RUN_FAILED_CHUNK], { close: true })
        .catch(() => console.error("chat: run stream close failed"));
    }
    await kvDelete(kv, runStopKey(runId)).catch(() => undefined);
    // A chat deleted while this run started has no row left for retention to find its stream by.
    const [kept] = await db
      .select({ id: chatRuns.id })
      .from(chatRuns)
      .where(eq(chatRuns.id, runId))
      .catch(() => [{ id: runId }]);
    if (!kept) await runtime.streams.delete(run.path).catch(() => console.error("chat: run stream not deleted"));
    deferChatEvent(runtime, chat.id, "chats");
  }
}

/** The last chunk of a run whose reply could not be streamed or completed; no upstream detail. */
const RUN_FAILED_CHUNK = { type: "error", errorText: "The reply could not be completed." };

/**
 * Asks chat `chatId`'s active run to stop (`chats.stop`), from any Tab or device: the run's
 * sender or a chat manager. Sets a Valkey flag the generator polls every
 * {@link STOP_POLL_MS}; the run saves what it has, marked stopped.
 *
 * @returns whether a run was active.
 */
export async function stopRun(runtime: Runtime, userId: string, chatId: string): Promise<boolean> {
  const { db, kv } = runtime.drivers;
  const { chat, canManage } = await requireChatAccess(db, userId, chatId);
  const [active] = await db
    .select({ id: chatRuns.id, userId: chatRuns.userId })
    .from(chatRuns)
    .where(and(eq(chatRuns.chat, chat.id), eq(chatRuns.status, "active")));
  if (!active) return false;
  if (active.userId !== userId && !canManage) {
    throw new AppError("FORBIDDEN", "Only the sender or a manager of this chat can stop its reply.");
  }
  await requestRunStop(kv, active.id);
  return true;
}

/**
 * `GET /api/chat/<chat>/stream`, the resume path of a reloaded Tab: `200` with the location of
 * chat `chatId`'s active run stream, or `204` when the chat is not replying.
 */
export async function activeRunStream(runtime: Runtime, request: Request, chatId: string): Promise<Response> {
  const session = await runtime.auth.api.getSession({ headers: request.headers });
  if (!session) return failure(401, "Unauthorized");
  const { db } = runtime.drivers;
  const access = await chatAccess(db, session.user.id, chatId);
  if (!access) return failure(404, "Chat not found");
  const [active] = await db
    .select({ id: chatRuns.id })
    .from(chatRuns)
    .where(and(eq(chatRuns.chat, chatId), eq(chatRuns.status, "active")));
  if (!active) return new Response(null, { status: 204 });
  const streamUrl = `/api/streams/${runStreamPath(chatId, active.id)}`;
  return Response.json({ streamUrl }, { headers: { Location: streamUrl } });
}

/**
 * Seals the turn and saves it with the run's end, in one transaction holding the chat row lock:
 * concurrent saves of one chat serialize, and the second one's stale revisions are refused. The
 * sealing key is re-checked: it must still be exactly the pinned recipient.
 */
async function saveTurn(
  runtime: Runtime,
  input: {
    chatId: string;
    workspace: ChatWorkspace;
    recipient: PinnedChatRecipient;
    messages: UIMessage[];
    revisions: Record<string, number> | undefined;
    responseMessageId: string;
    interruption: ChatInterruption | null;
    runId: string;
  },
) {
  const { db } = runtime.drivers;
  const [chat] = await db.select().from(chats).where(eq(chats.id, input.chatId));
  if (!chat?.e2eeId) throw new Error("chat gone");
  const target = await currentChatPublicKey(db, chat, input.workspace, input.recipient);
  if (!target) throw new Error("chat sealing key unavailable");
  const writes = await sealChatMessages({
    workspace: input.workspace.id,
    e2eeId: chat.e2eeId,
    ...target,
    messages: input.messages,
    heads: await chatMessageHeads(db, chat.id),
    revisions: input.revisions,
    responseMessageId: input.responseMessageId,
    fileUrls: [...storedFileUrls(input.messages)],
  });
  // The batch is bound to `target.epoch`; a rotation in between fails the save's epoch check.
  await saveSealedChatMessages(db, runtime.config, chat.id, writes, async (tx) => {
    await touchChat(tx, chat.id, { interruption: input.interruption });
    await endRun(tx, input.runId, "finished");
  });
}

/** Generates a title from the first user message in memory; failures yield no title. */
async function generateTitle(
  runtime: Runtime,
  chat: Chat,
  workspace: string,
  userId: string,
  messages: UIMessage[],
) {
  try {
    const model = await titleModelFor(runtime.drivers.db, workspace);
    const prompt = firstUserMessageText({ messages });
    if (!model || !prompt) return undefined;
    const provider = createInternalGatewayProvider(runtime, workspace, {}, {
      actor: userId,
      chatId: chat.id,
    });
    return await generateChatTitle({
      model: provider(model),
      initialUserMessage: prompt.slice(0, MAX_TITLE_PROMPT),
    });
  } catch {
    return undefined;
  }
}

/** Seals and stores a generated title to the chat's current key; failures are only logged. */
async function saveTitle(
  runtime: Runtime,
  chatId: string,
  workspace: ChatWorkspace,
  recipient: PinnedChatRecipient,
  title: { title: string; emoji: string } | undefined,
) {
  if (!title) return;
  const { db } = runtime.drivers;
  try {
    await db.transaction(async (tx) => {
      const [chat] = await tx.select().from(chats).where(eq(chats.id, chatId)).for("update");
      if (!chat?.e2eeId || chat.sealedTitleBox) return;
      const target = await currentChatPublicKey(tx, chat, workspace, recipient);
      if (!target) return;
      const sealedTitle = await sealChatTitle(
        { workspace: workspace.id, e2eeId: chat.e2eeId, ...target },
        title,
      );
      await saveSealedTitle(tx, chat, sealedTitle);
    });
  } catch {
    console.error("chat: title could not be saved");
  }
}

/** The tools of one run, their teardown, and the run's telemetry capture context. */
type ChatTools = {
  tools: ToolSet;
  /** Closes every MCP connection; idempotent. */
  closeTools: () => Promise<void>;
  /** The Code Mode catalog section of the system prompt, when Code Mode is on. */
  codeModeInstructions: string | undefined;
  /** Worker tools that pause for the user's approval, and the SDK's approval replay guard. */
  toolApproval: ToolApprovalConfiguration<ToolSet, unknown> | undefined;
  approvalSecret: Uint8Array | undefined;
  telemetry: Omit<TelemetryRequestContext, "requestId"> | undefined;
};

/** Refusal of a request whose chat selects a Worker that is not active in its workspace. */
const WORKER_TOOLS_UNAVAILABLE =
  "Worker tools are unavailable. Check that the selected Worker is active.";

/**
 * Resolves and connects the tools enabled for a chat (Convex `buildChatTools`). Session tool sets
 * come first, then the owner's Worker tools, then Exa web search, then MCP servers: a server in
 * Code Mode contributes only to `execute`, the others direct tools named `<prefix>_<tool>`. A
 * failing server is skipped. Inside Code Mode, Worker tools keep their approvals as in-stream
 * prompts whose signatures join `approvals`. `closeTools` closes every MCP connection and is
 * idempotent. Telemetry settings are read here too: keyed chats never record content. Throws
 * `AppError` when the selected Worker is not active, before any MCP connection opens.
 */
async function buildChatTools(
  runtime: Runtime,
  input: {
    chat: Chat;
    workspace: ChatWorkspace;
    userId: string;
    body: z.output<typeof chatRequest>;
    approvals: Map<string, WorkerApprovalSignature>;
    signal: AbortSignal;
  },
  options: { systemPrompt: boolean },
): Promise<ChatTools> {
  const { db, kv } = runtime.drivers;
  const { chat, workspace, userId, body } = input;
  const [config, supportsTools, telemetrySettings] = await Promise.all([
    resolveChatTools(db, chat, workspace.id),
    modelSupportsTools(db, workspace.id, body.model, body.provider),
    telemetrySettingsFor(db, workspace.id),
  ]);
  // Captured text would be plaintext of an encrypted chat; content stays off until it is sealed.
  const telemetry = telemetrySettings.enabled
    ? {
        workspace: workspace.id,
        chatId: chat.id,
        userId,
        settings: { ...telemetrySettings, recordInputs: false, recordOutputs: false },
      }
    : undefined;

  const tools: Record<string, ToolSet[string]> = supportsTools
    ? { ...buildSessionTools(config.builtinToolSets) }
    : {};
  const codeModeEnabled = supportsTools && config.builtinToolSets.includes(CODE_MODE_TOOL_SET_ID);
  const directMcpTools = new Set<string>();
  const codeModeServers: Array<{ prefix: string; name: string; tools: Record<string, unknown> }> =
    [];
  const addDirectMcpTools = (prefix: string, serverTools: Record<string, unknown>) => {
    for (const [name, definition] of Object.entries(serverTools)) {
      const toolName = uniqueToolName(tools, `${prefix}_${name}`);
      tools[toolName] = definition as ToolSet[string];
      directMcpTools.add(toolName);
    }
  };

  let toolApproval: ToolApprovalConfiguration<ToolSet, unknown> | undefined;
  let approvalSecret: Uint8Array | undefined;
  // Shared-chat membership never grants machine execution. Identity and directory come from the
  // stored chat; dispatch rechecks them on every stage. Tools chosen without a Worker stay
  // unavailable until the owner picks one.
  const selection = chatWorkerSelection(chat);
  const workerId = selection?.workerId;
  if (userId === workspace.ownerId && selection && workerId !== undefined && selection.tools.length > 0) {
    try {
      await validateChatWorkerSelection(
        { workerId, directory: selection.directory, tools: selection.tools },
        userId,
        workspace,
        async (id) =>
          (await activeWorkspaceWorkers(db, workspace.id, [id])).has(id)
            ? { workerId: id, workspaceId: workspace.id, status: "active" }
            : null,
      );
    } catch {
      throw new AppError("BAD_REQUEST", WORKER_TOOLS_UNAVAILABLE);
    }
    const scope = {
      chatId: chat.id,
      workspaceId: workspace.id,
      userId,
      selection: { ...selection, workerId },
      transport: await resolveWorkerChatTransport(db, { chatId: chat.id, userId, workerId }),
      approvals: input.approvals,
    };
    const worker = buildWorkerChatTools(runtime, scope);
    Object.assign(tools, worker.tools);
    toolApproval = worker.toolApproval;
    if (Object.keys(toolApproval).length > 0) {
      approvalSecret = await workerChatApprovalSecret(runtime.config.BETTER_AUTH_SECRET, scope);
    }
  }

  if (config.builtinToolSets.includes(WEB_SEARCH_TOOL_ID)) {
    const apiKey = await builtinToolCredential(runtime, workspace.id, EXA_TOOL_CREDENTIAL_PROVIDER);
    if (apiKey) {
      tools.web_search = webSearch({ apiKey, userLocation: toExaCountry() }) as ToolSet[string];
    }
  }

  const clients: MCPClient[] = [];
  for (const server of config.mcpServers) {
    try {
      const token =
        server.auth.type === "bearer"
          ? await mcpBearerToken(runtime, workspace.id, server.id)
          : null;
      if (server.auth.type === "bearer" && !token) throw new Error("MCP bearer token unavailable");
      const client = await createMCPClient({
        transport: {
          type: "http",
          url: server.url,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
      });
      // Registered before loading tools, so a failure while loading still closes it.
      clients.push(client);
      const serverTools = await client.tools();
      const prefix = toolNamePrefix(server.name);
      if (server.codeMode && codeModeEnabled) {
        codeModeServers.push({ prefix, name: server.name, tools: serverTools });
        continue;
      }
      addDirectMcpTools(prefix, serverTools);
    } catch {
      console.error("chat: MCP server connection failed");
    }
  }

  let closed = false;
  const closeTools = async () => {
    if (closed) return;
    closed = true;
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  };

  let codeModeInstructions: string | undefined;
  if (codeModeEnabled) {
    // Inner calls keep the approvals of their direct counterparts; the user answers them in-stream
    // as Code Mode prompts instead of the SDK approval round trip.
    const approvalTools = new Set(toolApproval ? Object.keys(toolApproval) : []);
    const directTools: CodeModeInventory["tools"] = {};
    for (const [name, definition] of Object.entries(tools)) {
      if (directMcpTools.has(name)) continue;
      let interaction: CodeModeInteractionKind | undefined;
      if (name === QUESTION_TOOL_ID) interaction = "question";
      else if (approvalTools.has(name)) interaction = "approval";
      directTools[name] = { tool: definition, ...(interaction ? { interaction } : {}) };
    }
    const namespaces: CodeModeInventory["namespaces"] = {};
    for (const server of codeModeServers) {
      namespaces[uniqueToolName({ ...directTools, ...namespaces }, server.prefix)] = {
        description: `Tools of the "${server.name}" MCP server.`,
        tools: Object.fromEntries(
          Object.entries(server.tools).map(([name, definition]) => [
            name,
            { tool: definition as ToolSet[string], mcp: true },
          ]),
        ),
      };
    }
    try {
      const codeMode = await createCodeMode({
        inventory: { tools: directTools, namespaces },
        catalogInDescription: !options.systemPrompt,
        // Inner approvals reach paired Workers as user signatures keyed by the inner call ID.
        interactions: workerCodeModeInteractions(
          {
            open: (kind) => openInteraction(kv, { chatId: chat.id, userId, kind }),
            response: (id) =>
              awaitInteractionResponse(runtime, { chat: chat.id, id, signal: input.signal }),
            close: (id) => closeInteraction(kv, id),
          },
          input.approvals,
        ),
      });
      if (codeMode) {
        tools[CODE_MODE_TOOL_NAME] = codeMode.tool;
        codeModeInstructions = codeMode.instructions;
      }
    } catch {
      // A tool whose schema Code Mode cannot render must not fail the request.
      console.error("chat: Code Mode unavailable");
      for (const server of codeModeServers) addDirectMcpTools(server.prefix, server.tools);
    }
  }

  return {
    tools: tools as ToolSet,
    closeTools,
    codeModeInstructions,
    toolApproval,
    approvalSecret,
    telemetry,
  };
}

/**
 * Replaces stored-file URL parts in the model input with the stored bytes (opened with the
 * URL's object-key fragment for sealed uploads). Persisted messages keep the URL; providers would
 * otherwise have to fetch a private deployment's URL. Historical attachments must be re-encrypted
 * by the browser first.
 */
async function inlineStoredFiles(
  runtime: Runtime,
  workspace: string,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const urls: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      const url = storageUrlOf(part);
      if (url) urls.push(url);
    }
  }
  if (urls.length === 0) return messages;

  // Object-key fragments never reach a query.
  const resolved = await resolveStoredFiles(
    runtime.drivers.db,
    runtime.config,
    workspace,
    urls.map(stripFileFragment),
  );
  const keys = new Map(resolved.map(({ url, storageKey }) => [url, storageKey]));
  const historical = new Set(resolved.flatMap(({ url, historical }) => (historical ? [url] : [])));
  const bytesByUrl = new Map<string, Uint8Array>();
  for (const url of new Set(urls)) {
    const plain = stripFileFragment(url);
    if (historical.has(plain)) throw new Error("Historical attachment must be re-encrypted");
    const fragment = parseFileFragment(url);
    fragment?.objectKey.fill(0);
    const key = keys.get(plain);
    const stored = key ? await runtime.drivers.objects.get(key) : null;
    if (!stored) {
      if (fragment) throw new Error("Encrypted attachment unavailable");
      continue;
    }
    bytesByUrl.set(url, await openFileBytes(workspace, url, stored));
  }

  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((part) => {
      const url = storageUrlOf(part);
      const bytes = url ? bytesByUrl.get(url) : undefined;
      if (!bytes) {
        if (!url || part.type !== "file") return part;
        const data = part.data;
        if (!data || typeof data !== "object" || !("type" in data) || data.type !== "url") {
          return part;
        }
        return { ...part, data: { ...data, url: new URL(stripFileFragment(url)) } };
      }
      return { ...part, data: { type: "data" as const, data: bytes } };
    });
    return { ...message, content } as ModelMessage;
  });
}

/** URL of a model file part that still points at a URL (as AI SDK converts UI file parts). */
function storageUrlOf(part: unknown) {
  if (!part || typeof part !== "object") return undefined;
  const record = part as { type?: unknown; data?: unknown };
  if (record.type !== "file" || !record.data || typeof record.data !== "object") return undefined;
  const data = record.data as { type?: unknown; url?: unknown };
  if (data.type !== "url" || !(data.url instanceof URL)) return undefined;
  return data.url.href;
}

type MessagePerformance = { averageTps: number; generationTimeMs: number; requestCount: number };

function parsePerformance(value: unknown): MessagePerformance | undefined {
  const parsed = z
    .object({ averageTps: z.number(), generationTimeMs: z.number(), requestCount: z.number() })
    .safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function aggregatePerformance(
  generations: Array<{ completionTokens: number; generationTimeMs: number }>,
  previous: MessagePerformance | undefined,
): MessagePerformance | undefined {
  const requestCount = generations.length + (previous?.requestCount ?? 0);
  if (requestCount === 0) return previous;
  const tpsTotal = generations.reduce(
    (total, generation) =>
      total +
      (generation.generationTimeMs > 0
        ? generation.completionTokens / (generation.generationTimeMs / 1000)
        : 0),
    (previous?.averageTps ?? 0) * (previous?.requestCount ?? 0),
  );
  return {
    averageTps: tpsTotal / requestCount,
    generationTimeMs:
      generations.reduce((total, generation) => total + generation.generationTimeMs, 0) +
      (previous?.generationTimeMs ?? 0),
    requestCount,
  };
}

/** Explains HTTP failures without guessing a provider's plan, balance or reset deadline. */
export function formatInferenceError(details: GatewayErrorPayload): string {
  let fallback: string;
  let action: string;
  switch (details.status) {
    case 429:
      fallback = "The provider's rate limit or usage quota was reached.";
      action = "Try again later or choose another provider/account.";
      break;
    case 401:
      fallback = "The provider could not authenticate the configured credentials.";
      action = "Check or reconnect the provider credentials, or choose another provider/account.";
      break;
    case 402:
      fallback = "The provider rejected the request for a billing or balance reason.";
      action = "Check the upstream account's billing or balance, or choose another provider/account.";
      break;
    case 403:
      fallback = "The provider denied access to this request.";
      action = "Check the account's permissions and model access, or choose another provider/account.";
      break;
    case 404:
      fallback = "The provider could not find the requested model or endpoint.";
      action = "Check the model configuration or choose another provider.";
      break;
    default:
      if (details.status >= 500) {
        fallback = "The provider or its connection could not complete the inference request.";
        action = "Try again later or choose another provider.";
      } else {
        fallback = "The provider rejected the inference request.";
        action = "Check the request settings and the provider's requirements.";
      }
  }
  const upstream = details.message.trim();
  const code =
    String(details.code) === String(details.status)
      ? `HTTP ${details.status}`
      : `${details.code}, HTTP ${details.status}`;
  return `${upstream || fallback} ${action} (${code})`;
}

/**
 * Retention of built-in runs: fails active runs whose generator stopped renewing the lease
 * (crash, deploy) and ends their streams with an error, then deletes ended runs past
 * {@link ENDED_RUN_RETENTION_MS} together with their streams. Bounded per call; a stream that
 * cannot be deleted keeps its row for the next run.
 */
export async function pruneChatRuns(runtime: Runtime, now: number, batch: number): Promise<number> {
  const { db } = runtime.drivers;
  const stale = await db
    .update(chatRuns)
    .set({ status: "failed", endedAt: new Date(now) })
    .where(
      sql`${chatRuns.id} in (select ${chatRuns.id} from ${chatRuns} where ${chatRuns.status} = 'active' and ${chatRuns.leaseAt} < ${new Date(now - RUN_LEASE_MS)} limit ${batch})`,
    )
    .returning({ id: chatRuns.id, chat: chatRuns.chat });
  for (const run of stale) {
    // Readers of a lost run would otherwise wait on a stream nobody writes.
    await runtime.streams
      .append(runStreamPath(run.chat, run.id), [{ type: "error", errorText: "The reply was interrupted." }], { close: true })
      .catch(() => console.error("chat: lost run stream not closed"));
    deferChatEvent(runtime, run.chat, "chats");
  }

  const ended = await db
    .select({ id: chatRuns.id, chat: chatRuns.chat })
    .from(chatRuns)
    .where(
      and(sql`${chatRuns.status} <> 'active'`, lt(chatRuns.endedAt, new Date(now - ENDED_RUN_RETENTION_MS))),
    )
    .limit(batch);
  const deletable: string[] = [];
  for (const run of ended) {
    try {
      await runtime.streams.delete(runStreamPath(run.chat, run.id));
      deletable.push(run.id);
    } catch {
      console.error("chat: run stream not deleted");
    }
  }
  if (deletable.length > 0) await db.delete(chatRuns).where(inArray(chatRuns.id, deletable));
  return stale.length + deletable.length;
}

