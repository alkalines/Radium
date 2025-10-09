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
  baseURL: string;
};

export type chuckListType = AsyncGenerator<ChatCompletions_Streaming_Chunk_Type, boolean, void>

/**
 * Class to create adapter for Provider
 */
export default abstract class BaseAdapter {
  constructor(Config: AdapterConfig) {
    // This is just a base man!
  }

  abstract GenerateCompletion(
    request: ChatCompletions_RequestBody_Type
  ): Promise<ChatCompletions_NotStreaming_ResponseBody_Type>;
  abstract StreamCompletion(
    request: ChatCompletions_RequestBody_Type
  ): Promise<chuckListType>;
}