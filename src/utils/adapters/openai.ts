/**
 * Imports
 */
import {
  ChatCompletions_RequestBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "../types/openai/types";

/**
 * OpenAI Adapter
 */
export default class OpenAI_Adapter {
  private apiKey: string;
  baseURL: string;
  constructor(apiKey: string, baseURL: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async GenerateCompletion(request: ChatCompletions_RequestBody_Type) {
    const completionRequest = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    return await completionRequest.json();
  }

  async StreamCompletion(
    request: ChatCompletions_RequestBody_Type
  ) {
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

  async *chunksReader(ChunksList: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<ChatCompletions_Streaming_Chunk_Type, boolean, void> {
    while (true) {
      const data = await ChunksList.read();
      if (data.done) return true; // break

      const value = new TextDecoder().decode(data.value).replace("data: ", "");

      try {
        yield JSON.parse(value) as ChatCompletions_Streaming_Chunk_Type;
      } catch (e) {}
    }
  }
}
