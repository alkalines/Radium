import type { FunctionReturnType } from "convex/server";

import type { api } from "backend/convex/_generated/api";

/**
 * A model the current workspace can route, as returned by `api.models.availableModels`: the
 * global catalogue entry plus every enabled workspace provider that serves it (first = default).
 */
export type AvailableModel = FunctionReturnType<typeof api.models.availableModels>[number];

/** One upstream that can serve a model; `logo` is a models.dev provider slug. */
export type ModelProviderOption = {
  id: string;
  name: string;
  logo: string;
  service_tiers?: Array<{
    id: string;
    pricing?: {
      input: string;
      output: string;
      cache_read?: string;
      cache_write?: string;
      cache_write_1h?: string;
    };
  }>;
  inference_modes?: Array<{
    id: string;
    source?: string;
    provider_body: {
      service_tier?: string;
      speed?: "fast" | "standard";
      reasoning?: { mode: "standard" | "pro" };
    };
  }>;
};

/** The service tier implied by a mode, including native provider speed controls. */
export function inferenceModeTier(
  mode: NonNullable<ModelProviderOption["inference_modes"]>[number] | undefined,
) {
  if (mode?.provider_body.service_tier) return mode.provider_body.service_tier;
  if (mode?.provider_body.speed === "fast") return "priority";
  if (mode?.provider_body.speed === "standard") return "default";
  return undefined;
}

/** Returns the selected tier only when this provider-model advertises it. */
export function validServiceTier(
  model: ModelOption | undefined,
  providerId: string | undefined,
  tier: string | undefined,
) {
  if (!tier || tier === "auto") return undefined;
  const provider = model?.providers?.find((candidate) => candidate.id === providerId);
  return provider &&
    (tier === "default" || provider.service_tiers?.some((candidate) => candidate.id === tier))
    ? tier
    : undefined;
}

/** Only Pro reasoning is an inference-mode choice; speed controls belong to service tiers. */
export function reasoningModesFor(modes: ModelProviderOption["inference_modes"]) {
  const pro = modes?.find(
    (mode) =>
      mode.provider_body.reasoning?.mode === "pro" &&
      !mode.provider_body.service_tier &&
      !mode.provider_body.speed,
  );
  return pro ? [pro] : [];
}

/** Retains an inference mode only for the provider-model that advertises it. */
export function validInferenceMode(
  model: ModelOption | undefined,
  providerId: string | undefined,
  mode: string | undefined,
) {
  if (!mode) return undefined;
  const provider = model?.providers?.find((candidate) => candidate.id === providerId);
  return reasoningModesFor(provider?.inference_modes).some((candidate) => candidate.id === mode)
    ? mode
    : undefined;
}

/**
 * The minimum a model picker needs. `AvailableModel` satisfies it; lists that only know a slug and
 * name (fork targets, saved defaults) can pass narrower objects.
 */
export type ModelOption = {
  slug: string;
  name: string;
  author: { name: string; slug: string } | null;
  providers?: ModelProviderOption[];
};

/** Reasoning capabilities read from a catalogue entry; absent fields mean "not advertised". */
export type ReasoningCapableModel = {
  reasoning?: boolean;
  features?: {
    reasoning_budget?: boolean;
    reasoning_efforts?: string[];
    reasoning_minimal?: boolean;
    reasoning_none?: boolean;
  };
};

/** `Lab: Model` when the lab is known, so models with the same name stay distinguishable. */
export function modelDisplayName(model: ModelOption) {
  return model.author ? `${model.author.name}: ${model.name}` : model.name;
}

/**
 * Reasoning levels in the provider's vocabulary, or an empty list when the model cannot reason.
 * Catalogue entries that list explicit efforts win; otherwise the common ladder is offered, minus
 * `none`/`minimal` when the catalogue says the model lacks them.
 */
export function reasoningEffortsFor(model: ReasoningCapableModel | undefined) {
  if (!model?.reasoning) return [];

  if (model.features?.reasoning_efforts?.length) {
    return model.features.reasoning_efforts;
  }

  return [
    ...(model.features?.reasoning_none === false ? [] : ["none"]),
    ...(model.features?.reasoning_minimal ? ["minimal"] : []),
    "low",
    "medium",
    "high",
  ];
}

/** Human label for a reasoning level; `none` reads as `Off`. */
export function effortLabel(effort: string) {
  if (effort === "none") return "Off";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
