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
