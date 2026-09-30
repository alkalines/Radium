import {
  createChatGPTHandler,
  type KeyValueStore,
  type RateLimitBucket,
  type StoredSession,
} from "@opencoredev/loginwithchatgpt-server";
import { OPENAI_CODEX_SLUG } from "../provider_slugs";
import { internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { CHATGPT_SUBSCRIPTION_PATH } from "./paths";

const COOKIE_NAME = "lwc_chatgpt_subscription";

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

function createHandler(ctx: ActionCtx) {
  const secret = process.env.LWC_SECRET;
  if (!secret) {
    throw new Error("LWC_SECRET must be configured in the Convex environment.");
  }
  const siteUrl = process.env.SITE_URL;

  return createChatGPTHandler({
    basePath: CHATGPT_SUBSCRIPTION_PATH,
    secret,
    sessionStore: createStore<StoredSession>(ctx, "session"),
    cookieName: COOKIE_NAME,
    cookie: { sameSite: "Lax", secure: siteUrl ? new URL(siteUrl).protocol === "https:" : true },
    allowedOrigins: siteUrl ? [new URL(siteUrl).origin] : [],
    responsesProxy: {
      rateLimit: {
        store: createStore<RateLimitBucket>(ctx, "rate_limit"),
      },
    },
  });
}

/** Creates the request-scoped fetch consumed by the ChatGPT AI SDK provider. */
export function createChatGPTSubscriptionFetch(
  ctx: ActionCtx,
  sessionCookie: string,
): typeof fetch {
  const handler = createHandler(ctx);
  const sourceRequest = new Request(
    `https://radium.internal${CHATGPT_SUBSCRIPTION_PATH}/responses`,
    {
      headers: { cookie: sessionCookie },
    },
  );
  const proxyFetch = handler.proxyFetch(sourceRequest);

  return proxyFetch;
}

/** Handles device login, session state, model discovery, logout, and inference proxying. */
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

  const response = await createHandler(ctx).handler(request);
  const path = new URL(request.url).pathname;
  const body = await readJson(response.clone());
  const sessionCookie = readSessionCookie(request.headers.get("cookie"));

  if (path.endsWith("/status") && body?.status === "authenticated") {
    if (sessionCookie) {
      const label = [body.user?.email, body.user?.plan && `${body.user.plan} plan`]
        .filter(Boolean)
        .join(" · ");
      await ctx.runMutation(internal.providers.bindOAuthCredential, {
        workspace,
        provider: OPENAI_CODEX_SLUG,
        userId: user._id,
        credentials: { sessionCookie },
        preview: { account: label || "Connected ChatGPT account" },
      });
    }
  } else if (
    path.endsWith("/logout") ||
    ((path.endsWith("/status") || path.endsWith("/session")) &&
      (body?.status === "expired" || (body?.status === "unauthenticated" && sessionCookie)))
  ) {
    await ctx.runMutation(internal.providers.unbindOAuthCredential, {
      workspace,
      provider: OPENAI_CODEX_SLUG,
      userId: user._id,
    });
  }

  return response;
}

function readSessionCookie(cookieHeader: string | null) {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return value;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
