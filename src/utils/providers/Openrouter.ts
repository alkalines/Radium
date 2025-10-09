/**
 * LIBS
 */
import OpenAI_Adapter from "../adapters/openai";
import { AIProviderConfig } from "../types/ai_provider";

/**
 * Connector
 */
class OpenRouterConnector extends OpenAI_Adapter {
  constructor(config: { apiKey: string }) {
    super({
      apiKey: config.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
}

/**
 * Provider info and AISDK creator
 */
const OpenRouterProvider: AIProviderConfig = {
  name: "OpenRouter",
  slug: "openrouter",
  defaultBaseURL: "https://openrouter.ai/api/v1/",
  policies: {
    trainingOnFree: true,
    trainingOnPaid: true,
    privacy_policy: "https://openrouter.ai/privacy",
    tos: "https://openrouter.ai/terms",
  },
  connector: OpenRouterConnector,
};

/**
 * Export for Provider
 */
export default OpenRouterProvider;
