import { Models_Response_Type } from "@/utils/types/openai/models";
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { isWorkspaceProviderEnabled, workspaceProviderRecords } from "./provider_records";
import { requireWorkspaceAccess } from "./workspaces";

export const openaiModels = internalQuery({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<Models_Response_Type[]> => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || workspace.archivedAt !== undefined) throw new Error("Workspace not found.");
    const [modelsList, providerRecords] = await Promise.all([
      ctx.db.query("models").take(200),
      workspaceProviderRecords(ctx, workspace),
    ]);
    const configuredProviders = providerRecords.filter(isWorkspaceProviderEnabled);

    return modelsList.flatMap((m) => {
      // @todo: Get more consistent statics
      const modelProviders = configuredProviders.flatMap(({ provider }) =>
        provider.models.filter((providerModel) => providerModel.model === m.slug),
      );
      const baseProvider = modelProviders[0];
      const topProvider = modelProviders[0];
      if (!baseProvider) return [];

      return [
        {
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
          supported_parameters: baseProvider?.supported_parameters,
          pricing: baseProvider
            ? {
                prompt: baseProvider.pricing.input,
                completion: baseProvider.pricing.output,
                input_cache_read: baseProvider.pricing.cache_read,
                input_cache_write: baseProvider.pricing.cache_write,
                // @todo
              }
            : null,
          context_length: baseProvider?.context,
          top_provider: topProvider
            ? {
                context_length: topProvider.context,
                max_completion_tokens: topProvider.max_output,
                is_moderated: topProvider.moderated,
              }
            : null,
        } as Models_Response_Type,
      ];
    });
  },
});

export const availableModels = query({
  args: { workspace: v.id("workspaces") },
  async handler(ctx, args) {
    const workspace = await requireWorkspaceAccess(ctx, args.workspace);
    const [models, providerRecords] = await Promise.all([
      ctx.db.query("models").take(200),
      workspaceProviderRecords(ctx, workspace),
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
