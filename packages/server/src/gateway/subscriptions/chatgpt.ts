import {
  createChatGPTHandler,
  type ChatGPTTokens,
  type CreateChatGPTHandlerOptions,
  type KeyValueStore,
  type RateLimitBucket,
  type StoredSession,
} from "@opencoredev/loginwithchatgpt-server";
import { and, eq } from "drizzle-orm";
import { OPENAI_CODEX_SLUG } from "contracts/provider_slugs";
import type { Database, Kv } from "../../drivers/types";
import { kvDelete, kvGet, kvSet } from "../../kv";
import type { Runtime } from "../../runtime";
import { subscriptionSessions } from "../schema";

/** Where the ChatGPT subscription routes are mounted (`src/app.ts`); also the proxy base path. */
export const CHATGPT_SUBSCRIPTION_PATH = "/api/subscription/chatgpt-subscription";

/** Cookie that carries the signed Login with ChatGPT session id between browser and handler. */
export const CHATGPT_SESSION_COOKIE = "lwc_chatgpt_subscription";

/** AI SDK provider package whose credentials are a ChatGPT session cookie, not an API key. */
export const CHATGPT_SUBSCRIPTION_NPM = "@opencoredev/loginwithchatgpt-ai";

/** The `name=value` session cookie pair from a Cookie header, as stored in a credential. */
export function readSessionCookie(cookieHeader: string | null) {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CHATGPT_SESSION_COOKIE}=`));
}

/**
 * Session id inside a stored `name=value` session cookie: the key the library stores the
 * session and its rate-limit bucket under. The library signs cookies as `<sessionId>.<signature>`;
 * any other shape gives `undefined`.
 */
export function chatGPTSessionId(sessionCookie: string) {
  const prefix = `${CHATGPT_SESSION_COOKIE}=`;
  if (!sessionCookie.startsWith(prefix)) return undefined;
  let signed: string;
  try {
    signed = decodeURIComponent(sessionCookie.slice(prefix.length));
  } catch {
    return undefined;
  }
  const separator = signed.lastIndexOf(".");
  return separator > 0 ? signed.slice(0, separator) : undefined;
}

/**
 * Login sessions live in Postgres (`subscription_sessions`): losing one forces a new login.
 * Expiry is lazy, as in Convex: an expired row reads as absent until a write replaces it.
 */
function sessionStore(db: Database): KeyValueStore<StoredSession> {
  const where = (key: string) =>
    and(eq(subscriptionSessions.provider, OPENAI_CODEX_SLUG), eq(subscriptionSessions.key, key));
  return {
    async get(key) {
      const [row] = await db
        .select({ value: subscriptionSessions.value, expiresAt: subscriptionSessions.expiresAt })
        .from(subscriptionSessions)
        .where(where(key));
      if (!row || (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())) {
        return undefined;
      }
      return row.value as StoredSession;
    },
    async set(key, value, options) {
      const expiresAt = options?.ttlMs === undefined ? null : new Date(Date.now() + options.ttlMs);
      // One upsert on the unique `(provider, key)`, so concurrent writes of a session never
      // create two rows.
      await db
        .insert(subscriptionSessions)
        .values({ provider: OPENAI_CODEX_SLUG, key, value, expiresAt })
        .onConflictDoUpdate({
          target: [subscriptionSessions.provider, subscriptionSessions.key],
          set: { value, expiresAt },
        });
    },
    async delete(key) {
      await db.delete(subscriptionSessions).where(where(key));
    },
  };
}

/** Valkey key of a session's `/responses` rate-limit bucket (`docs/Backend_Migration/Live_Data.md`). */
function rateLimitKey(sessionId: string) {
  return `subscription:rate:${OPENAI_CODEX_SLUG}:${sessionId}`;
}

/** Rate-limit buckets are counters with the window as TTL; losing one only resets the window. */
function rateLimitStore(runtime: Runtime): KeyValueStore<RateLimitBucket> {
  const { kv } = runtime.drivers;
  return {
    async get(key) {
      const value = await kvGet(kv, rateLimitKey(key));
      return value === null ? undefined : (JSON.parse(value) as RateLimitBucket);
    },
    async set(key, value, options) {
      await kvSet(kv, rateLimitKey(key), JSON.stringify(value), {
        // The library always sends the window; a bucket never outlives one minute without it.
        ttlMs: options?.ttlMs ?? 60_000,
      });
    },
    async delete(key) {
      await kvDelete(kv, rateLimitKey(key));
    },
  };
}

/** Thrown when `LWC_SECRET` is not configured: the subscription is turned off. */
export class ChatGPTSubscriptionUnavailable extends Error {
  constructor() {
    super("The ChatGPT subscription is not configured on this server.");
    this.name = "ChatGPTSubscriptionUnavailable";
  }
}

/**
 * The Login with ChatGPT handler of this server. Upstream calls (Codex and token requests) go
 * through `runtime.fetch`; `overrides.fetch` replaces it, which the limits capture uses to read
 * usage-limit headers the proxy drops. Token export is enabled only by {@link getChatGPTTokens}.
 */
export function createChatGPTSubscriptionHandler(
  runtime: Runtime,
  overrides: Pick<CreateChatGPTHandlerOptions, "fetch" | "dangerouslyAllowTokenExport"> = {},
) {
  const secret = runtime.config.LWC_SECRET;
  if (!secret) throw new ChatGPTSubscriptionUnavailable();
  const siteUrl = new URL(runtime.config.SITE_URL);
  return createChatGPTHandler({
    basePath: CHATGPT_SUBSCRIPTION_PATH,
    secret,
    sessionStore: sessionStore(runtime.drivers.db),
    cookieName: CHATGPT_SESSION_COOKIE,
    cookie: { sameSite: "Lax", secure: siteUrl.protocol === "https:" },
    allowedOrigins: [siteUrl.origin],
    responsesProxy: { rateLimit: { store: rateLimitStore(runtime) } },
    fetch: runtime.fetch,
    ...overrides,
  });
}

/**
 * The fetch the ChatGPT AI SDK provider uses for one routed attempt, bound to a stored session
 * cookie. `upstreamFetch` replaces the library's raw fetch to the Codex backend.
 */
export function createChatGPTSubscriptionFetch(
  runtime: Runtime,
  sessionCookie: string,
  upstreamFetch?: typeof fetch,
): typeof fetch {
  const handler = createChatGPTSubscriptionHandler(
    runtime,
    upstreamFetch ? { fetch: upstreamFetch } : {},
  );
  return handler.proxyFetch(
    new Request(`https://radium.internal${CHATGPT_SUBSCRIPTION_PATH}/responses`, {
      headers: { cookie: sessionCookie },
    }),
  );
}

