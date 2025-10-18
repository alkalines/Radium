export type AIProviderSDK_Config = {
  apiKey: string
}
export type AIProviderSDK = (Config: AIProviderSDK_Config) => (model: string, settings?: any) => any

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
