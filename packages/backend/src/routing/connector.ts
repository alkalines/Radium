import type { ActionCtx } from "../../convex/_generated/server";
import type { RoutableProvider } from "../../convex/providers";
import Providers from "../providers";
import { createChatGPTSubscriptionFetch } from "../subscriptions/chatgpt";
import type { AIProviderSDK_ModelSettings } from "../types/ai_provider";
import type { LanguageModel } from "ai";

/** A routed provider and its AI SDK model factory for one attempt. */
export type RoutedProvider = {
  info: RoutableProvider;
  connector: (model: string, settings?: AIProviderSDK_ModelSettings) => LanguageModel;
};

/**
 * Build the AI SDK connector for a routed provider. Throws when an API-key provider has no
 * usable key; subscription providers authenticate through a request-scoped session proxy.
 */
export function createRoutedProvider(ctx: ActionCtx, provider: RoutableProvider): RoutedProvider {
  const credentials = provider.credentials;
  const apiKey = provider.env.map((name) => credentials[name]).find(Boolean);
  const isChatGPTSubscription = provider.npm === "@opencoredev/loginwithchatgpt-ai";

  if (!apiKey && !isChatGPTSubscription) {
    throw new Error(
      `Missing API key credential for provider ${provider.slug}: ${provider.env.join(", ")}`,
    );
  }

  return {
    info: provider,
    connector: Providers[provider.npm].connector({
      apiKey: apiKey ?? "",
      name: provider.name,
      baseURL: provider.baseURL,
      credentials,
      fetch: isChatGPTSubscription
        ? createChatGPTSubscriptionFetch(ctx, credentials.sessionCookie ?? "")
        : undefined,
    }),
  };
}
