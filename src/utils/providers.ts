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
  // Only use lowercase letters for the Providers ID
  openrouter: OpenRouterProvider,
} as ProvidersType;

export default Providers;
