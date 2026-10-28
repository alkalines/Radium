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
  providers: Array<{ slug: string; priority?: number; weight?: number; credentials?: number }>,
  routing: Partial<RoutingSettings> = {},
) {
  const t = convexTest({ schema, modules });
  registerSecretStore(t);
  const credentials: Record<string, Id<"workspace_credentials">[]> = {};
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
      credentials[provider.slug] = [];
      for (let index = 0; index < (provider.credentials ?? 1); index++) {
        const credential = await ctx.db.insert("workspace_credentials", {
          workspace,
          provider: provider.slug,
          preview: { API_KEY: `****${index}` },
        });
        await ctx.db.patch("workspace_credentials", credential, { secretName: credential });
        await secrets.put(ctx, {
          namespace: workspaceProviderSecretNamespace(workspace, provider.slug),
          name: credential,
          value: JSON.stringify({ API_KEY: `${provider.slug}-key-${index}` }),
        });
        credentials[provider.slug]!.push(credential);
      }
    }
    return workspace;
  });
  return { t, workspace, credentials };
}

type TestHarness = Awaited<ReturnType<typeof setup>>;

/**
 * Target names: the provider slug for a single-credential provider, else `slug#n` with `n` the
 * credential's 1-based creation index. A bare slug in `excluded` expands to all its credentials.
 */
function targetName(harness: TestHarness, provider: string, credential: string) {
  const list = harness.credentials[provider]!;
  return list.length === 1 ? provider : `${provider}#${list.indexOf(credential as never) + 1}`;
}

function targets(harness: TestHarness, name: string) {
  const [provider, index] = name.split("#") as [string, string | undefined];
  const list = harness.credentials[provider]!;
  const selected = index === undefined ? list : [list[Number(index) - 1]!];
  return selected.map((credential) => ({ provider, credential }));
}

async function pick(harness: TestHarness, options: { excluded?: string[]; session?: string } = {}) {
  const result = await harness.t.mutation(anyApi.routing.pick, {
    workspace: harness.workspace,
    model: MODEL,
    preferences: allProviders,
    excluded: (options.excluded ?? []).flatMap((name) => targets(harness, name)),
    ...(options.session ? { session: { primary: options.session, isSubagent: false } } : {}),
  });
  if (!result.ok) return result;
  return targetName(harness, result.provider.slug, result.provider.credential.id);
}

async function report(
  harness: TestHarness,
  name: string,
  outcome: Record<string, unknown>,
  options: { dispatchedAt?: number; session?: string } = {},
) {
  const [target] = targets(harness, name);
  await harness.t.mutation(anyApi.routing.reportResult, {
    workspace: harness.workspace,
    ...target,
    model: MODEL,
    dispatchedAt: options.dispatchedAt ?? Date.now(),
    ...(options.session ? { session: { primary: options.session, isSubagent: false } } : {}),
    outcome,
  });
}

