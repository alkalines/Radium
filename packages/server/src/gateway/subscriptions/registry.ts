import type { Database, Kv } from "../../drivers/types";
import { endChatGPTSession } from "./chatgpt";

/**
 * Provider-specific behavior of an OAuth/subscription login flow that the generic credential pool
 * needs. Login, refresh and inference stay in each flow's own handler.
 */
export type SubscriptionAdapter = {
  /**
   * Ends the upstream session held by a credential's stored values when the credential is removed
   * or replaced by a reconnect, so its tokens do not outlive it. Tolerates ended sessions and
   * malformed values. Database writes join the caller's transaction.
   */
  endSession(db: Database, kv: Kv, credentials: Record<string, string>): Promise<void>;
};

/** Registered flows by provider `oauth_flow`. */
const adapters: Record<string, SubscriptionAdapter> = {
  "chatgpt-device": { endSession: endChatGPTSession },
};

/** The adapter of an OAuth provider's login flow, if one is registered. */
export function subscriptionAdapter(provider: {
  credential_type?: string;
  oauth_flow?: string;
}): SubscriptionAdapter | undefined {
  if (provider.credential_type !== "oauth" || !provider.oauth_flow) return undefined;
  return adapters[provider.oauth_flow];
}
