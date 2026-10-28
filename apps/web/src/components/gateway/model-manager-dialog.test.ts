import { expect, test } from "bun:test";
import { initialTierRates, tierPricing } from "./model-manager-dialog";

test("legacy and unpriced default tiers show the base rates without rounding", () => {
  const base = {
    input: "0.000000000123456789",
    output: "0.000004567891234",
    cache_read: "0",
    tiers: [{ context: 200000, input: "0.00001", output: "0.00002" }],
  };
  for (const tiers of [[], [{ id: "default" }]]) {
    const rates = initialTierRates(tiers, base);
    expect(rates[0].enabled).toBe(true);
    expect(rates[0].input).toBe("0.000123456789");
    expect(tierPricing(rates)[0].pricing).toEqual(base);
  }
});

test("unknown base prices remain unknown and zero prices stay zero", () => {
  const unknown = initialTierRates([], { input: "", output: "" });
  expect(unknown[0].enabled).toBe(true);
  expect(unknown[0].input).toBe("");
  expect(tierPricing(unknown)[0].pricing).toBeUndefined();
  expect(tierPricing(initialTierRates([], { input: "0", output: "0" }))[0].pricing).toEqual({
    input: "0",
    output: "0",
  });
});
