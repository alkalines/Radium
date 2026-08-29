import { createMCPClient } from "@ai-sdk/mcp";
import { webSearch } from "@exalabs/ai-sdk";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
import { toExaCountry } from "../../src/utils/chatroom/user-location";
import type { Id } from "../_generated/dataModel";
import { authComponent, createAuth } from "../auth";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { MCP_SECRET_NAME, mcpSecretNamespace, secrets } from "../secrets";
import { createInternalGatewayProvider } from "../ai_gateway";

type ResponseHeaders = Record<string, string>;

type AISDKChatRequestBody = {
  messages: UIMessage[];
  model: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
  id?: Id<"aisdk_chats">;
  chatId?: Id<"aisdk_chats">;
};

function jsonResponse(body: unknown, responseHeaders: ResponseHeaders, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: {
      ...responseHeaders,
      ...init?.headers,
    },
  });
}

/** Handles the authenticated AI SDK chat request body and stream lifecycle. */
export async function handleAISDKChat(
  ctx: ActionCtx,
  req: Request,
  responseHeaders: ResponseHeaders,
): Promise<Response> {
  const authUser = await authComponent.safeGetAuthUser(ctx);
  const session = authUser?._id
    ? null
    : await createAuth(ctx).api.getSession({
        headers: req.headers,
      });
  const userId = authUser?._id ?? session?.user.id;

  if (!userId) {
    return jsonResponse({ error: { message: "Unauthorized", code: 401 } }, responseHeaders, {
      status: 401,
    });
  }

  const body = (await req.json()) as AISDKChatRequestBody;
  const chatId = (body?.chatId || body?.id)!;

  if (!chatId || !body.model || !Array.isArray(body.messages)) {
    return jsonResponse(
      { error: { message: "Invalid chat request", code: 400 } },
      responseHeaders,
      { status: 400 },
    );
  }

  const chatInfo = await ctx.runQuery(internal.aisdk.InternalChatInfo, {
    chatId,
  });

  if (!chatInfo || chatInfo.userId !== userId)
    return jsonResponse({ error: { message: "Unauthorized", code: 401 } }, responseHeaders, {
      status: 401,
    });

  const provider = createInternalGatewayProvider(ctx, chatInfo.balance, () =>
    jsonResponse(
      { error: { message: "Internal gateway request failed", code: 500 } },
      responseHeaders,
      { status: 500 },
    ),
  );

  await ctx.runMutation(internal.aisdk.EditChat, {
    chatId,
    activeStream: true,
    messages_queue: null,
  });

  // Resolve the chat's enabled tools. MCP servers contribute real, executable
  // tools (HTTP transport); built-in tool sets are config-only for now.
  const { tools, close: closeTools } = await buildChatTools(ctx, chatId);

  const result = streamText({
    model: provider(body.model),
    messages: await convertToModelMessages(body.messages, { tools }),
    tools,
    // Allow follow-up turns so the model can act on executable tool results
    // (Exa web search, MCP tools) instead of stopping at the first tool call.
    stopWhen: isStepCount(5),
    onError: () => void closeTools(),
    providerOptions:
      body.reasoningEffort || body.reasoningBudget
        ? {
            openaiCompatible: {
              ...(body.reasoningEffort && body.reasoningEffort !== "none"
                ? { reasoningEffort: body.reasoningEffort }
                : {}),
              reasoning: {
                ...(body.reasoningEffort ? { effort: body.reasoningEffort } : {}),
                ...(body.reasoningBudget ? { max_tokens: body.reasoningBudget } : {}),
              },
            },
          }
        : undefined,
    abortSignal: req.signal,
  });

  // Track reasoning start time to calculate duration
  let reasoningStartTime: number | null = null;

  return createUIMessageStreamResponse({
    headers: responseHeaders,
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: body.messages,
      sendSources: true,
      sendReasoning: true,
      messageMetadata({ part }) {
        // Track when reasoning starts
        if (part.type === "reasoning-start") {
          if (reasoningStartTime === null) {
            reasoningStartTime = Date.now();
          }
        }
        // Attach cumulative token usage once the response finishes so the client
        // can render context-window usage and cost for the message.
        if (part.type === "finish") {
          return {
            model: body.model,
            usage: part.totalUsage,
          };
        }
        return {
          model: body.model,
        };
      },
      onEnd: async ({ messages }) => {
        // Calculate reasoning duration and add it to reasoning parts
        const messagesWithDuration = messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) => {
            if (part.type === "reasoning" && reasoningStartTime !== null) {
              const durationMs = Date.now() - reasoningStartTime;
              const durationSeconds = Math.ceil(durationMs / 1000);
              return {
                ...part,
                duration: durationSeconds,
              };
            }
            return part;
          }),
        }));
        await ctx.runMutation(internal.aisdk.EditChat, {
          chatId,
          messages: messagesWithDuration,
          activeStream: false,
        });
        await closeTools();
      },
    }),
  });
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
 * enabled and the balance has an Exa API key configured.
 *
 * @todo OAuth / OAuth 2.1 servers: supply an `OAuthClientProvider` via the
 *   transport's `authProvider` instead of a static bearer header.
 */
