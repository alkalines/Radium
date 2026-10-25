/// <reference types="vite/client" />

import { register as registerSecretStore } from "convex-secret-store/test";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { secrets, workspaceProviderSecretNamespace } from "./secrets";
import { DEFAULT_ROUTING_SETTINGS, type RoutingSettings } from "../src/routing/settings";
import type { Id } from "./_generated/dataModel";

type AuthContext = {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier?: string } | null> };
};

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.tokenIdentifier) return null;
    return { _id: identity.tokenIdentifier, email: `${identity.tokenIdentifier}@example.invalid` };
  });
  return {
    getAuthUser,
    safeGetAuthUser: getAuthUser,
    getAnyUserById: vi.fn(),
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
const previousSecretStoreKeys = process.env.SECRET_STORE_KEYS;

beforeAll(() => {
  process.env.SECRET_STORE_KEYS = `1:${Buffer.alloc(32, 1).toString("base64")}`;
});

afterAll(() => {
  if (previousSecretStoreKeys === undefined) delete process.env.SECRET_STORE_KEYS;
  else process.env.SECRET_STORE_KEYS = previousSecretStoreKeys;
});

const MODEL = "test-model";
const allProviders = { allowFallbacks: true };

async function setup(
  providers: Array<{ slug: string; priority?: number; weight?: number }>,
  routing: Partial<RoutingSettings> = {},
) {
  const t = convexTest({ schema, modules });
  registerSecretStore(t);
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Routing workspace",
    });
    const author = await ctx.db.insert("authors", { name: "Test", slug: "test" });
    await ctx.db.insert("models", {
      name: "Test model",
      launch_date: 0,
      author,
      slug: MODEL,
      type: "chat",
      description: "Test model",
      reasoning: false,
      features: {},
      architecture: { input_modalities: ["text"], output_modalities: ["text"], tokenizer: "GPT" },
    });
    await ctx.db.insert("workspace_settings", {
      workspace,
      builtinToolSets: [],
      mcpServers: [],
      routing: { ...DEFAULT_ROUTING_SETTINGS, ...routing },
    });

    for (const provider of providers) {
      await ctx.db.insert("workspace_configurations", {
        workspace,
        provider: provider.slug,
        enabled: true,
        active: true,
        snapshot: {
          slug: provider.slug,
          name: provider.slug,
          npm: "@ai-sdk/openai-compatible",
          env: ["API_KEY"],
          api: "https://upstream.example.test/v1",
          models: [
            {
              model: MODEL,
              context: 4096,
              max_output: 1024,
              pricing: { input: "0.01", output: "0.02" },
              supported_parameters: [],
              moderated: false,
            },
          ],
        },
        routing: {
          priority: provider.priority ?? 0,
          weight: provider.weight ?? 1,
          disableCooling: false,
          modelLevelCooling: false,
          errorRules: [],
        },
      });
      await secrets.put(ctx, {
        namespace: workspaceProviderSecretNamespace(workspace, provider.slug),
        name: provider.slug,
        value: JSON.stringify({ API_KEY: `${provider.slug}-key` }),
      });
    }
    return workspace;
  });
  return { t, workspace };
}

type TestHarness = Awaited<ReturnType<typeof setup>>;

async function pick(
  { t, workspace }: TestHarness,
  options: { excluded?: string[]; session?: string } = {},
) {
  const result = await t.mutation(anyApi.routing.pick, {
    workspace,
    model: MODEL,
    preferences: allProviders,
    excluded: options.excluded ?? [],
    ...(options.session ? { session: { primary: options.session, isSubagent: false } } : {}),
  });
  return result.ok ? (result.provider.slug as string) : result;
}

async function report(
  { t, workspace }: TestHarness,
  provider: string,
  outcome: Record<string, unknown>,
  options: { dispatchedAt?: number; session?: string } = {},
) {
  await t.mutation(anyApi.routing.reportResult, {
    workspace,
    provider,
    model: MODEL,
    dispatchedAt: options.dispatchedAt ?? Date.now(),
    ...(options.session ? { session: { primary: options.session, isSubagent: false } } : {}),
    outcome,
  });
}

const transientFailure = {
  type: "failure",
  reason: "transient",
  credentialScope: false,
  forceCooldown: false,
  rebindOnQuota: false,
  status: 503,
  message: "Service unavailable",
};

