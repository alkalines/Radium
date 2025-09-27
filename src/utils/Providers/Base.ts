type URLType = `https://${string}` | `http://${string}`

/**
 * Configuration at type
 */
type AIProviderConfig = {
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
    tos?: URLType;
    /**
     * Privacy Policy of the Provider
     */
    privacy_policy?: URLType;
  };
  /**
   * Where the headquarters is localized.
   */
  headquarters: string
  /**
   * Models list available 
   * @todo Integration
   */
  models: any[]; // Later
  /**
   * AI SDK provider.
   */
  aiSDK: any // Also later
};


/**
 * Class for AI Provider
 */
class AIProviderBase {
  Config: AIProviderConfig
  constructor(Config: AIProviderConfig) {
    this.Config = Config
  }
}