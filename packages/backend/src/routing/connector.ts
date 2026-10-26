import type { ActionCtx } from "../../convex/_generated/server";
import type { RoutableTarget } from "../../convex/providers";
import Providers from "../providers";
import { createChatGPTSubscriptionFetch } from "../subscriptions/chatgpt";
import { CHATGPT_SUBSCRIPTION_NPM } from "../subscriptions/chatgpt_session";
import type { AIProviderSDK_ModelSettings } from "../types/ai_provider";
import type { LanguageModel } from "ai";

/** A routed provider credential and its AI SDK model factory for one attempt. */
export type RoutedProvider = {
  info: RoutableTarget;
  connector: (model: string, settings?: AIProviderSDK_ModelSettings) => LanguageModel;
};

/**
 * Build the AI SDK connector for a routed provider credential. Throws when an API-key provider
 * has no usable key; subscription providers authenticate through a request-scoped session proxy.
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

  return {
    info: target,
    connector: Providers[target.npm].connector({
      apiKey: apiKey ?? "",
      name: target.name,
      baseURL: target.baseURL,
      credentials,
      fetch: isChatGPTSubscription
        ? createChatGPTSubscriptionFetch(ctx, credentials.sessionCookie ?? "")
        : undefined,
    }),
  };
}
