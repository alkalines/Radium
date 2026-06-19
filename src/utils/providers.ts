import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type {
  AIProviderConfig,
  AIProviderSDK_Config,
  AIProviderSDK_ModelSettings,
  AIProviderNpmPackage,
} from "./types/ai_provider";

const appHeaders = {
  "HTTP-Referer": "https://github.com/alkalines/Radium",
  "X-Title": "Radium Chatroom",
};

const Providers = {
  "@openrouter/ai-sdk-provider": {
    connector: (config: AIProviderSDK_Config) => {
      return (model: string, settings?: AIProviderSDK_ModelSettings) =>
        createOpenRouter({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          appName: "Radium Chatroom",
          appUrl: "https://github.com/alkalines/Radium",
          headers: appHeaders,
        }).chat(model, (settings ?? {}) as any);
    },
  },
  "@ai-sdk/openai": {
    connector: (config: AIProviderSDK_Config) => {
      return (model: string) =>
        createOpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          headers: appHeaders,
        }).chat(model as any);
    },
  },
  "@ai-sdk/openai-compatible": {
    connector: (config: AIProviderSDK_Config) => {
      if (!config.baseURL) throw new Error("OpenAI-compatible providers require a base URL.");

      return (model: string) =>
        createOpenAICompatible({
          name: config.name ?? "OpenAI Compatible",
          apiKey: config.apiKey,
          baseURL: config.baseURL!,
          headers: appHeaders,
        })(model);
    },
  },
  "@ai-sdk/anthropic": {
    connector: (config: AIProviderSDK_Config) => {
      return (model: string) =>
        createAnthropic({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          headers: appHeaders,
        }).chat(model as any);
    },
  },
} satisfies Record<AIProviderNpmPackage, Pick<AIProviderConfig, "connector">>;

export default Providers;
