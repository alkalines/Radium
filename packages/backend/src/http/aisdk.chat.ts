import { createMCPClient } from "@ai-sdk/mcp";
import { webSearch } from "@exalabs/ai-sdk";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type ToolApprovalConfiguration,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { toExaCountry } from "../chatroom/user-location";
import {
  EXA_TOOL_CREDENTIAL_PROVIDER,
  toolNamePrefix,
  uniqueToolName,
} from "../chatroom/aisdk-tools";
import type { Id } from "../../convex/_generated/dataModel";
import { authComponent, createAuth } from "../../convex/auth";
import { components, internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  MCP_SECRET_NAME,
  mcpSecretNamespace,
  secrets,
  workspaceMcpSecretNamespace,
} from "../../convex/secrets";
import { createInternalGatewayProvider } from "../../convex/ai_gateway";
import { validateChatWorkerSelection, type ChatWorkerSelection } from "../worker/chat-config";
import { buildWorkerChatTools, workerChatApprovalSecret } from "../worker/chat-tools";
import { buildSessionTools } from "../chatroom/session-tools";
import type { SettledGeneration } from "./chat_completion";
import {
  GatewayInferenceError,
  gatewayErrorPayload,
  upstreamFailureFromError,
  type GatewayErrorPayload,
} from "../routing/failures";
import { formatInferenceError } from "../chatroom/inference-errors";
import { logger } from "../logging/server";
import { sessionNotificationKind } from "../notifications/session";

type AISDKChatRequestBody = {
  messages: UIMessage[];
  model: string;
  provider?: string;
  serviceTier?: string;
  inferenceMode?: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
  id?: Id<"aisdk_chats">;
  chatId?: Id<"aisdk_chats">;
};

