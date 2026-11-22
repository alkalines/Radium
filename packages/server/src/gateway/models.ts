import { inArray, eq } from "drizzle-orm";
import type { Database } from "../drivers/types";
import type { Models_Response_Type } from "./openai/models";
import { isWorkspaceProviderEnabled, workspaceProviderRecords } from "./providers";
import { authors, models } from "./schema";

/** The enabled providers of a workspace and the global model rows they offer. */
async function offeredModels(db: Database, workspace: string) {
  const enabled = (await workspaceProviderRecords(db, workspace)).filter(isWorkspaceProviderEnabled);
  const slugs = [
    ...new Set(enabled.flatMap((record) => record.provider.models.map((model) => model.model))),
  ];
  const rows =
    slugs.length === 0
      ? []
      : await db
          .select({ model: models, author: authors })
          .from(models)
          .leftJoin(authors, eq(authors.id, models.author))
          .where(inArray(models.slug, slugs))
          .orderBy(models.createdAt, models.id);
  return { enabled, rows };
}

/**
 * Global models available from at least one enabled provider of the workspace, each with its
 * author and every enabled provider's offer (members may read it: they use configured models).
 * Field names follow the Convex documents the model pickers were built on; `createdAt` and
 * `launch_date` are ms epochs.
 */
export async function availableModels(db: Database, workspace: string) {
  const { enabled, rows } = await offeredModels(db, workspace);
  return rows.map(({ model, author }) => ({
    id: model.id,
    createdAt: model.createdAt.getTime(),
    name: model.name,
    slug: model.slug,
    launch_date: model.launchDate.getTime(),
    type: model.type,
    description: model.description,
    warning: model.warning,
    model_weights: model.modelWeights,
    reasoning: model.reasoning,
    features: {
      reasoning_minimal: model.featuresReasoningMinimal ?? undefined,
      reasoning_none: model.featuresReasoningNone ?? undefined,
      reasoning_budget: model.featuresReasoningBudget ?? undefined,
      reasoning_efforts: model.featuresReasoningEfforts ?? undefined,
    },
    architecture: model.architecture,
    default_parameters: {
      temperature: model.defaultTemperature ?? undefined,
      top_p: model.defaultTopP ?? undefined,
      frequency_penalty: model.defaultFrequencyPenalty ?? undefined,
    },
    author: author ? { id: author.id, name: author.name, slug: author.slug } : null,
    providers: enabled.flatMap(({ provider }) => {
      const offer = provider.models.find((candidate) => candidate.model === model.slug);
      return offer
        ? [
            {
              ...offer,
              id: provider.slug,
              name: provider.name,
              logo: provider.catalogue_provider ?? provider.slug,
            },
          ]
        : [];
    }),
  }));
}

/**
 * The OpenAI-compatible model listing (`GET /api/openai/v1/models`) of a workspace: one entry
 * per global model offered by an enabled provider, described by the first offering provider in
 * configuration order.
 */
export async function openaiModels(db: Database, workspace: string): Promise<Models_Response_Type[]> {
  const { enabled, rows } = await offeredModels(db, workspace);
  return rows.flatMap(({ model }) => {
    const offer = enabled
      .flatMap(({ provider }) => provider.models)
      .find((candidate) => candidate.model === model.slug);
    if (!offer) return [];
    return [
      {
        id: model.slug,
        canonical_slug: model.slug,
        created: Math.floor(model.createdAt.getTime() / 1000),
        object: "model",
        description: model.description,
        name: model.name,
        hugging_face_id: model.modelWeights?.split("https://huggingface.co/")[1],
        architecture: {
          modality: `${model.architecture.input_modalities.join("+")}->${model.architecture.output_modalities.join("+")}`,
          input_modalities: model.architecture.input_modalities,
          output_modalities: model.architecture.output_modalities,
          tokenizer: model.architecture.tokenizer,
          instruct_type: null,
        },
        default_parameters: {
          frequency_penalty: model.defaultFrequencyPenalty ?? undefined,
          temperature: model.defaultTemperature ?? undefined,
          top_p: model.defaultTopP ?? undefined,
        },
        per_request_limits: { completion_tokens: null, prompt_tokens: null },
        supported_parameters: offer.supported_parameters,
        pricing: {
          prompt: offer.pricing.input,
          completion: offer.pricing.output,
          input_cache_read: offer.pricing.cache_read,
          input_cache_write: offer.pricing.cache_write,
        },
        context_length: offer.context,
        top_provider: {
          context_length: offer.context,
          max_completion_tokens: offer.max_output,
          is_moderated: offer.moderated,
        },
      } as Models_Response_Type,
    ];
  });
}

/**
 * Whether `model` accepts tool definitions in this workspace, per the provider's
 * `supported_parameters`. A pinned `provider` checks only that provider; otherwise any enabled
 * provider offering the model counts. Unknown models and providers report `false`. Used by
 * Chatroom when it builds a run's tools.
 */
export async function modelSupportsTools(
  db: Database,
  workspace: string,
  model: string,
  provider?: string,
) {
  for (const record of await workspaceProviderRecords(db, workspace)) {
    if (!isWorkspaceProviderEnabled(record)) continue;
    if (provider !== undefined && record.provider.slug !== provider) continue;
    const offer = record.provider.models.find((candidate) => candidate.model === model);
    if (offer?.supported_parameters.includes("tools")) return true;
  }
  return false;
}
