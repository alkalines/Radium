import type { LanguageModel } from "ai";

/** Provider SDK packages that have a connector implementation in this backend. */
export type AIProviderNpmPackage =
  | "@openrouter/ai-sdk-provider"
  | "@ai-sdk/openai"
  | "@ai-sdk/openai-compatible"
  | "@ai-sdk/anthropic"
  | "@opencoredev/loginwithchatgpt-ai";

/** Configuration passed to a provider SDK when constructing its model connector. */
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
};
/** Provider initializer that returns a model factory for the configured SDK. */
export type AIProviderSDK = (
  Config: AIProviderSDK_Config,
) => (model: string, settings?: AIProviderSDK_ModelSettings) => LanguageModel;

/** Catalog and connector configuration for an upstream AI provider. */
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
    /** Whether the provider may use free-model inputs for training. */
    trainingOnFree: boolean;
    /** Whether the provider may use paid-model inputs for training. */
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
   * Default BaseURL of the provider
   */
  defaultBaseURL: string | undefined;
  /** Connector factory that creates a model factory for the configured SDK. */
  connector: AIProviderSDK;
};
