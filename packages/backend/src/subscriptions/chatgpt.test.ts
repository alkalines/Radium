import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "../../convex/_generated/api";
import { OPENAI_CODEX_SLUG } from "../provider_slugs";
import { CHATGPT_SUBSCRIPTION_PATH } from "./paths";

const mocks = vi.hoisted(() => ({
  createChatGPTHandler: vi.fn(),
  handler: vi.fn(),
  proxyFetch: vi.fn(),
  safeGetAuthUser: vi.fn(),
}));

vi.mock("@opencoredev/loginwithchatgpt-server", () => ({
  createChatGPTHandler: mocks.createChatGPTHandler,
}));

vi.mock("../../convex/auth", () => ({
  authComponent: {
    safeGetAuthUser: mocks.safeGetAuthUser,
  },
}));

import { handleChatGPTSubscription } from "./chatgpt";

function makeContext() {
  return {
    runQuery: vi.fn(),
    runMutation: vi.fn(),
  };
}

function makeRequest(path: string, init?: RequestInit) {
  return new Request(`https://gateway.example.test${CHATGPT_SUBSCRIPTION_PATH}${path}`, init);
}

function functionName(reference: unknown) {
  return getFunctionName(reference as never);
}

describe("ChatGPT subscription handler", () => {
  beforeEach(() => {
    vi.stubEnv("LWC_SECRET", "test-secret");
    vi.stubEnv("SITE_URL", "https://app.example.test");
    mocks.createChatGPTHandler.mockReset();
    mocks.handler.mockReset();
    mocks.proxyFetch.mockReset();
    mocks.safeGetAuthUser.mockReset();
    mocks.createChatGPTHandler.mockReturnValue({
      handler: mocks.handler,
      proxyFetch: mocks.proxyFetch,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("rejects a missing user before constructing the dependency handler", async () => {
    const ctx = makeContext();
    mocks.safeGetAuthUser.mockResolvedValue(null);

    const response = await handleChatGPTSubscription(
      ctx as never,
      makeRequest("/status?workspace=workspace_1"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(mocks.createChatGPTHandler).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  test("rejects a workspace the user does not own before constructing the dependency handler", async () => {
    const ctx = makeContext();
    const user = { _id: "user_1", email: "user@example.test" };
    mocks.safeGetAuthUser.mockResolvedValue(user);
    ctx.runQuery.mockResolvedValue(null);

    const response = await handleChatGPTSubscription(
      ctx as never,
      makeRequest("/status?workspace=workspace_not_owned"),
    );

    expect(response.status).toBe(401);
    expect(ctx.runQuery).toHaveBeenCalledTimes(1);
    expect(ctx.runQuery.mock.calls[0]?.[1]).toEqual({
      workspace: "workspace_not_owned",
      userId: user._id,
    });
    expect(functionName(ctx.runQuery.mock.calls[0]?.[0])).toBe(
      "workspaces:getOwnedWorkspaceForUser",
    );
    expect(mocks.createChatGPTHandler).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  test("binds the session cookie after an authenticated status response", async () => {
    const ctx = makeContext();
    const workspace = "workspace_1";
    const user = { _id: "user_1", email: "user@example.test" };
    mocks.safeGetAuthUser.mockResolvedValue(user);
    ctx.runQuery.mockResolvedValue(workspace);
    ctx.runMutation.mockResolvedValue(undefined);
    mocks.handler.mockResolvedValue(
      Response.json({
        status: "authenticated",
        user: { email: "chatgpt@example.test", plan: "plus" },
      }),
    );

    const response = await handleChatGPTSubscription(
      ctx as never,
      makeRequest("/status?workspace=workspace_1", {
        headers: {
          Cookie: "lwc_chatgpt_subscription=session-cookie; other=value",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createChatGPTHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        basePath: CHATGPT_SUBSCRIPTION_PATH,
        secret: "test-secret",
        cookieName: "lwc_chatgpt_subscription",
        allowedOrigins: ["https://app.example.test"],
      }),
    );
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    expect(functionName(ctx.runMutation.mock.calls[0]?.[0])).toBe("providers:bindOAuthCredential");
    expect(ctx.runMutation.mock.calls[0]?.[1]).toEqual({
      workspace,
      provider: OPENAI_CODEX_SLUG,
      userId: user._id,
      credentials: { sessionCookie: "lwc_chatgpt_subscription=session-cookie" },
      preview: { account: "chatgpt@example.test · plus plan" },
    });
  });

  test("unbinds the existing credential when the provider logs out", async () => {
    const ctx = makeContext();
    const workspace = "workspace_1";
    const user = { _id: "user_1", email: "user@example.test" };
    mocks.safeGetAuthUser.mockResolvedValue(user);
    ctx.runQuery.mockResolvedValue(workspace);
    ctx.runMutation.mockResolvedValue(undefined);
    mocks.handler.mockResolvedValue(Response.json({ status: "unauthenticated" }));

    const response = await handleChatGPTSubscription(
      ctx as never,
      makeRequest("/logout?workspace=workspace_1", {
        method: "POST",
        headers: {
          Cookie: "lwc_chatgpt_subscription=session-cookie",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    expect(functionName(ctx.runMutation.mock.calls[0]?.[0])).toBe(
      "providers:unbindOAuthCredential",
    );
    expect(ctx.runMutation.mock.calls[0]?.[1]).toEqual({
      workspace,
      provider: OPENAI_CODEX_SLUG,
      userId: user._id,
    });
  });
});
