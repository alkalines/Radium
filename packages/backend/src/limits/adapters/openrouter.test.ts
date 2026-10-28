import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../convex/auth", () => ({ authComponent: {} }));

import type { ActionCtx } from "../../../convex/_generated/server";
import { limitAdapter } from ".";
import {
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  openRouterKeySchema,
  openRouterLimitAdapter,
  parseOpenRouterError,
  parseOpenRouterKey,
} from "./openrouter";

// Tuesday 2026-10-27 15:00 UTC.
const NOW = Date.UTC(2026, 9, 27, 15);

/** `GET /api/v1/key` of a capped key with a monthly reset, a budget, and free-model requests. */
const keyPayload = {
  data: {
    label: "sk-or-v1-abc…xyz",
    limit: 30,
    limit_remaining: 4.5,
    limit_reset: "monthly",
    include_byok_in_limit: false,
    usage: 120.25,
    usage_daily: 1.5,
    usage_weekly: 9,
    usage_monthly: 25.5,
    byok_usage: 0,
    byok_usage_daily: 0,
    byok_usage_weekly: 0,
    byok_usage_monthly: 0,
    is_free_tier: false,
    rate_limit: { requests: -1, interval: "10s" },
    free_model_daily_requests: { used: 12, limit: 1000, remaining: 988 },
    budgets: [
      {
        scope: "guardrail",
        limit_usd: 10,
        spend_usd: 9.6,
        remaining_usd: 0.4,
        reset_interval: "weekly",
        resets_at: "2026-11-02T00:00:00Z",
      },
    ],
    effective_budget: {
      scope: "guardrail",
      limit_usd: 10,
      spend_usd: 9.6,
      remaining_usd: 0.4,
      reset_interval: "weekly",
      resets_at: "2026-11-02T00:00:00Z",
    },
    expires_at: null,
  },
};

describe("OpenRouter /key", () => {
  test("key limit with its UTC period, budgets, and free-model requests", () => {
    const result = parseOpenRouterKey(openRouterKeySchema.parse(keyPayload), NOW);
    expect(result.expired).toBeUndefined();
    expect(result.meters).toEqual([
      expect.objectContaining({
        id: "openrouter:key",
        label: "Key limit",
        unit: "usd",
        limit: 30,
        used: 25.5,
        remaining: 4.5,
        resetsAt: Date.UTC(2026, 10, 1),
        windowSeconds: 31 * 86400,
        source: "poll",
      }),
      expect.objectContaining({
        id: "openrouter:budget:guardrail",
        limit: 10,
        used: 9.6,
        remaining: 0.4,
        resetsAt: Date.UTC(2026, 10, 2),
        windowSeconds: 7 * 86400,
      }),
      expect.objectContaining({
        id: "openrouter:free-requests",
        unit: "requests",
        limit: 1000,
        used: 12,
        resetsAt: Date.UTC(2026, 9, 28),
      }),
    ]);
  });

  test("uncapped keys have no key meter; expired keys are flagged", () => {
    const result = parseOpenRouterKey(
      openRouterKeySchema.parse({
        data: {
          limit: null,
          limit_remaining: null,
          usage: 3,
          is_free_tier: true,
          expires_at: "2026-10-01T00:00:00Z",
        },
      }),
      NOW,
    );
    expect(result).toEqual({ meters: [], plan: "Free tier", expired: true });
  });
});