async function buildChatTools(
  ctx: ActionCtx,
  chatId: Id<"aisdk_chats">,
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const config = await ctx.runQuery(internal.chatroom.resolveChatTools, { chatId });

  const clients: Awaited<ReturnType<typeof createMCPClient>>[] = [];
  // MCP tools are typed with `unknown` inputs; collect them loosely and cast to
  // `ToolSet` once at the boundary to avoid the invariance friction.
  const tools: Record<string, ToolSet[string]> = {};

  const exaTool = await resolveExaWebSearch(ctx, chatId);
  if (exaTool) tools.web_search = exaTool;

  for (const server of config.mcpServers) {
    try {
      const headers = await resolveMcpHeaders(ctx, server._id, server.auth);
      const client = await createMCPClient({
        transport: { type: "http", url: server.url, headers },
      });
      clients.push(client);

      const serverTools = await client.tools();
      const prefix = toolNamePrefix(server.name);
      for (const [name, definition] of Object.entries(serverTools)) {
        tools[uniqueToolName(tools, `${prefix}_${name}`)] = definition as ToolSet[string];
      }
    } catch (error) {
      console.error(`Failed to connect MCP server "${server.name}" (${server.url}):`, error);
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

  return { tools: tools as ToolSet, close };
}

/**
 * Resolve the Exa web-search tool for a chat. Returns `undefined` (search
 * simply isn't offered) when Web Search is disabled or the balance has no Exa
 * API key. The key is loaded here and never sent to the client; the user's
 * location is a mock for now (see `src/utils/chatroom/user-location.ts`).
 */
async function resolveExaWebSearch(
  ctx: ActionCtx,
  chatId: Id<"aisdk_chats">,
): Promise<ToolSet[string] | undefined> {
  const { enabled, balance } = await ctx.runQuery(internal.chatroom.resolveWebSearch, {
    chatId,
  });
  if (!enabled || !balance) {
    if (enabled) console.warn("Web Search is enabled but no Exa API key is configured.");
    return undefined;
  }

  const apiKey = await ctx.runQuery(internal.exa.getApiKeyForRuntime, { balance });
  if (!apiKey) return undefined;

  return webSearch({ apiKey, userLocation: toExaCountry() }) as ToolSet[string];
}

/** Build the request headers for an MCP server connection from its auth config. */
async function resolveMcpHeaders(
  ctx: ActionCtx,
  serverId: Id<"mcp_servers">,
  auth: { type: "none" | "bearer" },
): Promise<Record<string, string> | undefined> {
  if (auth.type !== "bearer") return undefined;

  const token = await secrets.get(ctx, {
    namespace: mcpSecretNamespace(serverId),
    name: MCP_SECRET_NAME,
  });
  return token.ok ? { Authorization: `Bearer ${token.value}` } : undefined;
}

/** Sanitise a server name into a safe tool-name prefix (`[a-zA-Z0-9_]`). */
function toolNamePrefix(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "mcp";
}

/** Ensure a tool name is unique within `tools`, appending a counter if needed. */
function uniqueToolName(tools: ToolSet, name: string): string {
  if (!(name in tools)) return name;
  let counter = 2;
  while (`${name}_${counter}` in tools) counter++;
  return `${name}_${counter}`;
}

/**
 * https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams#3-implement-the-get-handler
 * We can't implement the GET handler. In case we wanted Convex needed to be compatible with an Redis library or create an extremely custom logic to store data into convex, but this aproach would add major pressure on the DB and be harder to maintain
 */
