import { describe, expect, test } from "bun:test";

import { inferModelAuthor } from "./model-author";

describe("inferModelAuthor", () => {
  test("uses the model id rather than an OpenCode routing prefix", () => {
    expect(
      inferModelAuthor("claude-agent/claude-haiku-4-5-20251001", "claude-agent/Haiku 4.5"),
    ).toEqual({ slug: "anthropic", name: "Anthropic" });
    expect(
      inferModelAuthor("openrouter/google/gemini-2.5-pro", "openrouter/Gemini 2.5 Pro"),
    ).toEqual({ slug: "google", name: "Google" });
  });

  test("recognizes dated Claude ids and names", () => {
    expect(inferModelAuthor("claude-sonnet-4-20250514", "Claude Sonnet 4")).toEqual({
      slug: "anthropic",
      name: "Anthropic",
    });
  });

  test("falls back to a lab-named routing prefix only for aliases", () => {
    expect(inferModelAuthor("claude-agent/haiku", "claude-agent/Haiku 5.5")).toEqual({
      slug: "anthropic",
      name: "Anthropic",
    });
    expect(
      inferModelAuthor("openrouter/particle-ai/particle-1", "openrouter/Particle 1"),
    ).toBeNull();
  });
});
