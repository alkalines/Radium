import type { MutationCtx } from "../../convex/_generated/server";
import { chatGPTDeviceAdapter } from "./chatgpt_session";

/**
 * Provider-specific behavior of an OAuth/subscription login flow that the generic credential pool
 * needs. Login, refresh, and inference stay in each flow's own handler.
 */
export type SubscriptionAdapter = {
  /**
   * End the upstream session held by a credential's stored values when the credential is removed
   * or replaced by a reconnect, so its tokens do not outlive it. Must tolerate already-ended
   * sessions and malformed values.
   */
  endSession(ctx: MutationCtx, credentials: Record<string, string>): Promise<void>;
};

/** Registered flows keyed by provider `oauth_flow`. */
const adapters: Record<string, SubscriptionAdapter> = {
  "chatgpt-device": chatGPTDeviceAdapter,
};

/** The adapter for an OAuth provider's login flow, if one is registered. */
export function subscriptionAdapter(provider: {
  credential_type?: string;
  oauth_flow?: string;
}): SubscriptionAdapter | undefined {
  if (provider.credential_type !== "oauth" || !provider.oauth_flow) return undefined;
  return adapters[provider.oauth_flow];
}
