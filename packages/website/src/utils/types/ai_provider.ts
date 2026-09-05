/**
 * Imports
 */
import { LanguageModel } from "ai";

export type AIProviderNpmPackage =
  | "@openrouter/ai-sdk-provider"
  | "@ai-sdk/openai"
  | "@ai-sdk/openai-compatible"
  | "@ai-sdk/anthropic"
  | "@opencoredev/loginwithchatgpt-ai";

export type AIProviderSDK_Config = {
  apiKey: string;
  name?: string;
  baseURL?: string;
  credentials: Record<string, string>;
  fetch?: typeof fetch;
};

// Copied from @openrouter/ai-sdk-provider OpenRouterChatSettings
export type AIProviderSDK_ModelSettings = {
  /**
   * Reasoning Config
   */
  reasoning?: {
    /**
     * Reasoning efforts
     *
     * @todo Some models don't have `minimal` or `none`
     */
    effort?: string;
    /**
     * Max reasoning tokens per request
     */
    max_tokens?: number;
    /**
     * Enable or not reasoning
     *
     * @function If `effort` is `none` this is off.
     */
    enabled?: boolean;
  };
  /**
   * Identify the user of the client, helps with client analytics and cache.
   */
  user?: string;
  /**
   * [Openrouter Docs - LogitBias](https://openrouter.ai/docs/api-reference/parameters#logit-bias)
   */
  logitBias?: any; // JSON Object
  /**
   * [Openrouter Docs - Logprobs](https://openrouter.ai/docs/api-reference/parameters#logprobs)
   * @todo Implement in translation layer.
   */
  logprobs?: boolean;
  /**
   * Parallel Tool Calls for endpoints that accept it.
   * @todo Implement in translation layer.
   */
  parallelToolCalls?: boolean;
  /**
   * Web search plugin configuration for enabling web search capabilities
   * @todo Support for Exa Search out of the box.
   */
  plugins?: Array<{
    id: "web";
    /**
     * Maximum number of search results to include (default: 5)
     */
    max_results?: number;
    /**
     * Custom search prompt to guide the search query
     */
    search_prompt?: string;
  }>;
  /**
   * Built-in web search options for models that support native web search
   */
  web_search_options?: {
    /**
     * Maximum number of search results to include
     */
    max_results?: number;
    /**
     * Custom search prompt to guide the search query
     */
    search_prompt?: string;
  };
  // Provider is supposed to be at src/utils/ai_balancer.ts
};
export type AIProviderSDK = (
  Config: AIProviderSDK_Config,
) => (model: string, settings?: AIProviderSDK_ModelSettings) => LanguageModel;

/**
 * Configuration at type
 */
export type AIProviderConfig = {
  /**
   * Provider name
   */
  name: string;
  /**
   * Slug for use (ex: openai)
   */
  slug: string;
  npm: AIProviderNpmPackage;
  env: string[];
  doc?: string;
  /**
   * Training policy of the provider
   */
  policies: {
    /**
     * If free models inputs will be used for AI Training
     */
    trainingOnFree: boolean;
    /**
     * If paid models inputs will be used for AI Training
     */
    trainingOnPaid: boolean;
    /**
     * Terms of service (TOS) of the Provider
     */
    tos?: string;
    /**
     * Privacy Policy of the Provider
     */
    privacy_policy?: string;
  };
  /**
   * Where the headquarters is localized.
   */
  headquarters?: string;
  /**
   * Models list available
   * @todo Integration
   */
  //models: any[]; // Later
  /**
   * Default BaseURL of the provider
   */
  defaultBaseURL: string | undefined;
  /**
   * Connector constructor. Explicitly typed to accept AdapterConfig and
   * return an instance of BaseAdapter. Avoids using the `typeof` shortcut.
   */
  connector: AIProviderSDK;
  // Models will be handled at Convex Data table (i hope it doesn't bite me in the Ass later....)
};
