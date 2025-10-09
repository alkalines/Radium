import OpenRouterProvider from "./providers/Openrouter";
import { AIProviderConfig } from "./types/ai_provider";
/**
 * Types
 */
type ProvidersType = {
  [key: string]: AIProviderConfig;
};

/**
 * Providers available 
 */
const Providers = {
  OpenRouter: OpenRouterProvider
};

export default Providers