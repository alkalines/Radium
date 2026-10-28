import { describe, expect, test } from "vitest";
import { estimateCompletionCost, servedTierQuote } from "./completion";

const usage = {
  prompt_tokens: 100,
  completion_tokens: 10,
  completion_tokens_details: {},
  prompt_tokens_details: { cached_tokens: 30, written_cache_tokens: 20 },
};

describe("completion quote", () => {
  test("prices uncached input, cache reads, cache writes and output once each", () => {
    expect(
      estimateCompletionCost(usage, {
        input: "1",
        output: "2",
        cache_read: "0.1",
        cache_write: "0.5",
      }),
    ).toEqual({
      prompt: 50,
      output: 20,
      cacheRead: 3,
      cacheWrite: 10,
      cacheWrite1h: 0,
      estimatedCost: 83,
    });
  });

  test("unknown cache rate is not free, while a quoted zero is free", () => {
    expect(
      estimateCompletionCost(usage, { input: "1", output: "2", cache_read: "0" }).estimatedCost,
    ).toBeUndefined();
    expect(
      estimateCompletionCost(usage, { input: "1", output: "2", cache_read: "0", cache_write: "0" })
        .estimatedCost,
    ).toBe(70);
    expect(estimateCompletionCost(usage, undefined).estimatedCost).toBeUndefined();
  });

  test("inconsistent inclusive input buckets cannot produce an estimate", () => {
    expect(
      estimateCompletionCost(
        { ...usage, prompt_tokens: 40 },
        { input: "1", output: "2", cache_read: "1", cache_write: "1" },
      ).estimatedCost,
    ).toBeUndefined();
  });

  test("prices 5m and 1h cache writes separately and leaves unknown schedules unpriced", () => {
    const split = {
      ...usage,
      prompt_tokens_details: {
        cached_tokens: 30,
        written_cache_tokens: 20,
        written_cache_tokens_1h: 8,
      },
    };
    const quote = {
      input: "1",
      output: "2",
      cache_read: "0.1",
      cache_write: "0.5",
      cache_write_1h: "2",
    };
    expect(estimateCompletionCost(split, quote).estimatedCost).toBe(95);
    expect(
      estimateCompletionCost(split, { ...quote, cache_write_1h: undefined }).estimatedCost,
    ).toBeUndefined();
    expect(estimateCompletionCost(usage, quote, true).estimatedCost).toBeUndefined();
  });

  test("reported fallback tier uses the dispatch-time fallback quote", () => {
    const basic = { input: "1", output: "2" };
    const priority = { input: "3", output: "4" };
    expect(
      servedTierQuote("priority", "default", priority, [{ id: "default", pricing: basic }]),
    ).toEqual(basic);
    expect(servedTierQuote("priority", "flex", priority, [])).toBeUndefined();
  });
});

test("context pricing starts above the exact threshold and uses inclusive cached input", () => {
  const quote = {
    input: "1",
    output: "5",
    cache_read: "0.05",
    cache_write: "1.25",
    tiers: [{ context: 100, input: "2", output: "7.5", cache_read: "0.1", cache_write: "2.5" }],
  };
  expect(estimateCompletionCost(usage, quote).estimatedCost).toBe(126.5);
  const above = { ...usage, prompt_tokens: 101 };
  expect(estimateCompletionCost(above, quote).estimatedCost).toBe(230);
  expect(estimateCompletionCost({ ...above, prompt_tokens_details: {} }, quote).estimatedCost).toBe(
    277,
  );
});
