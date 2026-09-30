import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";

const auth = vi.hoisted(() => ({
  safeGetAuthUser: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../../convex/auth", () => ({
  authComponent: { safeGetAuthUser: auth.safeGetAuthUser },
  createAuth: () => ({ api: { getSession: auth.getSession } }),
}));

import { handleAISDKChat } from "./aisdk.chat";
import { handleChatCompletion } from "./chat_completion";
import { handleOpenAIModels } from "./models";

const runQuery = vi.fn();
const runMutation = vi.fn();
const ctx = { runQuery, runMutation } as unknown as ActionCtx;
const completionBody = { model: "test-model", messages: [{ role: "user", content: "Hello" }] };

describe("moved HTTP handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.safeGetAuthUser.mockResolvedValue(null);
    auth.getSession.mockResolvedValue(null);
  });

  test.each([handleOpenAIModels, handleChatCompletion])(
    "%s rejects missing and invalid bearer keys before routing",
    async (handler) => {
      for (const key of [undefined, "invalid-key"]) {
        runQuery.mockResolvedValue(null);
        const response = await handler(
          ctx,
          new Request("https://gateway.example.test/", {
            method: "POST",
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            body: JSON.stringify(completionBody),
          }),
        );
        expect(response.status).toBe(401);
      }
      expect(runQuery).toHaveBeenCalledExactlyOnceWith(api.key.getKeyInfo, { key: "invalid-key" });
      expect(runMutation).not.toHaveBeenCalled();
    },
  );

  test("model listing derives workspace from the validated API key", async () => {
    const models = { object: "list", data: [{ id: "workspace-model" }] };
    runQuery.mockResolvedValueOnce({ workspace: "key-workspace" }).mockResolvedValueOnce(models);
    const response = await handleOpenAIModels(
      ctx,
      new Request(
        "https://gateway.example.test/api/openai/v1/models?workspace=untrusted-workspace",
        { headers: { Authorization: "Bearer valid-key" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(models);
    expect(runQuery).toHaveBeenNthCalledWith(2, internal.models.openaiModels, {
      workspace: "key-workspace",
    });
  });

  test("model listing retains the legacy workspace bridge", async () => {
    runQuery
      .mockResolvedValueOnce({ legacyBalance: "legacy-balance" })
      .mockResolvedValueOnce({ data: [] });
    runMutation.mockResolvedValue("backfilled-workspace");
    const response = await handleOpenAIModels(
      ctx,
      new Request("https://gateway.example.test/", {
        headers: { Authorization: "Bearer legacy-key" },
      }),
    );
    expect(response.status).toBe(200);
    expect(runMutation).toHaveBeenCalledExactlyOnceWith(
      internal.workspaces.ensureForLegacyBalance,
      {
        balance: "legacy-balance",
      },
    );
    expect(runQuery).toHaveBeenNthCalledWith(2, internal.models.openaiModels, {
      workspace: "backfilled-workspace",
    });
  });

  test("chat requires a Better Auth session before reading the body", async () => {
    const request = new Request("https://gateway.example.test/api/aisdk/chat", {
      method: "POST",
      headers: { Cookie: "session=test" },
      body: "not-json",
    });
    const response = await handleAISDKChat(ctx, request);
    expect(response.status).toBe(401);
    expect(auth.getSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers });
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  test.each(["convex", "cookie"])(
    "chat authorizes access using the %s session's identity",
    async (source) => {
      if (source === "convex")
        auth.safeGetAuthUser.mockResolvedValue({ _id: "authenticated-user" });
      else auth.getSession.mockResolvedValue({ user: { id: "authenticated-user" } });
      runQuery.mockResolvedValue(null);
      const response = await handleAISDKChat(
        ctx,
        new Request("https://gateway.example.test/api/aisdk/chat", {
          method: "POST",
          body: JSON.stringify({
            chatId: "private-chat",
            model: "model",
            messages: [],
            userId: "untrusted-user",
          }),
        }),
      );
      expect(response.status).toBe(401);
      expect(runQuery).toHaveBeenCalledExactlyOnceWith(internal.workspaces.authorizeChatForUser, {
        chatId: "private-chat",
        userId: "authenticated-user",
      });
      expect(runMutation).not.toHaveBeenCalled();
    },
  );
});
