import { afterEach, expect, test, vi } from "vitest";
import { fetchOpenRouterServiceTiers, mapModelsDevModel, type ModelsDevModel } from "./models_dev";

afterEach(() => vi.unstubAllGlobals());

test("endpoint import retains capabilities but omits conflicting tier prices", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: {
          endpoints: [
            {
              service_tier: "priority",
              pricing: { prompt: "1", completion: "2", input_cache_read: "0.1" },
            },
            { service_tier: "priority", pricing: { prompt: "3", completion: "2" } },
            { service_tier: "flex", pricing: { prompt: "0", completion: "0" } },
          ],
        },
      }),
    ),
  );
  expect(await fetchOpenRouterServiceTiers("openai/example")).toEqual([
    { id: "priority", source: "openrouter-endpoints" },
    { id: "flex", source: "openrouter-endpoints", pricing: { input: "0", output: "0" } },
  ]);
});

const experimentalModel: ModelsDevModel = {
  id: "example",
  name: "Example",
  experimental: {
    modes: {
      fast: {
        cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
        provider: { body: { service_tier: "priority" } },
      },
      pro: { provider: { body: { reasoning: { mode: "pro" } } } },
    },
  },
  cost: {
    input: 1,
    output: 5,
    cache_read: 0.05,
    cache_write: 1.25,
    tiers: [
      {
        input: 2,
        output: 7.5,
        cache_read: 0.1,
        cache_write: 2.5,
        tier: { type: "context", size: 272000 },
      },
    ],
    context_over_200k: { input: 2, output: 7.5 },
  },
};

test("imports experimental service and reasoning modes without inventing a pro service tier", () => {
  const { provider } = mapModelsDevModel("openai", experimentalModel);
  expect(provider.service_tiers?.map((tier) => tier.id)).toEqual(["default", "priority"]);
  expect(provider.service_tiers?.find((tier) => tier.id === "default")?.pricing?.input).toBe(
    "0.000001",
  );
  expect(provider.service_tiers?.find((tier) => tier.id === "priority")?.pricing?.input).toBe(
    "0.000002",
  );
  expect(provider.inference_modes?.find((mode) => mode.id === "pro")?.provider_body).toEqual({
    reasoning: { mode: "pro" },
  });
  expect(provider.inference_modes?.find((mode) => mode.id === "pro")?.pricing).toBeUndefined();
  expect(provider.pricing.tiers?.map((tier) => tier.context)).toEqual([272000]);
});

test("small positive prices stay positive rather than rounding to free", () => {
  const { provider } = mapModelsDevModel("example", {
    id: "tiny",
    name: "Tiny",
    cost: { input: 0.0000001, output: 0 },
  });
  expect(provider.pricing.input).toBe("0.0000000000001");
  expect(Number(provider.pricing.input)).toBeGreaterThan(0);
  expect(provider.pricing.output).toBe("0");
});

test("unsupported mode body overrides are not advertised as executable modes", () => {
  const { provider } = mapModelsDevModel("example", {
    ...experimentalModel,
    experimental: {
      modes: {
        unsupported: { provider: { body: { service_tier: "priority", unknown_setting: true } } },
      },
    },
  });
  expect(provider.inference_modes).toBeUndefined();
  expect(provider.service_tiers?.map((tier) => tier.id)).toEqual(["default"]);
});
