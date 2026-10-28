/// <reference types="vite/client" />

import { register as registerSecretStore } from "convex-secret-store/test";
import { api, internal } from "./_generated/api";
import { convexTest } from "convex-test";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { secrets, workspaceProviderSecretNamespace } from "./secrets";
import type { Id } from "./_generated/dataModel";
import type { Meter } from "../src/limits/meters";

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
const fetchMock = vi.fn();

beforeAll(() => {
  process.env.SECRET_STORE_KEYS = `1:${Buffer.alloc(32, 1).toString("base64")}`;
});

afterAll(() => {
  if (previousSecretStoreKeys === undefined) delete process.env.SECRET_STORE_KEYS;
  else process.env.SECRET_STORE_KEYS = previousSecretStoreKeys;
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const HOUR = 60 * 60 * 1000;

async function setup() {
  const t = convexTest({ schema, modules });
  registerSecretStore(t);
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Limits workspace",
    });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    for (const provider of [
      {
        slug: "openrouter",
        name: "OpenRouter",
        npm: "@openrouter/ai-sdk-provider" as const,
        env: ["OPENROUTER_API_KEY"],
      },
      {
        slug: "plain",
        name: "Plain",
        npm: "@ai-sdk/openai-compatible" as const,
        env: ["API_KEY"],
        api: "https://upstream.example.test/v1",
      },
    ]) {
      await ctx.db.insert("workspace_configurations", {
        workspace,
        provider: provider.slug,
        enabled: true,
        active: true,
        snapshot: { ...provider, models: [] },
      });
    }
    return workspace;
  });

  const owner = t.withIdentity({ tokenIdentifier: "owner" });
  const openrouter: Id<"workspace_credentials"> = await owner.mutation(
    api.providers.createCredential,
    {
      workspace,
      provider: "openrouter",
      label: "Work key",
      credentials: { OPENROUTER_API_KEY: "sk-or-inference-1234" },
    },
  );
  const plain: Id<"workspace_credentials"> = await owner.mutation(api.providers.createCredential, {
    workspace,
    provider: "plain",
    label: "Plain key",
    credentials: { API_KEY: "plain-key" },
  });
  return {
    t,
    workspace,
    owner,
    member: t.withIdentity({ tokenIdentifier: "member" }),
    openrouter,
    plain,
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function weekly(used: number, resetsAt = Date.now() + 72 * HOUR): Meter {
  return {
    id: "codex:secondary",
    label: "Weekly",
    scope: "credential",
    unit: "percent",
    used,
    windowSeconds: 7 * 24 * 3600,
    resetsAt,
    source: "header",
    observedAt: Date.now(),
  };
}

async function report(
  harness: Harness,
  outcome: { type: "success" } | { type: "failure"; status: number },
  meters?: Meter[],
) {
  await harness.t.mutation(internal.routing.reportResult, {
    workspace: harness.workspace,
    provider: "plain",
    credential: harness.plain,
    model: "test-model",
    dispatchedAt: Date.now(),
    outcome:
      outcome.type === "success"
        ? outcome
        : {
            type: "failure",
            reason: outcome.status === 401 ? "unauthorized" : "transient",
            credentialScope: false,
            forceCooldown: false,
            rebindOnQuota: false,
            status: outcome.status,
            message: `Upstream returned ${outcome.status}`,
          },
    ...(meters ? { limits: { meters } } : {}),
  });
}

async function eventKinds(harness: Harness) {
  const events: Array<{ kind: string }> = await harness.owner.query(api.limits.listEvents, {
    workspace: harness.workspace,
  });
  return events.map((event) => event.kind).reverse();
}

async function limitRow(harness: Harness, credential: Id<"workspace_credentials">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("credential_limits")
      .withIndex("by_credential", (q) => q.eq("credential", credential))
      .first(),
  );
}

