import type { ActionCtx } from "../../convex/_generated/server";
import type { RoutableTarget } from "../../convex/providers";
import { limitAdapter } from "../limits/adapters";
import { createLimitCapture, type LimitCapture } from "../limits/capture";
import Providers from "../providers";
import { createChatGPTSubscriptionFetch } from "../subscriptions/chatgpt";
import { CHATGPT_SUBSCRIPTION_NPM } from "../subscriptions/chatgpt_session";
import type { AIProviderSDK_ModelSettings } from "../types/ai_provider";
import type { LanguageModel } from "ai";

/** A routed provider credential and its AI SDK model factory for one attempt. */
export type RoutedProvider = {
  info: RoutableTarget;
  connector: (model: string, settings?: AIProviderSDK_ModelSettings) => LanguageModel;
  /** Usage-limit meters read from this attempt's upstream responses, when the provider has an adapter. */
  limits?: LimitCapture;
};

/**
 * Build the AI SDK connector for a routed provider credential. Throws when an API-key provider
 * has no usable key; subscription providers authenticate through a request-scoped session proxy.
 * Providers with a limit adapter get a fetch wrapper that reads limit signals from every upstream
 * response; for ChatGPT it wraps the library's raw upstream fetch, since the proxy drops headers.
 */
export function createRoutedProvider(ctx: ActionCtx, target: RoutableTarget): RoutedProvider {
  const credentials = target.credential.values;
  const apiKey = target.env.map((name) => credentials[name]).find(Boolean);
  const isChatGPTSubscription = target.npm === CHATGPT_SUBSCRIPTION_NPM;

  if (!apiKey && !isChatGPTSubscription) {
    throw new Error(
      `Missing API key credential for provider ${target.slug}: ${target.env.join(", ")}`,
    );
  }

  const adapter = limitAdapter({
    npm: target.npm,
    api: target.baseURL,
    oauth_flow: target.oauthFlow,
  });
  const limits = adapter ? createLimitCapture(adapter) : undefined;

  return {
    info: target,
    connector: Providers[target.npm].connector({
      apiKey: apiKey ?? "",
      name: target.name,
      baseURL: target.baseURL,
      credentials,
      fetch: isChatGPTSubscription
        ? createChatGPTSubscriptionFetch(ctx, credentials.sessionCookie ?? "", limits?.fetch)
        : limits?.fetch,
    }),
    ...(limits ? { limits } : {}),
  };
}
