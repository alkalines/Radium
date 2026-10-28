import { describe, expect, test } from "bun:test";
import {
  inferenceModeTier,
  reasoningModesFor,
  validInferenceMode,
  validServiceTier,
  type ModelOption,
} from "./model-options";

describe("provider-model service tiers", () => {
  const model: ModelOption = {
    slug: "test/model",
    name: "Model",
    author: null,
    providers: [
      { id: "a", name: "A", logo: "a", service_tiers: [{ id: "flex" }, { id: "priority" }] },
      { id: "b", name: "B", logo: "b", service_tiers: [{ id: "flex" }] },
    ],
  };

  test("keeps only tiers advertised by the selected provider", () => {
    expect(validServiceTier(model, "a", "priority")).toBe("priority");
    expect(validServiceTier(model, "b", "priority")).toBeUndefined();
    expect(validServiceTier(model, "missing", "flex")).toBeUndefined();
    expect(validServiceTier(model, "a", "auto")).toBeUndefined();
    expect(validServiceTier(model, "a", "default")).toBe("default");
    expect(validServiceTier(model, "missing", "default")).toBeUndefined();
  });
});

test("inference modes are scoped to the selected provider", () => {
  const model: ModelOption = {
    slug: "test/model",
    name: "Model",
    author: null,
    providers: [
      {
        id: "a",
        name: "A",
        logo: "a",
        inference_modes: [{ id: "pro", provider_body: { reasoning: { mode: "pro" } } }],
      },
      { id: "b", name: "B", logo: "b" },
    ],
  };
  expect(validInferenceMode(model, "a", "pro")).toBe("pro");
  expect(validInferenceMode(model, "b", "pro")).toBeUndefined();
});

test("native speed modes imply the corresponding service tier", () => {
  expect(inferenceModeTier({ id: "fast", provider_body: { speed: "fast" } })).toBe("priority");
  expect(inferenceModeTier({ id: "standard", provider_body: { speed: "standard" } })).toBe(
    "default",
  );
  expect(
    inferenceModeTier({ id: "pro", provider_body: { reasoning: { mode: "pro" } } }),
  ).toBeUndefined();
});

test("reasoning mode selection excludes fast and ultrafast service controls", () => {
  const modes = [
    { id: "fast", provider_body: { service_tier: "priority" } },
    { id: "ultrafast", provider_body: { service_tier: "ultrafast" } },
    { id: "native-fast", provider_body: { speed: "fast" as const } },
    { id: "pro", provider_body: { reasoning: { mode: "pro" as const } } },
  ];
  const model: ModelOption = {
    slug: "test/model",
    name: "Model",
    author: null,
    providers: [{ id: "a", name: "A", logo: "a", inference_modes: modes }],
  };
  expect(reasoningModesFor(modes).map((mode) => mode.id)).toEqual(["pro"]);
  expect(validInferenceMode(model, "a", "fast")).toBeUndefined();
  expect(validInferenceMode(model, "a", "ultrafast")).toBeUndefined();
  expect(validInferenceMode(model, "a", "native-fast")).toBeUndefined();
  expect(validInferenceMode(model, "a", "pro")).toBe("pro");
});
