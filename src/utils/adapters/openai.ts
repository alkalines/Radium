/**
 * Imports
 */
import {
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
  ChatCompletions_NotStreaming_ResponseBody_Type
} from "../types/openai/types";
import BaseAdapter, {
  AdapterConfig,
  chuckListType
} from "../types/adapter";

/**
 * OpenAI Adapter implementing BaseAdapter contract
 */
export default class OpenAI_Adapter extends BaseAdapter {
  private apiKey: string;
  baseURL: string;

  constructor(config: AdapterConfig) {
    super(config);
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL!;
  }

  async GenerateCompletion(
    request: ChatCompletions_RequestBody_Type
  ): Promise<ChatCompletions_NotStreaming_ResponseBody_Type> {
    const completionRequest = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    return (await completionRequest.json()) as ChatCompletions_NotStreaming_ResponseBody_Type;
  }

  async StreamCompletion(
    request: ChatCompletions_RequestBody_Type
  ): Promise<chuckListType> {
    const completionRequest = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    const ChunksList = completionRequest.body!.getReader();
    return await this.chunksReader(ChunksList);
  }

  private async *chunksReader(
    ChunksList: ReadableStreamDefaultReader<Uint8Array>
  ): chuckListType {
    while (true) {
      const data = await ChunksList.read();
      if (data.done) return true; // break

      const value = new TextDecoder().decode(data.value).replace("data: ", "");

      try {
        yield JSON.parse(value) as ChatCompletions_Streaming_Chunk_Type;
      } catch {
        // swallow malformed / keep-alive events
      }
    }
  }
}