describe("OpenRouter 402/403 bodies", () => {
  test("limit_source names the exhausted meter", () => {
    const body = (metadata: object) =>
      JSON.stringify({ error: { code: 402, message: "Key limit exceeded", metadata } });
    expect(
      parseOpenRouterError(402, body({ limit_source: "openrouter_key_limit" }), NOW)?.meters,
    ).toEqual([expect.objectContaining({ id: "openrouter:key", remaining: 0, source: "error" })]);
    expect(
      parseOpenRouterError(402, body({ limit_source: "openrouter_credits" }), NOW)?.meters,
    ).toEqual([
      expect.objectContaining({ id: "openrouter:credits", scope: "account", remaining: 0 }),
    ]);
  });

  test("403 budget bodies carry the budget and its reset", () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "Budget exceeded",
        metadata: { limit_usd: 10, spend_usd: 10.02, resets_at: "2026-11-02T00:00:00Z" },
      },
    });
    expect(parseOpenRouterError(403, body, NOW)?.meters).toEqual([
      expect.objectContaining({
        id: "openrouter:budget:effective",
        limit: 10,
        used: 10.02,
        remaining: 0,
        resetsAt: Date.UTC(2026, 10, 2),
        source: "error",
      }),
    ]);
  });

  test("other failures are ignored", () => {
    expect(parseOpenRouterError(429, "{}", NOW)).toBeUndefined();
    expect(
      parseOpenRouterError(403, JSON.stringify({ error: { message: "Forbidden" } }), NOW),
    ).toBeUndefined();
  });
});

describe("OpenRouter poll()", () => {
  const fetchMock = vi.fn();
  const ctx = {} as ActionCtx;
  const target = { env: ["OPENROUTER_API_KEY"], values: { OPENROUTER_API_KEY: "sk-or-inference" } };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("reads /key with the inference key and /credits with the management key", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === OPENROUTER_KEY_URL
        ? Response.json(keyPayload)
        : Response.json({ data: { total_credits: 50, total_usage: 48.1 } }),
    );

    const result = await openRouterLimitAdapter.poll!(
      ctx,
      { ...target, limitKey: "sk-or-management" },
      NOW,
    );

    expect(fetchMock).toHaveBeenCalledWith(OPENROUTER_KEY_URL, {
      headers: expect.objectContaining({ Authorization: "Bearer sk-or-inference" }),
    });
    expect(fetchMock).toHaveBeenCalledWith(OPENROUTER_CREDITS_URL, {
      headers: expect.objectContaining({ Authorization: "Bearer sk-or-management" }),
    });
    const credits = result.meters.find((meter) => meter.id === "openrouter:credits");
    expect(credits).toMatchObject({ scope: "account", unit: "usd", used: 48.1 });
    expect(credits?.remaining).toBeCloseTo(1.9);
    expect(result.partialError).toBeUndefined();
  });

  test("a rejected management key keeps the last balance and reports a partial error", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === OPENROUTER_KEY_URL
        ? Response.json(keyPayload)
        : Response.json({ error: { code: 403, message: "Forbidden" } }, { status: 403 }),
    );
    const result = await openRouterLimitAdapter.poll!(ctx, { ...target, limitKey: "bad" }, NOW);
    expect(result.retain).toEqual(["openrouter:credits"]);
    expect(result.partialError).toMatchObject({ status: 403 });
    expect(result.meters.some((meter) => meter.id === "openrouter:key")).toBe(true);
  });

  test("without a management key only /key is read; /key failures fail the poll", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(keyPayload));
    await openRouterLimitAdapter.poll!(ctx, target, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await expect(openRouterLimitAdapter.poll!(ctx, target, NOW)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("adapter resolution", () => {
  test("by OAuth flow, OpenRouter package, or openrouter.ai base URL", () => {
    expect(
      limitAdapter({ npm: "@opencoredev/loginwithchatgpt-ai", oauth_flow: "chatgpt-device" })?.id,
    ).toBe("chatgpt-device");
    expect(limitAdapter({ npm: "@openrouter/ai-sdk-provider" })?.id).toBe("openrouter");
    expect(
      limitAdapter({ npm: "@ai-sdk/openai-compatible", api: "https://openrouter.ai/api/v1" })?.id,
    ).toBe("openrouter");
    expect(
      limitAdapter({ npm: "@ai-sdk/openai", api: "https://api.openai.com/v1" }),
    ).toBeUndefined();
    expect(
      limitAdapter({ npm: "@ai-sdk/openai-compatible", oauth_flow: "unknown" }),
    ).toBeUndefined();
  });
});
