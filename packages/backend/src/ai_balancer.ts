import type { ChatCompletions_RequestBody_Type } from "./types/openai/types";
import Providers from "./providers";
import { internal } from "../convex/_generated/api";
import type { GenericActionCtx } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { createChatGPTSubscriptionFetch } from "./subscriptions/chatgpt";

/**
 * Select a workspace-configured provider candidate for the requested model and
 * construct its AI SDK model connector. Provider selection is random among the
 * candidates returned by the workspace resolver.
 */
export default async function AIBalancer(
  ctx: GenericActionCtx<any>,
  workspaceId: Id<"workspaces">,
  request: ChatCompletions_RequestBody_Type,
) {
  const candidates = await ctx.runQuery(internal.providers.resolveProviderCandidatesForModel, {
    workspace: workspaceId,
    modelSlug: request.model,
    providerSlug: request.provider ?? undefined,
  });
  const selectedProvider = candidates[Math.floor(Math.random() * candidates.length)];
  const credentials = selectedProvider.credentials;
  const apiKey = selectedProvider.env.map((name) => credentials[name]).find(Boolean);
  const isChatGPTSubscription = selectedProvider.npm === "@opencoredev/loginwithchatgpt-ai";

  if (!apiKey && !isChatGPTSubscription) {
    throw new Error(
      `Missing API key credential for provider ${selectedProvider.slug}: ${selectedProvider.env.join(", ")}`,
    );
  }

  return {
    info: selectedProvider,
    connector: Providers[selectedProvider.npm].connector({
      apiKey: apiKey ?? "",
      name: selectedProvider.name,
      baseURL: selectedProvider.baseURL,
      credentials,
      fetch: isChatGPTSubscription
        ? createChatGPTSubscriptionFetch(ctx, credentials.sessionCookie)
        : undefined,
    }),
  };
}