/** Handles the authenticated AI SDK chat request body and stream lifecycle. */
export async function handleAISDKChat(ctx: ActionCtx, req: Request): Promise<Response> {
  const authUser = await authComponent.safeGetAuthUser(ctx);
  const session = authUser?._id
    ? null
    : await createAuth(ctx).api.getSession({
        headers: req.headers,
      });
  const userId = authUser?._id ?? session?.user.id;

  if (!userId) {
    return Response.json(
      { error: { message: "Unauthorized", code: 401 } },
      {
        status: 401,
      },
    );
  }

  const body = (await req.json()) as AISDKChatRequestBody;
  const chatId = body?.chatId || body?.id;

  if (!chatId || !body.model || !Array.isArray(body.messages)) {
    return Response.json(
      { error: { message: "Invalid chat request", code: 400 } },
      { status: 400 },
    );
  }

  const authorizedChat = await ctx.runQuery(internal.workspaces.authorizeChatForUser, {
    chatId,
    userId,
  });

  if (!authorizedChat) {
    return Response.json(
      { error: { message: "Unauthorized", code: 401 } },
      {
        status: 401,
      },
    );
  }

  const { chat, workspace } = authorizedChat;
  const workspaceId = workspace._id;

  const previousPerformance = getLastAssistantPerformance(body.messages);
  const telemetrySettings = await ctx.runQuery(
    internal.observability.telemetry.getSettingsForWorkspace,
    { workspace: workspaceId },
  );
  // Workspace owners can read owner-managed telemetry, so member-owned personal
  // chats must not contribute prompt or response content to that channel.
  const telemetrySettingsForRequest =
    (chat.scope ?? "personal") === "personal" && chat.userId !== workspace.ownerId
      ? { ...telemetrySettings, recordInputs: false, recordOutputs: false }
      : telemetrySettings;
  const generations: Array<{ completionTokens: number; generationTimeMs: number }> = [];
  const previousMessage = body.messages.at(-1);
  const previousMetadata =
    previousMessage?.role === "assistant" &&
    previousMessage.metadata &&
    typeof previousMessage.metadata === "object"
      ? previousMessage.metadata
      : undefined;
  const previousExecutions =
    previousMetadata &&
    "gatewayExecutions" in previousMetadata &&
    Array.isArray(previousMetadata.gatewayExecutions)
      ? previousMetadata.gatewayExecutions
      : [];
  const gatewayExecutions = [...previousExecutions];
  const provider = createInternalGatewayProvider(
    ctx,
    workspaceId,
    {
      provider: body.provider,
      serviceTier: body.serviceTier,
      inferenceMode: body.inferenceMode,
      reasoningEffort: body.reasoningEffort,
      reasoningBudget: body.reasoningBudget,
    },
    (generation: SettledGeneration) => {
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
    telemetrySettingsForRequest.enabled
      ? {
          workspace: workspaceId,
          chatId,
          userId,
          settings: telemetrySettingsForRequest,
        }
      : undefined,
    { userId, chatId },
  );

  let chatTools: Awaited<ReturnType<typeof buildChatTools>>;
  try {
    chatTools = await buildChatTools(ctx, chatId, {
      userId,
      workspaceId,
      ownerId: workspace.ownerId,
      selection: chat.worker,
    });
  } catch {
    return Response.json(
      {
        error: {
          message:
            "Worker tools are unavailable. Check that the selected Worker is active and the backend Worker authentication configuration.",
          code: 400,
        },
      },
      { status: 400 },
    );
  }
  const { tools, close: closeTools, toolApproval, approvalSecret } = chatTools;

  await ctx.runMutation(internal.aisdk.EditChat, {
    chatId,
    activeStream: true,
    messages_queue: null,
  });

  let inferenceError: GatewayErrorPayload | undefined;
  const result = streamText({
    model: provider(body.model),
    messages: await convertToModelMessages(body.messages, { tools }),
    tools,
    toolApproval,
    experimental_toolApprovalSecret: approvalSecret,
    // Allow follow-up turns so the model can act on executable tool results
    // (Exa web search, MCP tools) instead of stopping at the first tool call.
    stopWhen: isStepCount(5),
    onError({ error }) {
      inferenceError = gatewayErrorPayload(
        upstreamFailureFromError(error, false),
        error instanceof GatewayInferenceError ? error.details.provider : undefined,
      );
      void closeTools();
    },
    abortSignal: req.signal,
  });

  const reasoningStarts = new Map<string, { startedAt: number; index: number }>();
  const reasoningDurations: number[] = [];
  // Formatted message of the error chunk the client was sent, for the failure notification.
  let streamFailure: string | undefined;

  const uiStream = toUIMessageStream({
    stream: result.stream,
    originalMessages: body.messages,
    sendSources: true,
    sendReasoning: true,
    onError(error) {
      const details = inferenceError ?? gatewayErrorPayload(upstreamFailureFromError(error, false));
      streamFailure = formatInferenceError(details);
      return streamFailure;
    },
    messageMetadata({ part }) {
      if (part.type === "reasoning-start") {
        reasoningStarts.set(part.id, { startedAt: Date.now(), index: reasoningDurations.length });
        reasoningDurations.push(0);
      } else if (part.type === "reasoning-end") {
        const timing = reasoningStarts.get(part.id);
        if (timing)
          reasoningDurations[timing.index] = Math.ceil((Date.now() - timing.startedAt) / 1000);
      }
      // Attach cumulative token usage once the response finishes so the client
      // can render context-window usage and cost for the message.
      if (part.type === "finish") {
        const performance = aggregatePerformance(generations, previousPerformance);
        return {
          model: body.model,
          ...(body.provider ? { provider: body.provider } : {}),
          ...(body.serviceTier ? { serviceTier: body.serviceTier } : {}),
          ...(body.inferenceMode ? { inferenceMode: body.inferenceMode } : {}),
          gatewayExecutions,
          usage: part.totalUsage,
          ...(performance ? { performance } : {}),
        };
      }
      return {
        model: body.model,
        ...(body.provider ? { provider: body.provider } : {}),
        ...(body.serviceTier ? { serviceTier: body.serviceTier } : {}),
        ...(body.inferenceMode ? { inferenceMode: body.inferenceMode } : {}),
      };
    },
    onEnd: async ({ messages, isAborted, isCancelled, outcome, responseMessage }) => {
      let reasoningIndex = 0;
      const originalParts = new Map(
        body.messages.map((message) => [message.id, message.parts.length]),
      );
      const messagesWithDuration = messages.map((message) => ({
        ...message,
        parts: message.parts.map((part, index) => {
          if (part.type !== "reasoning" || index < (originalParts.get(message.id) ?? 0))
            return part;
          const duration = reasoningDurations[reasoningIndex++];
          return duration === undefined ? part : { ...part, duration };
        }),
      }));
      await ctx.runMutation(internal.aisdk.EditChat, {
        chatId,
        messages: messagesWithDuration,
        activeStream: false,
      });
      await closeTools();

      // Notifications are a side channel: a failure here must not fail the saved request.
      const kind = sessionNotificationKind({
        isAborted,
        isCancelled,
        outcome,
        failed: streamFailure !== undefined,
        responseMessage,
      });
      if (kind) {
        try {
          await ctx.runMutation(internal.notifications.notifySession, {
            userId,
            chat: chatId,
            kind,
            ...(kind === "session_failed" && streamFailure ? { detail: streamFailure } : {}),
          });
        } catch {
          logger.warn("notifications.session_notify_failed");
        }
      }
    },
  });
  return createUIMessageStreamResponse({
    stream: uiStream.pipeThrough(
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
    ),
  });
}

type MessagePerformance = {
  averageTps: number;
  generationTimeMs: number;
  requestCount: number;
};

function getLastAssistantPerformance(messages: UIMessage[]): MessagePerformance | undefined {
  const message = messages.at(-1);
  if (message?.role !== "assistant" || typeof message.metadata !== "object" || !message.metadata) {
    return undefined;
  }
  const performance = "performance" in message.metadata ? message.metadata.performance : undefined;
  if (
    typeof performance !== "object" ||
    !performance ||
    !("averageTps" in performance) ||
    !("generationTimeMs" in performance) ||
    !("requestCount" in performance) ||
    typeof performance.averageTps !== "number" ||
    typeof performance.generationTimeMs !== "number" ||
    typeof performance.requestCount !== "number"
  ) {
    return undefined;
  }
  return performance as MessagePerformance;
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

/**
 * Resolve and connect the tools enabled for a chat.
 *
 * Each enabled MCP server is connected over its Streamable HTTP transport and
 * its tools merged in, namespaced by server so names from different servers
 * never collide. Bearer tokens are decrypted here (never sent to the client)
 * and passed as an `Authorization` header. A failing server is skipped rather
 * than failing the whole request.
 *
 * Returns the merged tool set plus an idempotent `close` that tears down every
 * connection — call it once the stream finishes or errors.
 *
 * The Web Search built-in tool set contributes the Exa search tool when it is
 * enabled and the workspace has an Exa API key configured. Enabled session
 * tool sets (`question`, `todo_write`) are registered first, so MCP names that
 * collide with them get a numeric suffix.
 *
 * @todo OAuth / OAuth 2.1 servers: supply an `OAuthClientProvider` via the
 *   transport's `authProvider` instead of a static bearer header.
 */
async function buildChatTools(
  ctx: ActionCtx,
  chatId: Id<"aisdk_chats">,
  worker: {
    userId: string;
    ownerId: string;
    workspaceId: Id<"workspaces">;
    selection?: ChatWorkerSelection;
  },
): Promise<{
  tools: ToolSet;
  close: () => Promise<void>;
  toolApproval?: ToolApprovalConfiguration<ToolSet, unknown>;
  approvalSecret?: Uint8Array;
}> {
  const config = await ctx.runQuery(internal.chatroom.resolveChatTools, { chatId });

  const clients: Awaited<ReturnType<typeof createMCPClient>>[] = [];
  // MCP tools are typed with `unknown` inputs; collect them loosely and cast to
  // `ToolSet` once at the boundary to avoid the invariance friction.
  const tools: Record<string, ToolSet[string]> = { ...buildSessionTools(config.builtinToolSets) };
  let toolApproval: ToolApprovalConfiguration<ToolSet, unknown> | undefined;
  let approvalSecret: Uint8Array | undefined;
  // Shared-chat membership never grants machine execution. Identity and directory
  // come from the persisted chat; dispatch rechecks configuration on every stage.
  // Tools chosen without a Worker stay unavailable until the owner picks one.
  const workerId = worker.selection?.workerId;
  if (
    worker.userId === worker.ownerId &&
    workerId !== undefined &&
    worker.selection?.tools.length
  ) {
    const selection = await validateChatWorkerSelection(
      worker.selection,
      worker.userId,
      { id: worker.workspaceId, ownerId: worker.ownerId },
      (id) =>
        ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
          workspaceId: worker.workspaceId,
          workerId: id,
        }),
    );
    const scope = {
      chatId,
      workspaceId: worker.workspaceId,
      userId: worker.userId,
      selection: { ...selection, workerId },
    };
    const workerTools = buildWorkerChatTools(ctx, scope);
    Object.assign(tools, workerTools.tools);
    toolApproval = workerTools.toolApproval;
    if (Object.keys(workerTools.toolApproval).length > 0) {
      const issuerSecret = process.env.WORKER_AUTH_PRIVATE_JWK;
      if (!issuerSecret) throw new Error("Worker authentication is not configured");
      approvalSecret = await workerChatApprovalSecret(issuerSecret, scope);
    }
  }

  const exaTool = await resolveExaWebSearch(ctx, chatId);
  if (exaTool) tools.web_search = exaTool;

  for (const server of config.mcpServers) {
    try {
      const headers = await resolveMcpHeaders(
        ctx,
        server.workspace,
        server._id,
        server.auth,
        server.legacy,
      );
      const client = await createMCPClient({
        transport: { type: "http", url: server.url, headers },
      });
      clients.push(client);

      // Keep the client registered before loading tools so the outer cleanup
      // still closes it if the server accepts a connection but tool loading fails.
      const serverTools = await client.tools();
      const prefix = toolNamePrefix(server.name);
      for (const [name, definition] of Object.entries(serverTools)) {
        tools[uniqueToolName(tools, `${prefix}_${name}`)] = definition as ToolSet[string];
      }
    } catch {
      console.error("Failed to connect MCP server", { serverId: server._id, name: server.name });
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all(
      clients.map((client) => client.close().catch((error) => console.error(error))),
    );
  };

  return { tools: tools as ToolSet, close, toolApproval, approvalSecret };
}

/**
 * Resolve the Exa web-search tool for a chat. Returns `undefined` (search
 * simply isn't offered) when Web Search is disabled or the workspace has no Exa
 * API key. The key is loaded here and never sent to the client; the user's
 * location is a mock for now (see `src/chatroom/user-location.ts`).
 */
async function resolveExaWebSearch(
  ctx: ActionCtx,
  chatId: Id<"aisdk_chats">,
): Promise<ToolSet[string] | undefined> {
  const { enabled, workspace } = await ctx.runQuery(internal.chatroom.resolveWebSearch, {
    chatId,
  });
  if (!enabled || !workspace) {
    if (enabled) console.warn("Web Search is enabled but no Exa API key is configured.");
    return undefined;
  }

  const apiKey = await ctx.runQuery(internal.aisdk_tools.getBuiltinToolCredentialForRuntime, {
    workspace,
    provider: EXA_TOOL_CREDENTIAL_PROVIDER,
  });
  if (!apiKey) return undefined;

  return webSearch({ apiKey, userLocation: toExaCountry() }) as ToolSet[string];
}

/** Build the request headers for an MCP server connection from its auth config. */
async function resolveMcpHeaders(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  serverId: Id<"mcp_servers">,
  auth: { type: "none" | "bearer" },
  legacy: boolean,
): Promise<Record<string, string> | undefined> {
  if (auth.type !== "bearer") return undefined;

  const workspaceToken = await secrets.get(ctx, {
    namespace: workspaceMcpSecretNamespace(workspaceId, serverId),
    name: MCP_SECRET_NAME,
  });

  let token = workspaceToken;
  if (!workspaceToken.ok && legacy && workspaceToken.reason === "not_found") {
    token = await secrets.get(ctx, {
      namespace: mcpSecretNamespace(serverId),
      name: MCP_SECRET_NAME,
    });
  }

  if (!token.ok) throw new Error("MCP bearer token unavailable.");
  return { Authorization: `Bearer ${token.value}` };
}

/**
 * AI SDK's resumable-stream GET endpoint is not implemented. Supporting it
 * would require durable stream storage; a Redis dependency or a custom
 * Convex-backed store would add operational and database complexity here.
 * https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams#3-implement-the-get-handler
 */
