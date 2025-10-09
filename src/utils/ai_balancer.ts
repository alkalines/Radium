import { ChatCompletions_RequestBody_Type } from "./types/openai/types";
import Providers from "./providers";

export default async function AIBalancer(Request: ChatCompletions_RequestBody_Type) {
  /**
   * TODO: Load Balancer, and Credential manager, for the time being is just openrouter so fuck it.
   */
  return new Providers.OpenRouter.connector({
    apiKey: process.env.Openrouter_API_Key!
  })
}