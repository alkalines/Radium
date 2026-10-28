import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatGPTHandler: vi.fn(),
  getTokens: vi.fn(),
}));

vi.mock("@opencoredev/loginwithchatgpt-server", () => ({
  createChatGPTHandler: mocks.createChatGPTHandler,
}));

vi.mock("../../../convex/auth", () => ({ authComponent: {} }));

import type { ActionCtx } from "../../../convex/_generated/server";
import { LimitPollError } from "../adapter";
import { createLimitCapture } from "../capture";
import {
  CHATGPT_USAGE_URL,
  chatGPTLimitAdapter,
  codexUsageSchema,
  parseCodexError,
  parseCodexHeaders,
  parseCodexUsage,
} from "./chatgpt";

const NOW = 1_793_000_000_000;
const RESET_AT = 1_793_019_600;

/** Headers as sent by chatgpt.com/backend-api/codex/responses. */
const codexHeaders = new Headers({
  "content-type": "text/event-stream",
  "x-codex-primary-used-percent": "23",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": String(RESET_AT),
  "x-codex-secondary-used-percent": "61",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-after-seconds": "259200",
  "x-codex-credits-has-credits": "True",
  "x-codex-credits-unlimited": "False",
  "x-codex-credits-balance": "12.5",
  "x-codex-plan-type": "plus",
  "x-codex-active-limit": "codex",
  "x-codex-mini-primary-used-percent": "4",
  "x-codex-mini-primary-window-minutes": "300",
  "x-codex-mini-primary-reset-at": String(RESET_AT),
  "x-codex-mini-limit-name": "GPT-5-Codex-Mini",
});

const usageLimitBody = JSON.stringify({
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    plan_type: "plus",
    resets_at: RESET_AT,
    resets_in_seconds: 19600,
  },
});

/** `wham/usage` payload of a Pro account. */
const usagePayload = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18000,
      reset_after_seconds: 3600,
      reset_at: RESET_AT,
    },
    secondary_window: {
      used_percent: 40,
      limit_window_seconds: 604800,
      reset_after_seconds: 200000,
      reset_at: 1_793_200_000,
    },
  },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  additional_rate_limits: [
    {
      limit_name: "GPT-5-Codex-Mini",
      metered_feature: "codex_mini",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 3,
          limit_window_seconds: 18000,
          reset_after_seconds: 100,
          reset_at: RESET_AT,
        },
        secondary_window: null,
      },
    },
  ],
  rate_limit_reached_type: null,
};

describe("Codex response headers", () => {
  test("windows labelled by length, both reset forms, credits, plan, and extra limits", () => {
    const observation = parseCodexHeaders(codexHeaders, NOW);
    expect(observation?.plan).toBe("plus");
    expect(observation?.meters).toEqual([
      expect.objectContaining({
        id: "codex:primary",
        label: "5-hour",
        unit: "percent",
        used: 23,
        windowSeconds: 18000,
        resetsAt: RESET_AT * 1000,
        source: "header",
      }),
      expect.objectContaining({
        id: "codex:secondary",
        label: "Weekly",
        used: 61,
        windowSeconds: 604800,
        resetsAt: NOW + 259200 * 1000,
      }),
      expect.objectContaining({
        id: "codex:codex_mini:primary",
        label: "GPT-5-Codex-Mini 5-hour",
        used: 4,
      }),
      expect.objectContaining({ id: "codex:credits", unit: "credits", remaining: 12.5 }),
    ]);
  });

  test("responses without Codex headers yield nothing", () => {
    expect(parseCodexHeaders(new Headers({ "content-type": "application/json" }), NOW)).toBe(
      undefined,
    );
  });

  test("free plans report a 30-day window", () => {
    const observation = parseCodexHeaders(
      new Headers({
        "x-codex-primary-used-percent": "70",
        "x-codex-primary-window-minutes": String(30 * 24 * 60),
      }),
      NOW,
    );
    expect(observation?.meters[0]).toMatchObject({ label: "30-day", used: 70 });
  });
});

