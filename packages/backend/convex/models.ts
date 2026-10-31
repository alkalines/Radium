import type { Models_Response_Type } from "@/types/openai/models";
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { isWorkspaceProviderEnabled, workspaceProviderRecords } from "./provider_records";
import { workspaceQuery } from "./helpers";

/** Return the OpenAI-compatible model listing for one validated workspace. */
export const openaiModels = internalQuery({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<Models_Response_Type[]> => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || workspace.archivedAt !== undefined) throw new Error("Workspace not found.");
    const [models, providerRecords] = await Promise.all([
      ctx.db.query("models").take(200),
      workspaceProviderRecords(ctx, workspace),
    ]);
    const configuredProviders = providerRecords.filter(isWorkspaceProviderEnabled);

    return models.flatMap((model) => {
      // @todo: Get more consistent statics
      const providerModels = configuredProviders.flatMap(({ provider }) =>
        provider.models.filter((providerModel) => providerModel.model === model.slug),
      );
      // Preserve configured-provider order; the API exposes the first matching provider model.
      const selectedProviderModel = providerModels[0];
      if (!selectedProviderModel) return [];

      return [
        {
          id: model.slug,
          canonical_slug: model.slug,
          created: Math.floor(model._creationTime / 1000), // Unix timestamp in seconds.
          object: "model",
          description: model.description,
          name: model.name,
          hugging_face_id: model.model_weights?.split("https://huggingface.co/")[1],
          architecture: {
            modality: `${model.architecture.input_modalities.join("+")}->${model.architecture.output_modalities.join("+")}`,
            input_modalities: model.architecture.input_modalities,
            output_modalities: model.architecture.output_modalities,
            tokenizer: model.architecture.tokenizer,
            instruct_type: null, // Kept for compatibility with OpenRouter model metadata.
          },
          default_parameters: {
            frequency_penalty: model.default_parameters?.frequency_penalty,
            temperature: model.default_parameters?.temperature,
            top_p: model.default_parameters?.top_p,
          },
          per_request_limits: {
            completion_tokens: null,
            prompt_tokens: null,
          },
          // Provider based
          supported_parameters: selectedProviderModel.supported_parameters,
          pricing: {
            prompt: selectedProviderModel.pricing.input,
            completion: selectedProviderModel.pricing.output,
            input_cache_read: selectedProviderModel.pricing.cache_read,
            input_cache_write: selectedProviderModel.pricing.cache_write,
            // @todo
          },
          context_length: selectedProviderModel.context,
          top_provider: {
            context_length: selectedProviderModel.context,
            max_completion_tokens: selectedProviderModel.max_output,
            is_moderated: selectedProviderModel.moderated,
          },
        } as Models_Response_Type,
      ];
    });
  },
});

/** List global models available from at least one enabled provider in this workspace. */
export const availableModels = workspaceQuery({
  args: {},
  async handler(ctx) {
    const [models, providerRecords] = await Promise.all([
      ctx.db.query("models").take(200),
      workspaceProviderRecords(ctx, ctx.workspace),
    ]);
    const configuredProviders = providerRecords.filter(isWorkspaceProviderEnabled);

    const available = models.filter((model) =>
      configuredProviders.some(({ provider }) =>
        provider.models.some((candidate) => candidate.model === model.slug),
      ),
    );

    return Promise.all(
      available.map(async (model) => ({
        ...model,
        author: await ctx.db.get("authors", model.author),
        providers: configuredProviders.flatMap(({ provider }) => {
          const providerModel = provider.models.find((candidate) => candidate.model === model.slug);

          return providerModel
            ? [
                {
                  ...providerModel,
                  id: provider.slug,
                  name: provider.name,
                  logo: provider.catalogue_provider ?? provider.slug,
                },
              ]
            : [];
        }),
      })),
    );
  },
});

/**
 * Whether `model` accepts tool definitions in this workspace, per the provider catalogue's
 * `supported_parameters`. A pinned `provider` checks only that provider; otherwise any enabled
 * provider offering the model counts. Unknown models and providers report `false`.
 */
export const supportsTools = internalQuery({
  args: { workspace: v.id("workspaces"), model: v.string(), provider: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace) return false;

    const providerRecords = await workspaceProviderRecords(ctx, workspace);
    for (const record of providerRecords) {
      if (!isWorkspaceProviderEnabled(record)) continue;
      if (args.provider !== undefined && record.provider.slug !== args.provider) continue;

      const providerModel = record.provider.models.find(
        (candidate) => candidate.model === args.model,
      );
      if (providerModel?.supported_parameters.includes("tools")) return true;
    }
    return false;
  },
});

/** Look up a global model by its canonical slug. */
export const modelInfo = query({
  args: {
    slug: v.string(),
  },
  handler(ctx, args) {
    return ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});
