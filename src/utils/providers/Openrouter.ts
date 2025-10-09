/**
 * LIBS
 */
import { AIProviderConfig } from "../types/ai_provider";
import OpenAI_Adapter from "../adapters/openai";

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
  adapter: OpenAI_Adapter,
};

/**
 * Export for Provider
 */
export default OpenRouterProvider;
