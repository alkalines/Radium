import { Hono } from "convex-helpers/server/hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CHATGPT_SUBSCRIPTION_PATH } from "./paths";

const mocks = vi.hoisted(() => ({
  handleChatGPTSubscription: vi.fn(),
}));

vi.mock("./chatgpt", () => ({
  handleChatGPTSubscription: mocks.handleChatGPTSubscription,
}));

import { subscriptionRouter } from "./router";

const app = new Hono();
app.route("/api/subscription", subscriptionRouter);

describe("subscription router", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", "https://app.example.test");
    mocks.handleChatGPTSubscription.mockReset();
    mocks.handleChatGPTSubscription.mockResolvedValue(new Response("routed"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("mounts the ChatGPT route below /api/subscription", async () => {
    const ctx = { requestId: "test-request" };
    const response = await app.fetch(
      new Request(`https://gateway.example.test${CHATGPT_SUBSCRIPTION_PATH}/status`),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("routed");
    expect(mocks.handleChatGPTSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatGPTSubscription).toHaveBeenCalledWith(ctx, expect.any(Request));
    expect(mocks.handleChatGPTSubscription.mock.calls[0]?.[1].url).toBe(
      `https://gateway.example.test${CHATGPT_SUBSCRIPTION_PATH}/status`,
    );
  });

  test("answers an allowed-origin preflight without invoking auth or the handler", async () => {
    const response = await app.fetch(
      new Request(`https://gateway.example.test${CHATGPT_SUBSCRIPTION_PATH}/status`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.test",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.test");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type,Authorization");
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(mocks.handleChatGPTSubscription).not.toHaveBeenCalled();
  });

  test("does not grant CORS access to an unconfigured origin", async () => {
    const response = await app.fetch(
      new Request(`https://gateway.example.test${CHATGPT_SUBSCRIPTION_PATH}/status`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example.test",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(mocks.handleChatGPTSubscription).not.toHaveBeenCalled();
  });
});