describe("routing pick", () => {
  test("round-robin rotates within the top priority tier and skips tried providers", async () => {
    const harness = await setup([{ slug: "a" }, { slug: "b" }, { slug: "backup", priority: -1 }]);

    expect([await pick(harness), await pick(harness), await pick(harness)]).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(await pick(harness, { excluded: ["a"] })).toBe("b");
    // The lower tier serves only once every higher-priority provider is excluded.
    expect(await pick(harness, { excluded: ["a", "b"] })).toBe("backup");
    expect(await pick(harness, { excluded: ["a", "b", "backup"] })).toMatchObject({
      ok: false,
      retryAfterMs: 0,
    });
  });

  test("cooldowns exclude providers until a newer success clears them", async () => {
    const harness = await setup([{ slug: "a" }, { slug: "b" }], { strategy: "fill-first" });
    const dispatchedBeforeFailure = Date.now() - 1000;

    await report(harness, "a", transientFailure);
    expect(await pick(harness)).toBe("b");

    // A success dispatched before the failure was recorded must not clear its cooldown.
    await report(harness, "a", { type: "success" }, { dispatchedAt: dispatchedBeforeFailure });
    expect(await pick(harness)).toBe("b");

    await report(harness, "b", transientFailure);
    const exhausted = await pick(harness);
    expect(exhausted).toMatchObject({ ok: false });
    expect((exhausted as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(55_000);

    await report(harness, "a", { type: "success" }, { dispatchedAt: Date.now() + 1 });
    expect(await pick(harness)).toBe("a");
  });

  test("session affinity reuses the bound provider and rebinds per the configured policy", async () => {
    const quota = await setup([{ slug: "a" }, { slug: "b" }], {
      sessionAffinity: true,
      sessionAffinityRebindOn: "quota",
    });
    expect(await pick(quota, { session: "chat:1" })).toBe("a");
    expect(await pick(quota)).toBe("b");
    expect(await pick(quota, { session: "chat:1" })).toBe("a");

    // Under `quota`, a transient failure fails over without moving the binding.
    await report(quota, "a", transientFailure, { session: "chat:1" });
    expect(await pick(quota, { session: "chat:1" })).toBe("b");
    await quota.t.run(async (ctx) => {
      for (const row of await ctx.db.query("routing_cooldowns").collect()) {
        await ctx.db.delete("routing_cooldowns", row._id);
      }
    });
    expect(await pick(quota, { session: "chat:1" })).toBe("a");

    const any = await setup([{ slug: "a" }, { slug: "b" }], {
      sessionAffinity: true,
      sessionAffinityRebindOn: "any",
    });
    expect(await pick(any, { session: "chat:1" })).toBe("a");
    await report(any, "a", transientFailure, { session: "chat:1" });
    expect(await pick(any, { session: "chat:1" })).toBe("b");
    await any.t.run(async (ctx) => {
      for (const row of await ctx.db.query("routing_cooldowns").collect()) {
        await ctx.db.delete("routing_cooldowns", row._id);
      }
    });
    // Under `any`, the failure moved the binding to the failover provider.
    expect(await pick(any, { session: "chat:1" })).toBe("b");
  });

  test("a pinned provider that cannot serve the model is a configuration error", async () => {
    const harness = await setup([{ slug: "a" }]);
    await expect(
      harness.t.mutation(anyApi.routing.pick, {
        workspace: harness.workspace,
        model: MODEL,
        preferences: { only: ["missing"], allowFallbacks: false },
        excluded: [],
      }),
    ).rejects.toThrow("Model test-model is not available on provider missing.");
  });
});

describe("routing configuration", () => {
  async function asOwner() {
    const harness = await setup([{ slug: "a" }]);
    return { ...harness, owner: harness.t.withIdentity({ tokenIdentifier: "owner" }) };
  }

  test("owners update settings and provider overrides; invalid values are rejected", async () => {
    const { owner, workspace } = await asOwner();
    const settings = {
      ...DEFAULT_ROUTING_SETTINGS,
      strategy: "weighted-round-robin",
      requestRetry: 1,
    };
    await owner.mutation(anyApi.routing.setSettings, { workspace, settings });
    await expect(
      owner.mutation(anyApi.routing.setSettings, {
        workspace,
        settings: { ...settings, requestRetry: 99 },
      }),
    ).rejects.toThrow("Request retry must be an integer from 0 to 10.");

    const routing = {
      priority: 5,
      weight: 3,
      disableCooling: true,
      modelLevelCooling: false,
      errorRules: [{ status: 400, match: [], matchRegex: ["("], action: "continue" }],
    };
    await expect(
      owner.mutation(anyApi.routing.setProviderRouting, { workspace, provider: "a", routing }),
    ).rejects.toThrow("Invalid error rule regular expression");
    await owner.mutation(anyApi.routing.setProviderRouting, {
      workspace,
      provider: "a",
      routing: { ...routing, errorRules: [] },
    });

    const configuration = await owner.query(anyApi.routing.getConfiguration, { workspace });
    expect(configuration.settings).toEqual(settings);
    expect(configuration.providers).toEqual([
      {
        slug: "a",
        name: "a",
        enabled: true,
        hasCredentials: false,
        routing: { ...routing, errorRules: [] },
      },
    ]);
  });

  test("members cannot read or change routing", async () => {
    const { t, workspace } = await asOwner();
    await t.run(async (ctx) => {
      await ctx.db.insert("workspace_members", {
        workspace: workspace as Id<"workspaces">,
        userId: "member",
        role: "member",
      });
    });
    const member = t.withIdentity({ tokenIdentifier: "member" });
    await expect(member.query(anyApi.routing.getConfiguration, { workspace })).rejects.toThrow();
    await expect(
      member.mutation(anyApi.routing.resetCooldown, { workspace, provider: "a" }),
    ).rejects.toThrow();
  });
});
