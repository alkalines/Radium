import * as z from "zod"; // This thing is a fucking heavy

export const Models_Response = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number(),
  owned_by: z.nullish(z.string()), // The official is required
  // Unofficial
  name: z.nullish(z.string()),
  canonical_slug: z.nullish(z.string()),
  pricing: z.nullish(
    z.object({
      prompt: z.union([z.number(), z.string()]),
      completion: z.union([z.number(), z.string()]),
      request: z.nullish(z.union([z.number(), z.string()])),
      image: z.nullish(z.union([z.number(), z.string()])),
      image_token: z.nullish(z.union([z.number(), z.string()])),
      image_output: z.nullish(z.union([z.number(), z.string()])),
      audio: z.nullish(z.union([z.number(), z.string()])),
      input_audio_cache: z.nullish(z.union([z.number(), z.string()])),
      web_search: z.nullish(z.union([z.number(), z.string()])),
      internal_reasoning: z.nullish(z.union([z.number(), z.string()])),
      input_cache_read: z.nullish(z.union([z.number(), z.string()])),
      input_cache_write: z.nullish(z.union([z.number(), z.string()])),
      discount: z.nullish(z.union([z.number(), z.string()])),
    }),
  ),
  context_length: z.nullish(z.number()),
  architecture: z.nullish(
    z.object({
      modality: z.string(),
      input_modalities: z.array(
        z.union([
          z.literal("text"),
          z.literal("image"),
          z.literal("file"),
          z.literal("audio"),
          z.literal("video"),
          z.string(),
        ]),
      ),
      output_modalities: z.array(
        z.union([z.literal("text"), z.literal("image"), z.literal("embeddings"), z.string()]),
      ),
      tokenizer: z.union([
        z.string(),
        z.literal("GPT"),
        z.literal("Claude"),
        z.literal("Gemini"),
        z.literal("Grok"),
        z.literal("Cohere"),
        z.literal("Nova"),
        z.literal("Qwen"),
        z.literal("Qwen3"),
        z.literal("Yi"),
        z.literal("DeepSeek"),
        z.literal("Mistral"),
        z.literal("Llama2"),
        z.literal("Llama3"),
        z.literal("Llama4"),
        z.literal("PaLM"),
        z.literal("RWKV"),
      ]),
      instruct_type: z.nullish(z.string()),
    }),
  ),
  top_provider: z.nullish(
    z.object({
      is_moderated: z.boolean(),
      context_length: z.number(),
      max_completion_tokens: z.number(),
    }),
  ),
  per_request_limits: z.nullish(
    z.object({
      prompt_tokens: z.nullish(z.number()),
      completion_tokens: z.nullish(z.number()),
    }),
  ),
  supported_parameters: z.nullish(
    z.array(
      z.union([
        z.literal("temperature"),
        z.literal("top_p"),
        z.literal("top_k"),
        z.literal("frequency_penalty"),
        z.literal("presence_penalty"),
        z.literal("repetition_penalty"),
        z.literal("min_p"),
        z.literal("top_a"),
        z.literal("seed"),
        z.literal("max_tokens"),
        z.literal("logit_bias"),
        z.literal("logprobs"),
        z.literal("top_logprobs"),
        z.literal("response_format"),
        z.literal("structured_outputs"),
        z.literal("stop"),
        z.literal("tools"),
        z.literal("tool_choice"),
        z.literal("parallel_tool_calls"),
        z.literal("verbosity"),
      ]),
    ),
  ),
  default_parameters: z.nullish(
    z.object({
      temperature: z.number().min(0).max(2),
      top_p: z.number().min(0).max(1),
      frequency_penalty: z.number().min(-2).max(2),
    }),
  ),
  hugging_face_id: z.nullish(z.string()),
  description: z.nullish(z.string()),
});

export type Models_Response_Type = z.infer<typeof Models_Response>;
