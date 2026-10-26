import type { LimitAdapter } from "../adapter";
import { chatGPTLimitAdapter } from "./chatgpt";
import { OPENROUTER_HOST, OPENROUTER_NPM, openRouterLimitAdapter } from "./openrouter";

/** Limit adapters of OAuth/subscription flows, keyed by provider `oauth_flow`. */
const oauthAdapters: Record<string, LimitAdapter> = {
  "chatgpt-device": chatGPTLimitAdapter,
};

/** Provider fields that identify its limit adapter. */
export type LimitAdapterProvider = {
  npm: string;
  /** Base URL (`api` in provider snapshots). */
  api?: string;
  oauth_flow?: string;
};

function hostOf(url: string | undefined) {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The limit adapter for a provider: OAuth flows by `oauth_flow`, OpenRouter by AI SDK package or
 * a base URL on `openrouter.ai`. `undefined` means budgets only.
 */
export function limitAdapter(provider: LimitAdapterProvider): LimitAdapter | undefined {
  if (provider.oauth_flow) return oauthAdapters[provider.oauth_flow];
  const host = hostOf(provider.api);
  if (
    provider.npm === OPENROUTER_NPM ||
    host === OPENROUTER_HOST ||
    host?.endsWith(`.${OPENROUTER_HOST}`)
  ) {
    return openRouterLimitAdapter;
  }
  return undefined;
}