describe("Codex usage_limit_reached bodies", () => {
  test("raw and inside the library's responses_request_failed wrapper", () => {
    const expected = {
      plan: "plus",
      meters: [
        expect.objectContaining({
          id: "codex:usage-limit",
          used: 100,
          resetsAt: RESET_AT * 1000,
          source: "error",
        }),
      ],
    };
    expect(parseCodexError(429, usageLimitBody, NOW)).toEqual(expected);
    const wrapped = JSON.stringify({
      error: "responses_request_failed",
      status: 429,
      detail: usageLimitBody,
    });
    expect(parseCodexError(429, wrapped, NOW)).toEqual(expected);
  });

  test("relative reset and unrelated errors", () => {
    const relative = JSON.stringify({
      error: { type: "usage_limit_reached", resets_in_seconds: 60 },
    });
    expect(parseCodexError(429, relative, NOW)?.meters[0]?.resetsAt).toBe(NOW + 60_000);
    expect(parseCodexError(400, JSON.stringify({ error: { type: "invalid_request" } }), NOW)).toBe(
      undefined,
    );
    expect(parseCodexError(502, "Bad gateway", NOW)).toBe(undefined);
  });
});

describe("Codex usage poll", () => {
  test("payload maps to the header meters plus plan and additional limits", () => {
    const result = parseCodexUsage(codexUsageSchema.parse(usagePayload), NOW);
    expect(result.plan).toBe("pro");
    expect(result.meters).toEqual([
      expect.objectContaining({ id: "codex:primary", label: "5-hour", used: 12, source: "poll" }),
      expect.objectContaining({
        id: "codex:secondary",
        label: "Weekly",
        used: 40,
        resetsAt: 1_793_200_000_000,
      }),
      expect.objectContaining({
        id: "codex:codex_mini:primary",
        label: "GPT-5-Codex-Mini 5-hour",
        used: 3,
      }),
    ]);
  });

  describe("poll()", () => {
    const fetchMock = vi.fn();
    const ctx = { runQuery: vi.fn(), runMutation: vi.fn() } as unknown as ActionCtx;
    const target = { env: [], values: { sessionCookie: "lwc_chatgpt_subscription=s1.sig" } };

    beforeEach(() => {
      vi.stubEnv("LWC_SECRET", "test-secret");
      vi.stubGlobal("fetch", fetchMock);
      mocks.createChatGPTHandler.mockReset();
      mocks.getTokens.mockReset();
      fetchMock.mockReset();
      mocks.createChatGPTHandler.mockReturnValue({ getTokens: mocks.getTokens });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    test("calls wham/usage with the session's token and account", async () => {
      mocks.getTokens.mockResolvedValue({ accessToken: "access", accountId: "account-1" });
      fetchMock.mockResolvedValue(Response.json(usagePayload));

      const result = await chatGPTLimitAdapter.poll!(ctx, target, NOW);

      expect(mocks.createChatGPTHandler).toHaveBeenCalledWith(
        expect.objectContaining({ dangerouslyAllowTokenExport: true }),
      );
      const request: Request = mocks.getTokens.mock.calls[0]![0];
      expect(request.headers.get("cookie")).toBe(target.values.sessionCookie);
      expect(fetchMock).toHaveBeenCalledWith(CHATGPT_USAGE_URL, {
        headers: expect.objectContaining({
          Authorization: "Bearer access",
          "ChatGPT-Account-Id": "account-1",
          "User-Agent": "codex-cli",
        }),
      });
      expect(result.meters.map((meter) => meter.id)).toContain("codex:secondary");
    });

    test("an expired session or rejected token fails with an auth status", async () => {
      mocks.getTokens.mockResolvedValue(undefined);
      await expect(chatGPTLimitAdapter.poll!(ctx, target, NOW)).rejects.toMatchObject({
        name: "LimitPollError",
        status: 401,
      });

      mocks.getTokens.mockResolvedValue({ accessToken: "access", accountId: "account-1" });
      fetchMock.mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
      const failure = chatGPTLimitAdapter.poll!(ctx, target, NOW);
      await expect(failure).rejects.toBeInstanceOf(LimitPollError);
      await expect(failure).rejects.toMatchObject({ status: 429 });
    });
  });
});

describe("passive capture", () => {
  test("reads headers and the error body without consuming the response", async () => {
    const upstream = vi.fn(
      async () => new Response(usageLimitBody, { status: 429, headers: codexHeaders }),
    );
    const capture = createLimitCapture(chatGPTLimitAdapter, upstream);

    const response = await capture.fetch("https://chatgpt.com/backend-api/codex/responses");

    expect(await response.text()).toBe(usageLimitBody);
    const observation = capture.take();
    expect(observation?.plan).toBe("plus");
    expect(observation?.meters.map((meter) => meter.id)).toEqual([
      "codex:primary",
      "codex:secondary",
      "codex:codex_mini:primary",
      "codex:credits",
      "codex:usage-limit",
    ]);
    expect(capture.take()).toBe(undefined);
  });
});
