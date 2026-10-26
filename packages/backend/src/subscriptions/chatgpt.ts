import {
  createChatGPTHandler,
  type ChatGPTTokens,
  type CreateChatGPTHandlerOptions,
  type KeyValueStore,
  type RateLimitBucket,
  type StoredSession,
} from "@opencoredev/loginwithchatgpt-server";
import { OPENAI_CODEX_SLUG } from "../provider_slugs";
import { internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { CHATGPT_SUBSCRIPTION_PATH } from "./paths";
import { CHATGPT_SESSION_COOKIE, readSessionCookie } from "./chatgpt_session";

type SubscriptionNamespace = "session" | "rate_limit";

function createStore<T>(ctx: ActionCtx, namespace: SubscriptionNamespace): KeyValueStore<T> {
  return {
    async get(key) {
      return (await ctx.runQuery(internal.subscriptions.getState, {
        provider: OPENAI_CODEX_SLUG,
        namespace,
        key,
      })) as T | undefined;
    },
    async set(key, value, options) {
      await ctx.runMutation(internal.subscriptions.setState, {
        provider: OPENAI_CODEX_SLUG,
        namespace,
        key,
        // Convex values cannot contain object properties whose value is undefined.
        value: JSON.parse(JSON.stringify(value)),
        // Convert the provider's relative TTL to a timestamp at the time of this write.
        expiresAt: options?.ttlMs === undefined ? undefined : Date.now() + options.ttlMs,
      });
    },
    async delete(key) {
      await ctx.runMutation(internal.subscriptions.deleteState, {
        provider: OPENAI_CODEX_SLUG,
        namespace,
        key,
      });
    },
  };
}

/**
 * `overrides.fetch` is the library's raw upstream fetch (Codex and token requests), used to read
 * usage-limit headers the proxy drops. Token export is enabled only by {@link getChatGPTTokens}.
 */
function createHandler(
  ctx: ActionCtx,
  overrides: Pick<CreateChatGPTHandlerOptions, "fetch" | "dangerouslyAllowTokenExport"> = {},
) {
  const secret = process.env.LWC_SECRET;
  if (!secret) {
    throw new Error("LWC_SECRET must be configured in the Convex environment.");
  }
  const siteUrl = process.env.SITE_URL;

  return createChatGPTHandler({
    basePath: CHATGPT_SUBSCRIPTION_PATH,
    secret,
    sessionStore: createStore<StoredSession>(ctx, "session"),
    cookieName: CHATGPT_SESSION_COOKIE,
    cookie: { sameSite: "Lax", secure: siteUrl ? new URL(siteUrl).protocol === "https:" : true },
    allowedOrigins: siteUrl ? [new URL(siteUrl).origin] : [],
    responsesProxy: {
      rateLimit: {
        store: createStore<RateLimitBucket>(ctx, "rate_limit"),
      },
    },
    ...overrides,
  });
}

/**
 * Creates the request-scoped fetch consumed by the ChatGPT AI SDK provider. `upstreamFetch`
 * replaces the library's raw fetch to the Codex backend.
 */
export function createChatGPTSubscriptionFetch(
  ctx: ActionCtx,
  sessionCookie: string,
  upstreamFetch?: typeof fetch,
): typeof fetch {
  const handler = createHandler(ctx, upstreamFetch ? { fetch: upstreamFetch } : {});
  const sourceRequest = new Request(
    `https://radium.internal${CHATGPT_SUBSCRIPTION_PATH}/responses`,
    {
      headers: { cookie: sessionCookie },
    },
  );
  const proxyFetch = handler.proxyFetch(sourceRequest);

  return proxyFetch;
}

/**
 * Fresh access token and account ID of a stored ChatGPT session, for the usage poll. Tokens stay
 * inside the calling backend action; `undefined` when the session is gone.
 */
export async function getChatGPTTokens(
  ctx: ActionCtx,
  sessionCookie: string,
): Promise<ChatGPTTokens | undefined> {
  const handler = createHandler(ctx, { dangerouslyAllowTokenExport: true });
  return await handler.getTokens(
    new Request(`https://radium.internal${CHATGPT_SUBSCRIPTION_PATH}/session`, {
      headers: { cookie: sessionCookie },
    }),
  );
}

/**
 * Handles device login, session state, model discovery, logout, and inference proxying. Each
 * completed login adds a workspace credential: `/login` starts a fresh session whenever the
 * browser's current session is already authenticated, so connecting another account never
 * overwrites a connected one.
 */
export async function handleChatGPTSubscription(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const user = await authComponent.safeGetAuthUser(ctx);
  const workspaceParam = new URL(request.url).searchParams.get("workspace");
  const workspace =
    user && workspaceParam
      ? await ctx.runQuery(internal.workspaces.getOwnedWorkspaceForUser, {
          workspace: workspaceParam,
          userId: user._id,
        })
      : null;
  if (!user || !workspace) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const handler = createHandler(ctx);
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
      forwarded = new Request(request, { headers });
    }
  }

  const response = await handler.handler(forwarded);
  const body = await readJson(response.clone());

  // Bind authenticated sessions; clear a binding on logout or an observed expired session.
  // An unauthenticated status clears it only while the request still carries its cookie.
  if (path.endsWith("/status") && body?.status === "authenticated") {
    if (sessionCookie) {
      await ctx.runMutation(internal.providers.bindOAuthCredential, {
        workspace,
        provider: OPENAI_CODEX_SLUG,
        userId: user._id,
        account: typeof body.user?.accountId === "string" ? body.user.accountId : undefined,
        credentials: { sessionCookie },
        preview: { account: body.user?.email || "Connected ChatGPT account" },
        plan: typeof body.user?.plan === "string" ? body.user.plan : undefined,
      });
    }
  } else if (
    sessionCookie &&
    (path.endsWith("/logout") ||
      ((path.endsWith("/status") || path.endsWith("/session")) &&
        (body?.status === "expired" || body?.status === "unauthenticated")))
  ) {
    await ctx.runMutation(internal.providers.unbindOAuthCredential, {
      workspace,
      provider: OPENAI_CODEX_SLUG,
      userId: user._id,
      credentials: { sessionCookie },
    });
  }

  return response;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