describe("owner API", () => {
  test("every function is owner-only", async () => {
    const { workspace, member, openrouter } = await setup();
    await expect(member.query(api.limits.list, { workspace })).rejects.toThrow();
    await expect(member.query(api.limits.getSettings, { workspace })).rejects.toThrow();
    await expect(member.query(api.limits.listEvents, { workspace })).rejects.toThrow();
    await expect(
      member.mutation(api.limits.setSettings, {
        workspace,
        settings: { warnPercent: 50, criticalPercent: 90, lowBalance: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      member.mutation(api.limits.setBudget, {
        workspace,
        credential: openrouter,
        budget: { amount: 5, period: "day" },
      }),
    ).rejects.toThrow();
    await expect(
      member.mutation(api.limits.setLimitKey, { workspace, credential: openrouter, key: "k" }),
    ).rejects.toThrow();
    await expect(
      member.action(api.limits.refresh, { workspace, credential: openrouter }),
    ).rejects.toThrow("Workspace not found.");
  });

  test("settings default and validate", async () => {
    const { workspace, owner } = await setup();
    expect(await owner.query(api.limits.getSettings, { workspace })).toEqual({
      warnPercent: 80,
      criticalPercent: 95,
      lowBalance: 5,
    });
    for (const settings of [
      { warnPercent: 0, criticalPercent: 90, lowBalance: 1 },
      { warnPercent: 90, criticalPercent: 90, lowBalance: 1 },
      { warnPercent: 50, criticalPercent: 101, lowBalance: 1 },
      { warnPercent: 50, criticalPercent: 90, lowBalance: -1 },
    ]) {
      await expect(
        owner.mutation(api.limits.setSettings, { workspace, settings }),
      ).rejects.toThrow();
    }
    const settings = { warnPercent: 60, criticalPercent: 90, lowBalance: 2 };
    await owner.mutation(api.limits.setSettings, { workspace, settings });
    expect(await owner.query(api.limits.getSettings, { workspace })).toEqual(settings);
  });

  test("list returns every pooled credential with adapter capabilities", async () => {
    const { workspace, owner, openrouter, plain } = await setup();
    const list = await owner.query(api.limits.list, { workspace });
    expect(list).toEqual([
      expect.objectContaining({
        credential: openrouter,
        provider: "openrouter",
        providerName: "OpenRouter",
        credentialName: "Work key",
        enabled: true,
        meters: [],
        pollable: true,
        limitKey: expect.objectContaining({ label: "Management key" }),
      }),
      expect.objectContaining({ credential: plain, provider: "plain", pollable: false }),
    ]);
    expect(list[1]).not.toHaveProperty("limitKey");
  });
});

describe("passive capture through routing reports", () => {
  test("thresholds fire once with hysteresis and reset on a new window", async () => {
    const harness = await setup();
    const resetsAt = Date.now() + 72 * HOUR;
    await report(harness, { type: "success" }, [weekly(50, resetsAt)]);
    await report(harness, { type: "success" }, [weekly(82, resetsAt)]);
    await report(harness, { type: "success" }, [weekly(79, resetsAt)]);
    await report(harness, { type: "success" }, [weekly(83, resetsAt)]);
    await report(harness, { type: "success" }, [weekly(96, resetsAt)]);
    expect(await eventKinds(harness)).toEqual(["limit_low", "limit_critical"]);

    await report(harness, { type: "success" }, [weekly(2, resetsAt + 7 * 24 * HOUR)]);
    expect(await eventKinds(harness)).toEqual(["limit_low", "limit_critical", "limit_reset"]);

    const [event] = await harness.owner.query(api.limits.listEvents, {
      workspace: harness.workspace,
      limit: 1,
    });
    expect(event).toMatchObject({
      kind: "limit_reset",
      credential: harness.plain,
      credentialName: "Plain key",
      previous: expect.objectContaining({ used: 96 }),
      meter: expect.objectContaining({ used: 2 }),
    });
    const row = await limitRow(harness, harness.plain);
    expect(row?.meters).toEqual([expect.objectContaining({ id: "codex:secondary", used: 2 })]);
    expect(row?.passiveAt).toBeTypeOf("number");
  });

  test("unauthorized attempts expire the credential once; the next success restores it", async () => {
    const harness = await setup();
    await report(harness, { type: "failure", status: 401 });
    await report(harness, { type: "failure", status: 401 });
    await report(harness, { type: "failure", status: 500 });
    expect(await eventKinds(harness)).toEqual(["credential_expired"]);
    await report(harness, { type: "success" });
    await report(harness, { type: "success" });
    expect(await eventKinds(harness)).toEqual(["credential_expired", "credential_restored"]);

    const exported = await harness.t.query(internal.limits.exportEvent, {
      event: (
        await harness.owner.query(api.limits.listEvents, { workspace: harness.workspace })
      )[1]!._id,
    });
    expect(exported).toMatchObject({
      event: { kind: "credential_expired", status: 401, providerName: "Plain" },
      workspace: { _id: harness.workspace, ownerId: "owner" },
      provider: { slug: "plain", name: "Plain" },
      credential: { _id: harness.plain, name: "Plain key", enabled: true },
      current: { expired: false },
      settings: { warnPercent: 80 },
    });
  });
});

describe("metered budgets", () => {
  async function completion(harness: Harness, cost: number) {
    await harness.t.run(async (ctx) => {
      const author = await ctx.db.insert("authors", { name: "Test", slug: `test-${cost}` });
      const model = await ctx.db.insert("models", {
        name: "Model",
        launch_date: 0,
        author,
        slug: `model-${cost}`,
        type: "chat",
        description: "",
        reasoning: false,
        features: {},
        architecture: { input_modalities: ["text"], output_modalities: ["text"], tokenizer: "GPT" },
      });
      await ctx.db.insert("chat_completions", {
        bill: { workspace: harness.workspace },
        request: {
          provider: "plain",
          credential: harness.plain,
          byok: true,
          model,
          streamed: false,
          canceled: false,
        },
        response: {
          genId: "gen",
          providerGenId: "upstream",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            completion_tokens_details: {},
            prompt_tokens_details: {},
          },
          pricing: {
            prompt_tokens: cost / 2,
            completion_tokens: cost / 2,
            prompt_tokens_details: { cached_tokens: 0 },
            cost,
          },
          ttft: 1,
          gen_time: 1,
          finish_reason: "stop",
        },
      });
    });
  }

  test("sums Radium's recorded cost for the period and fires thresholds", async () => {
    const harness = await setup();
    const { owner, workspace, plain } = harness;
    await expect(
      owner.mutation(api.limits.setBudget, {
        workspace,
        credential: plain,
        budget: { amount: 0, period: "month" },
      }),
    ).rejects.toThrow("greater than 0");

    await completion(harness, 0.5);
    await owner.mutation(api.limits.setBudget, {
      workspace,
      credential: plain,
      budget: { amount: 1, period: "month" },
    });
    let entry = (await owner.query(api.limits.list, { workspace }))[1]!;
    expect(entry.budget).toEqual({ amount: 1, period: "month" });
    expect(entry.meters).toEqual([
      expect.objectContaining({
        id: "budget",
        label: "Budget (month)",
        unit: "usd",
        used: 0.5,
        limit: 1,
        source: "metered",
      }),
    ]);

    await completion(harness, 0.46);
    await harness.t.mutation(internal.limits.refreshBudget, { credential: plain });
    entry = (await owner.query(api.limits.list, { workspace }))[1]!;
    expect(entry.meters[0]!.used).toBeCloseTo(0.96);
    expect(await eventKinds(harness)).toEqual(["limit_critical"]);

    await owner.mutation(api.limits.setBudget, { workspace, credential: plain, budget: null });
    entry = (await owner.query(api.limits.list, { workspace }))[1]!;
    expect(entry.meters).toEqual([]);
    expect(entry).not.toHaveProperty("budget");
  });
});

describe("limit keys and cleanup", () => {
  test("limit keys exist only where the adapter declares one", async () => {
    const { workspace, owner, plain, openrouter, t } = await setup();
    await expect(
      owner.mutation(api.limits.setLimitKey, { workspace, credential: plain, key: "k" }),
    ).rejects.toThrow("no separate limit key");

    await owner.mutation(api.limits.setLimitKey, {
      workspace,
      credential: openrouter,
      key: " sk-or-management-9876 ",
    });
    const entry = (await owner.query(api.limits.list, { workspace }))[0]!;
    expect(entry.limitKey).toMatchObject({ label: "Management key", preview: "****9876" });
    const stored = await t.run((ctx) =>
      secrets.get(ctx, {
        namespace: workspaceProviderSecretNamespace(workspace, "openrouter"),
        name: `${openrouter}:limit-key`,
      }),
    );
    expect(stored).toMatchObject({ ok: true, value: "sk-or-management-9876" });

    await owner.mutation(api.limits.setLimitKey, { workspace, credential: openrouter, key: null });
    const cleared = (await owner.query(api.limits.list, { workspace }))[0]!;
    expect(cleared.limitKey).not.toHaveProperty("preview");
  });

  test("removing a credential removes its snapshot and limit key but keeps its events", async () => {
    const harness = await setup();
    const { workspace, owner, openrouter, t } = harness;
    await owner.mutation(api.limits.setLimitKey, {
      workspace,
      credential: openrouter,
      key: "sk-or-management",
    });
    await harness.t.mutation(internal.routing.reportResult, {
      workspace,
      provider: "openrouter",
      credential: openrouter,
      model: "test-model",
      dispatchedAt: Date.now(),
      outcome: {
        type: "failure",
        reason: "unauthorized",
        credentialScope: false,
        forceCooldown: false,
        rebindOnQuota: true,
        status: 401,
        message: "Invalid key",
      },
    });
    expect(await limitRow(harness, openrouter)).not.toBeNull();

    await owner.mutation(api.providers.deleteCredential, {
      workspace,
      provider: "openrouter",
      credential: openrouter,
    });

    expect(await limitRow(harness, openrouter)).toBeNull();
    const stored = await t.run((ctx) =>
      secrets.get(ctx, {
        namespace: workspaceProviderSecretNamespace(workspace, "openrouter"),
        name: `${openrouter}:limit-key`,
      }),
    );
    expect(stored.ok).toBe(false);
    const events = await owner.query(api.limits.listEvents, { workspace });
    expect(events).toEqual([
      expect.objectContaining({ kind: "credential_expired", credentialName: "Work key" }),
    ]);
  });

  test("deleting a provider removes the snapshots of all its credentials", async () => {
    const harness = await setup();
    await harness.owner.mutation(api.providers.deleteProvider, {
      workspace: harness.workspace,
      slug: "openrouter",
    });
    expect(await limitRow(harness, harness.openrouter)).toBeNull();
    expect(await limitRow(harness, harness.plain)).not.toBeNull();
  });
});

describe("polling", () => {
  const keyBody = {
    data: { limit: 10, limit_remaining: 1.5, limit_reset: "daily", usage: 8.5 },
  };

  test("owner refresh polls now, at most once a minute, only for pollable providers", async () => {
    const { workspace, owner, openrouter, plain } = await setup();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(Response.json(keyBody));

    await owner.action(api.limits.refresh, { workspace, credential: openrouter });
    const entry = (await owner.query(api.limits.list, { workspace }))[0]!;
    expect(entry.meters).toEqual([
      expect.objectContaining({ id: "openrouter:key", limit: 10, used: 8.5, source: "poll" }),
    ]);
    expect(entry.polledAt).toBeTypeOf("number");
    expect(await eventKinds({ owner, workspace } as Harness)).toEqual(["limit_low"]);

    await expect(
      owner.action(api.limits.refresh, { workspace, credential: openrouter }),
    ).rejects.toThrow("Refreshed too recently");
    await expect(
      owner.action(api.limits.refresh, { workspace, credential: plain }),
    ).rejects.toThrow("no usage endpoint");
  });

  test("scheduled polls back off on errors, fire one poll_failed per streak, and expire on 401", async () => {
    const harness = await setup();
    vi.stubGlobal("fetch", fetchMock);
    const due = () =>
      harness.t.run(async (ctx) => {
        const row = await ctx.db
          .query("credential_limits")
          .withIndex("by_credential", (q) => q.eq("credential", harness.openrouter))
          .first();
        await ctx.db.patch("credential_limits", row!._id, { nextPollAt: Date.now() - 1 });
      });

    fetchMock.mockResolvedValue(new Response("Internal error", { status: 500 }));
    await harness.t.action(internal.limits.pollDue, {});
    let row = await limitRow(harness, harness.openrouter);
    expect(row?.pollError).toMatchObject({ status: 500 });
    expect(row!.nextPollAt! - Date.now()).toBeGreaterThan(4 * 60 * 1000);

    await due();
    await harness.t.action(internal.limits.pollDue, {});
    row = await limitRow(harness, harness.openrouter);
    expect(row?.pollFailures).toBe(2);
    expect(row!.nextPollAt! - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(await eventKinds(harness)).toEqual(["poll_failed"]);

    await due();
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await harness.t.action(internal.limits.pollDue, {});
    expect(await eventKinds(harness)).toEqual(["poll_failed", "credential_expired"]);

    await due();
    fetchMock.mockResolvedValue(Response.json(keyBody));
    await harness.t.action(internal.limits.pollDue, {});
    row = await limitRow(harness, harness.openrouter);
    expect(row?.pollError).toBeUndefined();
    expect(row?.pollFailures).toBe(0);
    expect(await eventKinds(harness)).toEqual([
      "poll_failed",
      "credential_expired",
      "limit_low",
      "credential_restored",
    ]);
  });

  test("fresh passive data defers a scheduled poll", async () => {
    const harness = await setup();
    vi.stubGlobal("fetch", fetchMock);
    await harness.t.run(async (ctx) => {
      const row = await ctx.db
        .query("credential_limits")
        .withIndex("by_credential", (q) => q.eq("credential", harness.openrouter))
        .first();
      await ctx.db.patch("credential_limits", row!._id, { passiveAt: Date.now() - 60_000 });
    });
    await harness.t.action(internal.limits.pollDue, {});
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await limitRow(harness, harness.openrouter);
    expect(row!.nextPollAt! - Date.now()).toBeGreaterThan(8 * 60 * 1000);
  });
});
