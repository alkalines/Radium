import { HttpRouterWithHono } from "convex-helpers/server/hono";
import { httpActionGeneric } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../../convex/_generated/server";

const handlers = vi.hoisted(() => ({
  chat: vi.fn(),
  completion: vi.fn(),
  models: vi.fn(),
  subscription: vi.fn(),
  workerAuth: vi.fn(),
}));

vi.mock("./aisdk.chat", () => ({ handleAISDKChat: handlers.chat }));
vi.mock("./chat_completion", () => ({ handleChatCompletion: handlers.completion }));
vi.mock("./models", () => ({ handleOpenAIModels: handlers.models }));
vi.mock("./worker", () => ({ handleWorkerAuth: handlers.workerAuth }));
vi.mock("../subscriptions/chatgpt", () => ({
  handleChatGPTSubscription: handlers.subscription,
}));

import { app } from "./router";

const ctx = { runQuery: vi.fn() } as unknown as ActionCtx;
const origin = "https://app.example.test";

describe("application HTTP router", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", `${origin}/configured/path`);
    for (const handler of Object.values(handlers)) {
      handler.mockReset();
      handler.mockImplementation(async () => new Response("routed"));
    }
  });

  afterEach(() => vi.unstubAllEnvs());

  test.each([
    ["POST", "/api/openai/v1/chat/completions", "completion"],
    ["GET", "/api/openai/v1/models", "models"],
    ["POST", "/api/aisdk/chat", "chat"],
    ["GET", "/api/subscription/chatgpt-subscription/status", "subscription"],
  ] as const)(
    "forwards %s %s with the raw request and Convex context",
    async (method, path, name) => {
      const request = new Request(`https://gateway.example.test${path}`, { method });
      const response = await app.fetch(request, ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("routed");
      expect(handlers[name]).toHaveBeenCalledExactlyOnceWith(ctx, request);
    },
  );

  test.each([origin, "https://other.example.test"])(
    "handles chat preflight for %s before authentication",
    async (requestOrigin) => {
      const response = await app.fetch(
        new Request("https://gateway.example.test/api/aisdk/chat", {
          method: "OPTIONS",
          headers: {
            Origin: requestOrigin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
          },
        }),
        ctx,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        requestOrigin === origin ? origin : null,
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST,OPTIONS");
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type,Authorization",
      );
      expect(response.headers.get("Vary")).toContain("Origin");
      expect(handlers.chat).not.toHaveBeenCalled();
    },
  );

  test("adds CORS to authentication errors", async () => {
    handlers.chat.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
    const response = await app.fetch(
      new Request("https://gateway.example.test/api/aisdk/chat", {
        method: "POST",
        headers: { Origin: origin },
      }),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("preserves a streaming response without consuming its body", async () => {
    let pulled = false;
    const stream = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    handlers.chat.mockResolvedValue(
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
      }),
    );
    const response = await app.fetch(
      new Request("https://gateway.example.test/api/aisdk/chat", {
        method: "POST",
        headers: { Origin: origin },
      }),
      ctx,
    );

    expect(pulled).toBe(false);
    expect(response.body).toBe(stream);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });

  test("does not grant credentialed CORS when SITE_URL is missing", async () => {
    vi.stubEnv("SITE_URL", undefined);
    const response = await app.fetch(
      new Request("https://gateway.example.test/api/aisdk/chat", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      }),
      ctx,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("native Convex routes take priority and bypass application middleware", async () => {
    const http = new HttpRouterWithHono(app);
    const native = httpActionGeneric(async () => new Response("auth"));
    http.route({ pathPrefix: "/api/auth/", method: "GET", handler: native });

    expect(http.lookup("/api/auth/session", "GET")?.[0]).toBe(native);
    expect(http.lookup("/api/aisdk/chat", "POST")?.[0]).not.toBe(native);
    expect(
      await (
        await app.fetch(new Request("https://gateway.example.test/api/auth/session"), ctx)
      ).text(),
    ).toBe("404 Not Found");
  });

  describe("maintenance mode", () => {
    async function send(method: string, path: string) {
      return await app.fetch(
        new Request(`https://gateway.example.test${path}`, { method, headers: { Origin: origin } }),
        ctx,
      );
    }

    test.each([
      ["/api/openai/v1/chat/completions", "completion"],
      ["/api/aisdk/chat", "chat"],
      ["/api/subscription/chatgpt-subscription/start", "subscription"],
      ["/api/worker/auth/challenge", "workerAuth"],
    ] as const)("refuses POST %s with a readable 503 when on", async (path, name) => {
      vi.stubEnv("RADIUM_MAINTENANCE", "1");
      const response = await send("POST", path);

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("300");
      expect(await response.json()).toEqual({
        error: { code: "MAINTENANCE", message: expect.any(String) },
      });
      expect(handlers[name]).not.toHaveBeenCalled();
    });

    test("keeps CORS on refused browser routes", async () => {
      vi.stubEnv("RADIUM_MAINTENANCE", "1");

      for (const path of ["/api/aisdk/chat", "/api/subscription/chatgpt-subscription/start"]) {
        const response = await send("POST", path);
        expect(response.status).toBe(503);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      }
    });

    test("keeps reads open, except subscription reads that bind credentials", async () => {
      vi.stubEnv("RADIUM_MAINTENANCE", "1");

      expect((await send("GET", "/api/openai/v1/models")).status).toBe(200);
      const subscription = await send("GET", "/api/subscription/chatgpt-subscription/status");
      expect(subscription.status).toBe(503);
      expect(subscription.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(handlers.subscription).not.toHaveBeenCalled();
    });

    test("drain keeps Worker token exchange open and closes everything else", async () => {
      vi.stubEnv("RADIUM_MAINTENANCE", "drain");

      expect((await send("POST", "/api/worker/auth/complete")).status).toBe(200);
      expect(handlers.workerAuth).toHaveBeenCalledOnce();
      expect((await send("POST", "/api/openai/v1/chat/completions")).status).toBe(503);
      expect(handlers.completion).not.toHaveBeenCalled();
    });

    test("an unrecognized value closes every write path", async () => {
      vi.stubEnv("RADIUM_MAINTENANCE", "true");

      expect((await send("POST", "/api/worker/auth/challenge")).status).toBe(503);
    });
  });
});
