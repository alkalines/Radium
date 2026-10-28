import type { MutationCtx } from "../../convex/_generated/server";
import { OPENAI_CODEX_SLUG } from "../provider_slugs";
import type { SubscriptionAdapter } from "./registry";

/** Cookie that carries the signed Login with ChatGPT session ID between browser and handler. */
export const CHATGPT_SESSION_COOKIE = "lwc_chatgpt_subscription";

/** AI SDK provider package whose credentials are a ChatGPT session cookie rather than an API key. */
export const CHATGPT_SUBSCRIPTION_NPM = "@opencoredev/loginwithchatgpt-ai";

/** The `name=value` session cookie pair from a Cookie header, as stored in a credential. */
export function readSessionCookie(cookieHeader: string | null) {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CHATGPT_SESSION_COOKIE}=`));
}

/**
 * Session ID inside a stored `name=value` session cookie, which is the `subscription_state` key
 * the library uses for the session and its rate-limit bucket. The library signs cookies as
 * `<sessionId>.<signature>`; returns `undefined` for any other shape.
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
 * Login with ChatGPT device flow. Credentials hold the session cookie; ending a session deletes
 * the stored session and its rate-limit bucket, as the library's logout does.
 */
export const chatGPTDeviceAdapter: SubscriptionAdapter = {
  async endSession(ctx: MutationCtx, credentials) {
    const sessionId = credentials.sessionCookie && chatGPTSessionId(credentials.sessionCookie);
    if (!sessionId) return;

    for (const namespace of ["session", "rate_limit"] as const) {
      const entry = await ctx.db
        .query("subscription_state")
        .withIndex("by_provider_namespace_key", (q) =>
          q.eq("provider", OPENAI_CODEX_SLUG).eq("namespace", namespace).eq("key", sessionId),
        )
        .unique();
      if (entry) await ctx.db.delete(entry._id);
    }
  },
};