/**
 * Fresh access token and account id of a stored ChatGPT session, for the usage poll. Tokens stay
 * inside the server; `undefined` when the session is gone.
 */
export async function getChatGPTTokens(
  runtime: Runtime,
  sessionCookie: string,
  upstreamFetch?: typeof fetch,
): Promise<ChatGPTTokens | undefined> {
  const handler = createChatGPTSubscriptionHandler(runtime, {
    dangerouslyAllowTokenExport: true,
    ...(upstreamFetch ? { fetch: upstreamFetch } : {}),
  });
  return await handler.getTokens(
    new Request(`https://radium.internal${CHATGPT_SUBSCRIPTION_PATH}/session`, {
      headers: { cookie: sessionCookie },
    }),
  );
}

/**
 * Ends the upstream session held by a ChatGPT credential's stored values: deletes the stored
 * session (in the caller's transaction) and its rate-limit bucket, as the library's logout does.
 * Tolerates ended sessions and malformed values.
 */
export async function endChatGPTSession(
  db: Database,
  kv: Kv,
  credentials: Record<string, string>,
) {
  const sessionId = credentials.sessionCookie && chatGPTSessionId(credentials.sessionCookie);
  if (!sessionId) return;
  await sessionStore(db).delete(sessionId);
  await kvDelete(kv, rateLimitKey(sessionId));
}
