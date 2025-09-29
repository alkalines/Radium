/**
 * Configuration at type
 */
export type AIProviderConfig = {
  /**
   * Provider name
   */
  name: string;
  /**
   * Slug for use (ex: openai/)
   */
  slug: string;
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
  // Models will be handled at Convex Data table (i hope it doesn't bite me in the Ass later....)
  /**
   * BaseURL of the provider
   */
  baseURL?: string | undefined;
  /**
   * Type of API
   */
  apiType: "Anthropic" | "OpenAI";
  createAISDK: (baseURL: string, apiKey: string) => Promise<any>; // TODO: Better class
};
