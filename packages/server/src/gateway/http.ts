import type { ChatGPTHandler } from "@opencoredev/loginwithchatgpt-server";
import type { Hono } from "hono";
import { OPENAI_CODEX_SLUG } from "contracts/provider_slugs";
import * as z from "zod";
import type { Runtime } from "../runtime";
import { telemetrySettingsFor } from "../telemetry/capture";
import { workspaceAccess } from "../workspaces/access";
import { createCompletion } from "./completions";
import { bindOAuthCredential, unbindOAuthCredential } from "./credentials";
import { ApiKeyRefused, resolveApiKey, type ResolvedApiKey } from "./keys";
import { openaiModels } from "./models";
import { ChatCompletions_RequestBody } from "./openai/types";
import { RoutingConfigurationError } from "./providers";
import {
  CHATGPT_SUBSCRIPTION_PATH,
  ChatGPTSubscriptionUnavailable,
  createChatGPTSubscriptionHandler,
  readSessionCookie,
} from "./subscriptions/chatgpt";

type GatewayApp = Hono<{ Variables: { runtime: Runtime } }>;

/**
 * Turns Bun's per-connection idle timeout (10 s) off for this request: generations can be quiet
 * for longer than that before their first byte or between chunks (task 14, Phase 0). srvx
 * exposes the Bun server on the request under Nitro; other runtimes have no such timeout.
 */
function disableIdleTimeout(request: Request) {
  const bun = (
    request as Request & {
      runtime?: { bun?: { server?: { timeout?(request: Request, seconds: number): void } } };
    }
  ).runtime?.bun;
  bun?.server?.timeout?.(request, 0);
}

/** 401 in the Gateway's error shape. */
function unauthorized(message: string) {
  return Response.json({ error: { message, code: 401 } }, { status: 401 });
}

/**
 * Resolves the request's Gateway key (`Authorization: Bearer rad-sk-…`), or the 401 response.
 * Only the "Worker key deleted" refusal carries its own message; every other failure, including
 * a lookup error, is the generic invalid-key answer.
 */
async function authorizeGatewayKey(
  runtime: Runtime,
  request: Request,
): Promise<ResolvedApiKey | Response> {
  const bearer = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!bearer) return unauthorized("The Authorization field is empty!");
  try {
    return await resolveApiKey(runtime.drivers.db, runtime.drivers.kv, bearer);
  } catch (error) {
    return unauthorized(
      error instanceof ApiKeyRefused ? error.message : "The Authorization is invalid!",
    );
  }
}

/**
 * `POST /api/openai/v1/chat/completions`: an OpenAI-compatible chat completion routed through
 * the key's workspace providers. Same paths, statuses and error bodies as the Convex Gateway:
 * an invalid body is `400` with the zod issues (checked before the key), a missing or invalid
 * key `401 {error:{message,code}}`, routing failures the last upstream status with
 * `{error:{message,code,status,type?,provider?}}`, configuration errors `500 {error}`.
 */
