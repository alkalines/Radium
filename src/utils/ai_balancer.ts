import { ChatCompletions_RequestBody_Type } from "./types/openai/types";
import Providers from "./providers";

export default async function AIBalancer(Request: ChatCompletions_RequestBody_Type) {
  /**
   * TODO: Load Balancer, and BYOK, for the time being is just openrouter so fuck it.
   */
  /**
   * @temporary
   */
  return {
    info: Providers.openrouter,
    connector: Providers.openrouter.connector({
      apiKey: process.env.Openrouter_API_Key!,
    }),
  };
}