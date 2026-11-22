import type { LanguageModel } from "ai";
import type { AIProviderSDK_ModelSettings } from "contracts/types/ai_provider";
import type { Runtime } from "../../runtime";
import { limitAdapter } from "../limits/adapters";
import { createLimitCapture, type LimitCapture } from "../limits/capture";
import type { RoutableTarget } from "../providers";
import Providers from "../sdk-providers";
import {
  CHATGPT_SUBSCRIPTION_NPM,
  createChatGPTSubscriptionFetch,
} from "../subscriptions/chatgpt";

/** A routed provider credential and its AI SDK model factory for one attempt. */
export type RoutedProvider = {
  info: RoutableTarget;
  connector: (model: string, settings?: AIProviderSDK_ModelSettings) => LanguageModel;
  /** Usage-limit meters read from this attempt's upstream responses, when the provider has an adapter. */
  limits?: LimitCapture;
};

/**
 * Builds the AI SDK connector for a routed provider credential. Throws when an API-key provider
 * has no usable key, or the ChatGPT subscription is not configured; the attempt loop treats that
 * as an unauthorized attempt. Upstream calls go through `runtime.fetch`; providers with a limit
 * adapter get a wrapper that reads limit signals from every upstream response (for ChatGPT it
 * wraps the library's raw upstream fetch, since the proxy drops headers).
 */
export function createRoutedProvider(runtime: Runtime, target: RoutableTarget): RoutedProvider {
  const credentials = target.credential.values;
  const apiKey = target.env.map((name) => credentials[name]).find(Boolean);
  const isChatGPTSubscription = target.npm === CHATGPT_SUBSCRIPTION_NPM;
  if (!apiKey && !isChatGPTSubscription) {
    throw new Error(
      `Missing API key credential for provider ${target.slug}: ${target.env.join(", ")}`,
    );
  }

  const adapter = limitAdapter({ npm: target.npm, api: target.baseURL, oauth_flow: target.oauthFlow });
  const limits = adapter ? createLimitCapture(adapter, runtime.fetch) : undefined;
  const fetch = limits?.fetch ?? runtime.fetch;

  return {
    info: target,
    connector: Providers[target.npm].connector({
      apiKey: apiKey ?? "",
      name: target.name,
      baseURL: target.baseURL,
      credentials,
      fetch: isChatGPTSubscription
        ? createChatGPTSubscriptionFetch(runtime, credentials.sessionCookie ?? "", fetch)
        : fetch,
    }),
    ...(limits ? { limits } : {}),
  };
}