export async function handleChatCompletion(runtime: Runtime, request: Request): Promise<Response> {
  try {
    const rawBody: unknown = await request.json();
    const body = ChatCompletions_RequestBody.parse(rawBody);

    const key = await authorizeGatewayKey(runtime, request);
    if (key instanceof Response) return key;

    const settings = await telemetrySettingsFor(runtime.drivers.db, key.workspace);
    return await createCompletion(runtime, body, {
      workspace: key.workspace,
      apiKey: key.id,
      headers: request.headers,
      rawBody,
      abortSignal: request.signal,
      telemetry:
        settings.enabled && key.telemetry !== "off"
          ? {
              workspace: key.workspace,
              apiKey: key.id,
              userId: key.userId,
              requestId: crypto.randomUUID(),
              settings,
            }
          : undefined,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json(error.issues, { status: 400 });
    // Configuration errors and malformed JSON describe the caller's own request.
    if (error instanceof RoutingConfigurationError || error instanceof SyntaxError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    console.error(
      "Gateway completion failed:",
      error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error",
    );
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** `GET /api/openai/v1/models`: the OpenAI-compatible model list of the key's workspace. */
export async function handleOpenAIModels(runtime: Runtime, request: Request): Promise<Response> {
  const key = await authorizeGatewayKey(runtime, request);
  if (key instanceof Response) return key;
  return Response.json(await openaiModels(runtime.drivers.db, key.workspace));
}

/**
 * `/api/subscription/chatgpt-subscription/*`: Login with ChatGPT device login, session state,
 * model discovery, logout and inference proxying, for the signed-in owner of `?workspace=`.
 * Each completed login adds a workspace credential: `/login` starts a fresh session whenever the
 * browser's current session is already authenticated, so connecting another account never
 * overwrites a connected one. Authenticated statuses bind the session; logout or an observed
 * expired/unauthenticated session (while the request still carries its cookie) unbinds it.
 */
export async function handleChatGPTSubscription(
  runtime: Runtime,
  request: Request,
): Promise<Response> {
  const session = await runtime.auth.api.getSession({ headers: request.headers });
  const workspaceParam = new URL(request.url).searchParams.get("workspace");
  const access =
    session && workspaceParam
      ? await workspaceAccess(runtime.drivers.db, session.user.id, workspaceParam)
      : null;
  if (!session || access?.role !== "owner") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const workspace = access.workspace.id;

  let handler: ChatGPTHandler;
  try {
    handler = createChatGPTSubscriptionHandler(runtime);
  } catch (error) {
    if (!(error instanceof ChatGPTSubscriptionUnavailable)) throw error;
    return Response.json({ error: error.message }, { status: 503 });
  }

  const path = new URL(request.url).pathname;
  const sessionCookie = readSessionCookie(request.headers.get("cookie"));

  // The library restarts login inside the cookie's session, which would replace that account's
  // tokens. Dropping the cookie makes it issue a new session; the old one stays bound.
  let forwarded = request;
  if (path.endsWith("/login") && sessionCookie) {
    const current = await handler.getSession(request);
    if (current.status === "authenticated") {
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      // Rebuilt from its parts: `new Request(request, { headers })` keeps the original headers
      // on some runtimes.
      forwarded = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        duplex: "half",
      } as RequestInit);
    }
  }

  const response = await handler.handler(forwarded);
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as
    | { status?: string; user?: { accountId?: unknown; email?: unknown; plan?: unknown } }
    | undefined;

  if (path.endsWith("/status") && body?.status === "authenticated") {
    if (sessionCookie) {
      await bindOAuthCredential(runtime, {
        workspace,
        provider: OPENAI_CODEX_SLUG,
        account: typeof body.user?.accountId === "string" ? body.user.accountId : undefined,
        credentials: { sessionCookie },
        preview: {
          account:
            typeof body.user?.email === "string" && body.user.email
              ? body.user.email
              : "Connected ChatGPT account",
        },
        plan: typeof body.user?.plan === "string" ? body.user.plan : undefined,
      });
    }
  } else if (
    sessionCookie &&
    (path.endsWith("/logout") ||
      ((path.endsWith("/status") || path.endsWith("/session")) &&
        (body?.status === "expired" || body?.status === "unauthenticated")))
  ) {
    await unbindOAuthCredential(runtime, {
      workspace,
      provider: OPENAI_CODEX_SLUG,
      credentials: { sessionCookie },
    });
  }
  return response;
}

/** Mounts the Gateway's HTTP routes on the backend's Hono app. */
export function mountGatewayRoutes(app: GatewayApp) {
  app.post("/api/openai/v1/chat/completions", (c) => {
    disableIdleTimeout(c.req.raw);
    return handleChatCompletion(c.var.runtime, c.req.raw);
  });
  app.get("/api/openai/v1/models", (c) => handleOpenAIModels(c.var.runtime, c.req.raw));
  app.on(["GET", "POST"], `${CHATGPT_SUBSCRIPTION_PATH}/*`, (c) => {
    disableIdleTimeout(c.req.raw);
    return handleChatGPTSubscription(c.var.runtime, c.req.raw);
  });
}