async function clearCooldowns(harness: TestHarness) {
  await harness.t.run(async (ctx) => {
    for (const row of await ctx.db.query("routing_cooldowns").collect()) {
      await ctx.db.delete("routing_cooldowns", row._id);
    }
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

const unauthorizedFailure = {
  ...transientFailure,
  reason: "unauthorized",
  status: 401,
  message: "Invalid API key",
};

describe("credential pools", () => {
  test("round-robin alternates providers and rotates each provider's credentials", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }, { slug: "b" }]);
    const picks = [];
    for (let attempt = 0; attempt < 5; attempt++) picks.push(await pick(harness));

    expect([picks[1], picks[3]]).toEqual(["b", "b"]);
    expect(new Set([picks[0], picks[2]])).toEqual(new Set(["a#1", "a#2"]));
    expect(picks[4]).toBe(picks[0]);
  });

  test("a failing credential cools down without blocking the provider's other credentials", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }, { slug: "b" }], {
      strategy: "fill-first",
    });
    expect(await pick(harness)).toBe("a#1");
    expect(await pick(harness, { excluded: ["a#1"] })).toBe("a#2");

    await report(harness, "a#1", unauthorizedFailure);
    expect(await pick(harness)).toBe("a#2");

    await report(harness, "a#2", transientFailure);
    expect(await pick(harness)).toBe("b");
  });

  test("disabled credentials are never routed", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }], { strategy: "fill-first" });
    const owner = harness.t.withIdentity({ tokenIdentifier: "owner" });
    await owner.mutation(anyApi.providers.updateCredential, {
      workspace: harness.workspace,
      credential: harness.credentials.a![0],
      enabled: false,
    });

    expect(await pick(harness)).toBe("a#2");
    expect(await pick(harness, { excluded: ["a#2"] })).toMatchObject({ ok: false });
  });

  async function placeCredential(
    harness: TestHarness,
    name: string,
    placement: { priority?: number; weight?: number },
  ) {
    const [target] = targets(harness, name);
    await harness.t
      .withIdentity({ tokenIdentifier: "owner" })
      .mutation(anyApi.providers.updateCredential, {
        workspace: harness.workspace,
        credential: target!.credential,
        ...placement,
      });
  }

  test("credential priority tiers decide order inside a provider", async () => {
    const harness = await setup([{ slug: "a", credentials: 3 }]);
    await placeCredential(harness, "a#3", { priority: 2 });
    await placeCredential(harness, "a#1", { priority: 1 });

    // Round-robin stays on the single top-tier credential while it is usable.
    expect([await pick(harness), await pick(harness)]).toEqual(["a#3", "a#3"]);
    expect(await pick(harness, { excluded: ["a#3"] })).toBe("a#1");

    await report(harness, "a#3", unauthorizedFailure);
    await report(harness, "a#1", unauthorizedFailure);
    expect(await pick(harness)).toBe("a#2");
  });

  test("credential weights split weighted round-robin traffic inside a provider", async () => {
    const harness = await setup([{ slug: "a", credentials: 3 }], {
      strategy: "weighted-round-robin",
    });
    await placeCredential(harness, "a#1", { weight: 3 });
    await placeCredential(harness, "a#3", { weight: 0 });

    const picks = [];
    for (let attempt = 0; attempt < 8; attempt++) picks.push(await pick(harness));
    expect(picks.filter((name) => name === "a#1")).toHaveLength(6);
    expect(picks.filter((name) => name === "a#2")).toHaveLength(2);

    // Weight 0 excludes a credential under weighted round-robin.
    expect(await pick(harness, { excluded: ["a#1", "a#2"] })).toMatchObject({ ok: false });
    await expect(placeCredential(harness, "a#2", { weight: -1 })).rejects.toThrow(
      "Weight must be an integer",
    );
  });

  test("session affinity binds a conversation to one credential", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }], { sessionAffinity: true });
    const bound = await pick(harness, { session: "chat:1" });
    const other = bound === "a#1" ? "a#2" : "a#1";

    // Unbound traffic keeps rotating; the conversation stays on its credential.
    expect(await pick(harness)).toBe(other);
    expect(await pick(harness, { session: "chat:1" })).toBe(bound);
    expect(await pick(harness, { session: "chat:1" })).toBe(bound);

    // Under the default `any` policy a failure moves the binding to the failover credential.
    await report(harness, bound as string, transientFailure, { session: "chat:1" });
    expect(await pick(harness, { session: "chat:1" })).toBe(other);
    await clearCooldowns(harness);
    expect(await pick(harness, { session: "chat:1" })).toBe(other);
  });
});

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
    await clearCooldowns(quota);
    expect(await pick(quota, { session: "chat:1" })).toBe("a");

    const any = await setup([{ slug: "a" }, { slug: "b" }], {
      sessionAffinity: true,
      sessionAffinityRebindOn: "any",
    });
    expect(await pick(any, { session: "chat:1" })).toBe("a");
    await report(any, "a", transientFailure, { session: "chat:1" });
    expect(await pick(any, { session: "chat:1" })).toBe("b");
    await clearCooldowns(any);
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
    const { owner, workspace, credentials } = await asOwner();
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
    // Credential placements are validated together with the provider overrides.
    await expect(
      owner.mutation(anyApi.routing.setProviderRouting, {
        workspace,
        provider: "a",
        routing: { ...routing, errorRules: [] },
        credentials: [{ credential: credentials.a![0], priority: 2, weight: -1 }],
      }),
    ).rejects.toThrow("Weight must be an integer");
    await owner.mutation(anyApi.routing.setProviderRouting, {
      workspace,
      provider: "a",
      routing: { ...routing, errorRules: [] },
      credentials: [{ credential: credentials.a![0], priority: 2, weight: 4 }],
    });

    const configuration = await owner.query(anyApi.routing.getConfiguration, { workspace });
    expect(configuration.settings).toEqual(settings);
    expect(configuration.providers).toEqual([
      {
        slug: "a",
        name: "a",
        enabled: true,
        credentials: [
          { _id: credentials.a![0], name: "****0", enabled: true, priority: 2, weight: 4 },
        ],
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
