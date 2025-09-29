/**
 * LIBS
 */
import { AIProviderConfig } from "../types/ai_provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

/**
 * Provider info and AISDK creator
 */
const OpenRouterProvider: AIProviderConfig = {
  name: "OpenRouter",
  slug: "openrouter",
  baseURL: "https://openrouter.ai/api/v1/",
  policies: {
    trainingOnFree: true,
    trainingOnPaid: true,
    privacy_policy: "https://openrouter.ai/privacy",
    tos: "https://openrouter.ai/terms",
  },
  apiType: "OpenAI",
  async createAISDK(apiKey, baseURL) {
    return createOpenRouter({
      apiKey: apiKey,
      baseURL: baseURL,
      headers: {
        "HTTP-Referer": "https://github.com/alkalines/Radium",
        "X-Title": "Radium Chatroom",
      },
    });
  },
};

/**
 * Export for Provider
 */
export default OpenRouterProvider;
