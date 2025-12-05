import { Models_Response_Type } from "@/utils/types/openai/models";
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";


export const openaiModels = internalQuery({
  args: {},
  handler: async (ctx, args): Promise<Models_Response_Type[]> => {
    const modelsList = await ctx.db.query("models").collect();

    return modelsList.map((m) => {
      // @todo: Get more consistent statics
      const baseProvider = m.providers[0];
      const topProvider = m.providers[0];

      return {
        id: m.slug,
        canonical_slug: m.slug,
        created: Math.floor(m._creationTime / 1000), // UNIX: Math.floor(Date.now() / 1000)
        object: "model",
        description: m.description,
        name: m.name,
        hugging_face_id: m.model_weights?.split("https://huggingface.co/")[1],
        architecture: {
          modality: `${m.architecture.input_modalities.join("+")}->${m.architecture.output_modalities.join("+")}`,
          input_modalities: m.architecture.input_modalities,
          output_modalities: m.architecture.output_modalities,
          tokenizer: m.architecture.tokenizer,
          instruct_type: null, // WTF OPENROUTER
        },
        default_parameters: {
          frequency_penalty: m.default_parameters?.frequency_penalty,
          temperature: m.default_parameters?.temperature,
          top_p: m.default_parameters?.top_p,
        },
        per_request_limits: {
          completion_tokens: null,
          prompt_tokens: null,
        },
        // Provider based
        supported_parameters: baseProvider.supported_parameters,
        pricing: {
          prompt: baseProvider.pricing.input,
          completion: baseProvider.pricing.output,
          input_cache_read: baseProvider.pricing.cache_read,
          input_cache_write: baseProvider.pricing.cache_write,
          // @todo
        },
        context_length: baseProvider.context,
        top_provider: {
          context_length: topProvider.context,
          max_completion_tokens: topProvider.max_output,
          is_moderated: topProvider.moderated,
        },
      } as Models_Response_Type;
    });
  },
});

export const availableModels = query({
  handler(ctx) {
    return ctx.db.query("models").collect();
  },
});

export const modelInfo = query({
  args: {
    slug: v.string(),
  },
  handler(ctx, args) {
    return ctx.db
      .query("models")
      .filter((q) => q.eq(q.field("slug"), args.slug))
      .first();
  },
});
