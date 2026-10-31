/// <reference types="vite/client" />

import { register as registerMigrations } from "@convex-dev/migrations/test";
import { register as registerSecretStore } from "convex-secret-store/test";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function makeTest() {
  const t = convexTest({ schema, modules });
  registerMigrations(t);
  registerSecretStore(t);
  return t;
}

const oneBatch = {
  cursor: null,
  batchSize: 25,
  dryRun: false,
  oneBatchOnly: true,
};

test("chatsToWorkspaces rejects a forged cross-owner legacy source", async () => {
  const t = makeTest();
  const chat = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", {
      credits: 0,
      userId: "alice",
    });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "alice",
      name: "Alice workspace",
      legacyBalance: balance,
    });
    const chat = await ctx.db.insert("aisdk_chats", {
      userId: "bob",
      balance,
      messages: [],
      chat_completions: [],
    });
    return chat;
  });

  await expect(t.mutation(anyApi.migrations.chatsToWorkspaces, oneBatch)).rejects.toThrow(
    "do not migrate the chat",
  );

  const storedChat = await t.run((ctx) => ctx.db.get("aisdk_chats", chat));
  expect(storedChat).toMatchObject({ userId: "bob", balance: expect.any(String) });
  expect(storedChat?.workspace).toBeUndefined();
});

test("chatsToWorkspaces applies the owner-validated personal backfill", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", {
      credits: 0,
      userId: "alice",
    });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "alice",
      name: "Alice workspace",
      legacyBalance: balance,
    });
    const chat = await ctx.db.insert("aisdk_chats", {
      userId: "alice",
      balance,
      messages: [],
      chat_completions: [],
    });
    return { workspace, chat };
  });

  await expect(t.mutation(anyApi.migrations.chatsToWorkspaces, oneBatch)).resolves.toMatchObject({
    processed: 1,
    isDone: true,
  });

  const chat = await t.run((ctx) => ctx.db.get("aisdk_chats", ids.chat));
  expect(chat).toMatchObject({
    workspace: ids.workspace,
    scope: "personal",
  });
});

test("chatMessagesToTable moves embedded histories out of chat documents in order", async () => {
  const t = makeTest();
  const message = (id: string, text: string) => ({
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text, state: "done" as const }],
  });
  const chat = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "alice",
      name: "Alice workspace",
    });
    return await ctx.db.insert("aisdk_chats", {
      userId: "alice",
      workspace,
      messages: [message("m0", "first"), message("m1", "second")],
      chat_completions: [],
    });
  });

  await expect(t.mutation(anyApi.migrations.chatMessagesToTable, oneBatch)).resolves.toMatchObject({
    processed: 1,
    isDone: true,
  });
  // A second run must not duplicate rows for the already-moved chat.
  await t.mutation(anyApi.migrations.chatMessagesToTable, oneBatch);

  const stored = await t.run((ctx) => ctx.db.get("aisdk_chats", chat));
  expect(stored?.messages).toBeUndefined();
  expect(stored?.chat_completions).toBeUndefined();
  const rows = await t.run((ctx) =>
    ctx.db
      .query("chat_messages")
      .withIndex("by_chat_and_position", (q) => q.eq("chat", chat))
      .collect(),
  );
  expect(rows.map((row) => [row.position, row.message.id])).toEqual([
    [0, "m0"],
    [1, "m1"],
  ]);
});

test("apiKeysFromKeys rejects a legacy balance mapped to another owner", async () => {
  const t = makeTest();
  await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", {
      credits: 0,
      userId: "alice",
    });
    await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "forged-owner",
      name: "Forged workspace",
      legacyBalance: balance,
    });
    await ctx.db.insert("keys", {
      balance,
      usedCredits: 0,
      name: "Legacy key",
      hash: "hash",
    });
  });

  await expect(t.mutation(anyApi.migrations.apiKeysFromKeys, oneBatch)).rejects.toThrow(
    "ownership mapping is invalid",
  );

  const apiKeys = await t.run((ctx) => ctx.db.query("api_keys").take(10));
  expect(apiKeys).toHaveLength(0);
});

test("apiKeysFromKeys propagates a source revocation to its mapped key", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", {
      credits: 0,
      userId: "alice",
    });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "alice",
      name: "Alice workspace",
      legacyBalance: balance,
    });
    const key = await ctx.db.insert("keys", {
      balance,
      usedCredits: 0,
      name: "Legacy key",
      hash: "hash",
      revokedAt: 123,
    });
    const apiKey = await ctx.db.insert("api_keys", {
      workspace,
      name: "Mapped key",
      hash: "hash",
      legacyKey: key,
    });
    return { apiKey };
  });

  await t.mutation(anyApi.migrations.apiKeysFromKeys, oneBatch);

  const apiKey = await t.run((ctx) => ctx.db.get("api_keys", ids.apiKey));
  expect(apiKey?.revokedAt).toBe(123);
});

test("credentialLimits makes credentials added before limit tracking due for polling", async () => {
  const t = makeTest();
  const credential = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "alice",
      name: "Alice workspace",
    });
    await ctx.db.insert("workspace_configurations", {
      workspace,
      provider: "openrouter",
      enabled: true,
      active: true,
      snapshot: {
        slug: "openrouter",
        name: "OpenRouter",
        npm: "@openrouter/ai-sdk-provider",
        env: ["OPENROUTER_API_KEY"],
        models: [],
      },
    });
    return await ctx.db.insert("workspace_credentials", {
      workspace,
      provider: "openrouter",
      preview: { OPENROUTER_API_KEY: "sk-or…1234" },
      secretName: "pre-limits",
    });
  });

  await t.mutation(anyApi.migrations.credentialLimits, oneBatch);

  const row = await t.run((ctx) =>
    ctx.db
      .query("credential_limits")
      .withIndex("by_credential", (q) => q.eq("credential", credential))
      .unique(),
  );
  expect(row?.nextPollAt).toBeLessThanOrEqual(Date.now());
});

test("credentialLimits moves a ChatGPT login plan from the account preview to the snapshot", async () => {
  const t = makeTest();
  const credential = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "alice",
      name: "Alice workspace",
    });
    await ctx.db.insert("workspace_configurations", {
      workspace,
      provider: "openai-codex",
      enabled: true,
      active: true,
      snapshot: {
        slug: "openai-codex",
        name: "ChatGPT Subscription",
        npm: "@opencoredev/loginwithchatgpt-ai",
        env: ["sessionCookie"],
        credential_type: "oauth",
        oauth_flow: "chatgpt-device",
        models: [],
      },
    });
    return await ctx.db.insert("workspace_credentials", {
      workspace,
      provider: "openai-codex",
      preview: { account: "alice@example.test · plus plan" },
      secretName: "pre-limits",
    });
  });

  await t.mutation(anyApi.migrations.credentialLimits, oneBatch);

  const stored = await t.run(async (ctx) => ({
    credential: await ctx.db.get("workspace_credentials", credential),
    limits: await ctx.db
      .query("credential_limits")
      .withIndex("by_credential", (q) => q.eq("credential", credential))
      .unique(),
  }));
  expect(stored.credential?.preview).toEqual({ account: "alice@example.test" });
  expect(stored.limits?.plan).toBe("plus");
});
