import { describe, expect, test } from "vitest";
import type { ModelsDevApi } from "../models_dev";
import { matchModelsDev, normalizeAcpUsage, workspaceQuote } from "./agent_usage";
import { estimateCompletionCost } from "./completion";

describe("normalizeAcpUsage", () => {
  test("reads cache tokens apart from input when the total says so (Claude bridge)", () => {
    // claude-agent-acp: totalTokens is the sum of its own disjoint fields.
    const usage = normalizeAcpUsage({
      inputTokens: 2,
      outputTokens: 3,
      cachedReadTokens: 15743,
      cachedWriteTokens: 8193,
      totalTokens: 23941,
    });
    expect(usage.prompt_tokens).toBe(2 + 15743 + 8193);
    expect(usage.completion_tokens).toBe(3);
    expect(usage.prompt_tokens_details).toEqual({
      cached_tokens: 15743,
      written_cache_tokens: 8193,
    });
  });

  test("keeps cached tokens inside input when the total excludes them (OpenAI style)", () => {
    const usage = normalizeAcpUsage({
      inputTokens: 1000,
      outputTokens: 50,
      cachedReadTokens: 800,
      thoughtTokens: 20,
      totalTokens: 1050,
    });
    expect(usage.prompt_tokens).toBe(1000);
    expect(usage.completion_tokens).toBe(50);
  });

  test("adds separately counted thought tokens to the output (Gemini style)", () => {
    const usage = normalizeAcpUsage({
      inputTokens: 100,
      outputTokens: 10,
      thoughtTokens: 40,
      totalTokens: 150,
    });
    expect(usage.completion_tokens).toBe(50);
    expect(usage.completion_tokens_details.reasoning_tokens).toBe(40);
  });

  test("never reads more cache than input as included in it", () => {
    const usage = normalizeAcpUsage({
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 500,
      totalTokens: 15,
    });
    expect(usage.prompt_tokens).toBe(510);
  });
});

const sonnet = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  release_date: "2025-09-29",
  cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
};
const api = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-4-5": sonnet,
      "claude-sonnet-4": {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        cost: { input: 3, output: 15 },
      },
      "claude-opus-4-1": {
        id: "claude-opus-4-1",
        name: "Claude Opus 4.1",
        cost: { input: 15, output: 75 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5-codex": { id: "gpt-5-codex", name: "GPT-5-Codex", cost: { input: 1.25, output: 10 } },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "anthropic/claude-sonnet-4.5": {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        cost: { input: 3.3, output: 16.5 },
      },
    },
  },
} satisfies ModelsDevApi;

describe("matchModelsDev", () => {
  test("uses an exact provider/model route, keeping the routed provider's rates", () => {
    const match = matchModelsDev(
      api,
      { id: "openrouter/anthropic/claude-sonnet-4.5", name: "openrouter/Claude Sonnet 4.5" },
      "opencode",
    );
    expect(match).toMatchObject({ provider: "openrouter", slug: "anthropic/claude-sonnet-4.5" });
    expect(match?.pricing.input).toBe("0.0000033");
  });

  test("matches an alias by the versioned name in its description", () => {
    const match = matchModelsDev(
      api,
      {
        id: "default",
        name: "Default (recommended)",
        description: "Use the default model (currently Sonnet 4.5)",
      },
      "claude-agent",
    );
    expect(match).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  test("matches harness ids that append an effort to the model id", () => {
    expect(
      matchModelsDev(api, { id: "gpt-5-codex/high", name: "gpt-5-codex (high)" }, "codex"),
    ).toMatchObject({ provider: "openai", modelId: "gpt-5-codex" });
  });

  test("leaves a versionless alias unmatched instead of guessing", () => {
    expect(matchModelsDev(api, { id: "opus", name: "Opus" }, "claude-agent")).toBeNull();
  });

  test("needs the whole version: Sonnet 4.6 is not Sonnet 4", () => {
    expect(
      matchModelsDev(api, { id: "sonnet-latest", name: "Claude Sonnet 4.6" }, "claude-agent"),
    ).toBeNull();
    expect(
      matchModelsDev(api, { id: "sonnet-old", name: "Claude Sonnet 4 (thinking)" }, "claude-agent"),
    ).toMatchObject({ modelId: "claude-sonnet-4" });
  });
});

describe("workspaceQuote", () => {
  const pricing = { input: "0.000003", output: "0.000015" };

  test("prefers the provider the agent routes through, by upstream id", () => {
    const quote = workspaceQuote(
      [
        { slug: "anthropic", models: [{ model: "anthropic/claude-sonnet-4-5", pricing }] },
        {
          slug: "openrouter",
          models: [
            {
              model: "anthropic/claude-sonnet-4.5",
              upstream_model_id: "anthropic/claude-sonnet-4.5",
              pricing: { input: "0.0000033", output: "0.0000165" },
            },
          ],
        },
      ],
      { id: "openrouter/anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      "opencode",
    );
    expect(quote?.provider).toBe("openrouter");
  });

  test("prices an unrouted model through any provider offering the same Radium model", () => {
    const quote = workspaceQuote(
      [{ slug: "anthropic", models: [{ model: "anthropic/claude-sonnet-4-5", pricing }] }],
      { id: "claude-agent/claude-sonnet-4.5", name: "Sonnet 4.5" },
      "opencode",
    );
    expect(quote).toMatchObject({ provider: "anthropic", slug: "anthropic/claude-sonnet-4-5" });
    expect(
      estimateCompletionCost(
        normalizeAcpUsage({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }),
        quote!.pricing,
      ).estimatedCost,
    ).toBeCloseTo(3);
  });
});
