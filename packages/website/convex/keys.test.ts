/// <reference types="vite/client" />

import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "./schema";
import { hashText } from "./key";

type TestIdentity = {
  tokenIdentifier?: string;
  subject?: string;
  email?: string;
  name?: string;
};

type AuthContext = {
  auth: {
    getUserIdentity: () => Promise<TestIdentity | null>;
  };
};

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const userId = identity.tokenIdentifier ?? identity.subject;
    if (!userId) return null;

    return {
      _id: userId,
      email: identity.email ?? `${userId}@example.invalid`,
      name: identity.name ?? userId,
    };
  });

  return {
    getAuthUser,
    getAnyUserById: vi.fn(),
    safeGetAuthUser: getAuthUser,
    createAuth: vi.fn(),
  };
});

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: authMock.getAuthUser,
    getAnyUserById: authMock.getAnyUserById,
    safeGetAuthUser: authMock.safeGetAuthUser,
  },
  createAuth: authMock.createAuth,
}));

const modules = import.meta.glob("./**/*.ts");

function makeTest() {
  return convexTest({ schema, modules });
}

function asUser(t: ReturnType<typeof makeTest>, userId: string) {
  return t.withIdentity({
    tokenIdentifier: userId,
    subject: userId,
    email: `${userId}@example.invalid`,
    name: userId,
  });
}

test("deleting a migrated key revokes the legacy fallback too", async () => {
  const t = makeTest();
  const plaintext = "legacy-key-secret";
  const hash = await hashText(plaintext);
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", {
      credits: 100,
      userId: "owner",
    });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Legacy workspace",
      legacyBalance: balance,
    });
    const legacyKey = await ctx.db.insert("keys", {
      balance,
      usedCredits: 0,
      name: "Legacy key",
      hash,
      preview: "rad-sk-...cret",
    });
    const apiKey = await ctx.db.insert("api_keys", {
      workspace,
      name: "Migrated key",
      hash,
      preview: "rad-sk-...cret",
      legacyKey,
    });
    return { balance, workspace, legacyKey, apiKey };
  });

  const owner = asUser(t, "owner");
  await expect(owner.query(anyApi.key.getKeyInfo, { key: plaintext })).resolves.toMatchObject({
    workspace: ids.workspace,
    apiKey: ids.apiKey,
  });

  await owner.mutation(anyApi.keys.deleteKey, { key: ids.apiKey });
  const revocations = await t.run(async (ctx) => {
    const legacyKey = await ctx.db.get("keys", ids.legacyKey);
    const apiKey = await ctx.db.get("api_keys", ids.apiKey);
    if (!legacyKey || !apiKey) throw new Error("key fixture disappeared");

    // Force the compatibility branch to resolve the retained legacy row.
    await ctx.db.delete("api_keys", ids.apiKey);
    return { legacy: legacyKey.revokedAt, migrated: apiKey.revokedAt };
  });

  expect(revocations.legacy).toBeDefined();
  expect(revocations.migrated).toBeDefined();
  await expect(t.query(anyApi.key.getKeyInfo, { key: plaintext })).rejects.toThrow(
    "This key is invalid!",
  );
});

test("recordCompletion only records BYOK usage and does not debit a balance", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", {
      credits: 73,
      userId: "owner",
    });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "BYOK workspace",
    });
    const author = await ctx.db.insert("authors", { name: "Test", slug: "test" });
    const providerModel = {
      model: "test-model",
      context: 4096,
      max_output: 1024,
      pricing: { input: "0.01", output: "0.02" },
      supported_parameters: [],
      moderated: false,
    };
    await ctx.db.insert("models", {
      name: "Test model",
      launch_date: 0,
      author,
      slug: "test-model",
      type: "chat",
      description: "Test model",
      reasoning: false,
      features: {},
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "GPT",
      },
    });
    await ctx.db.insert("workspace_configurations", {
      workspace,
      provider: "test-provider",
      enabled: true,
      active: true,
      snapshot: {
        slug: "test-provider",
        name: "Test provider",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: [providerModel],
      },
    });
    return { balance, workspace };
  });

  const request = {
    model_slug: "test-model",
    provider: "test-provider",
    api: "chat_completions" as const,
    stream: false,
    canceled: false,
    prompt_cache_key: "test",
  };
  const response = {
    gen_id: "gen-test",
    provider_gen_id: "provider-gen-test",
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0, written_cache_tokens: 0 },
    },
    ttft: 1,
    gen_time: 2,
    finish_reason: "stop",
  };

  await expect(
    t.mutation(anyApi.key.recordCompletion, {
      bill: { workspace: ids.workspace },
      request: { ...request, byok: false },
      response,
    }),
  ).rejects.toThrow("Only BYOK requests are supported.");

  const completionId = await t.mutation(anyApi.key.recordCompletion, {
    bill: { workspace: ids.workspace },
    request: { ...request, byok: true },
    response,
  });
  const stored = await t.run(async (ctx) => {
    const completion = await ctx.db.get("chat_completions", completionId);
    const balance = await ctx.db.get("balances", ids.balance);
    return { completion, credits: balance?.credits };
  });

  expect(stored.completion).toMatchObject({
    bill: { workspace: ids.workspace },
    request: { byok: true },
  });
  expect(stored.credits).toBe(73);
});
