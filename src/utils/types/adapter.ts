/**
 * Imports
 */
import {
  ChatCompletions_RequestBody_Type,
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "./openai/types";

/**
 * Types
 */

export type AdapterConfig = {
  apiKey: string;
  baseURL?: string;
};

export type chuckListType = AsyncGenerator<ChatCompletions_Streaming_Chunk_Type, boolean, void>

/**
 * Class to create adapter for Provider
 */
export default abstract class BaseAdapter {
  constructor(Config: AdapterConfig) {
    // This is just a base man!
  }

  /**
   * Generate non streaming completion
   * @param request OpenAI request
   * @returns OpenAI non streaming body response.
   */
  abstract GenerateCompletion(
    request: ChatCompletions_RequestBody_Type
  ): Promise<ChatCompletions_NotStreaming_ResponseBody_Type>;

  /**
   * Generate streaming completion.
   * @param request OpenAI request
   * @returns OpenAI chunks streaming
   */
  abstract StreamCompletion(
    request: ChatCompletions_RequestBody_Type
  ): Promise<{
    chunks: chuckListType;
    abort: AbortController;
  }>;
}