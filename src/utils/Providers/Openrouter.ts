import AIProviderBase from "./Base";
import { createOpenRouter, OpenRouterProvider } from "@openrouter/ai-sdk-provider";

export default class OpenRouter extends AIProviderBase {
  AISDK: OpenRouterProvider;
  constructor(APIKey: string, baseURL: string) {
    // Config
    super({
      name: "OpenRouter",
      slug: "openrouter",
      baseURL: baseURL,
      models: [],
      policies: {
        trainingOnFree: true,
        trainingOnPaid: true,
        privacy_policy: "https://openrouter.ai/privacy",
        tos: "https://openrouter.ai/terms",
      },
    });
    
    // AISDK
    this.AISDK = createOpenRouter({
      apiKey: APIKey,
      headers: {
        "HTTP-Referer": "https://github.com/alkalines/Radium",
        "X-Title": "Radium Chatroom",
      },
    })
  }
}