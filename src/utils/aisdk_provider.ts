import OpenRouterProvider from "./providers/Openrouter"
/**
 * This is supposed to be where every piece of AI is routed for the AI SDK. See `docs` for more information
 */

/**
 * TODO: Balancer for the time being is just openrouter so fuck it.
 */

export default OpenRouterProvider.createAISDK(process.env.OPENROUTER_API_KEY!)