/// <reference types="vite/client" />

import { register as registerSecretStore } from "convex-secret-store/test";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { secrets, workspaceProviderSecretNamespace } from "./secrets";
import { OPENAI_CODEX_SLUG } from "../src/provider_slugs";
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

async function setup() {
  const t = convexTest({ schema, modules });
  registerSecretStore(t);
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Credential workspace",
    });
    await ctx.db.insert("workspace_configurations", {
      workspace,
      provider: "keyed",
      enabled: true,
      active: true,
      snapshot: {
        slug: "keyed",
        name: "Keyed",
        npm: "@ai-sdk/openai-compatible",
        env: ["API_KEY"],
        api: "https://upstream.example.test/v1",
        models: [],
      },
    });
    await ctx.db.insert("workspace_configurations", {
      workspace,
      provider: OPENAI_CODEX_SLUG,
      enabled: true,
      active: true,
      snapshot: {
        slug: OPENAI_CODEX_SLUG,
        name: "ChatGPT",
        npm: "@opencoredev/loginwithchatgpt-ai",
        env: [],
        credential_type: "oauth",
        oauth_flow: "chatgpt-device",
        models: [],
      },
    });
    return workspace;
  });
  return { t, workspace, owner: t.withIdentity({ tokenIdentifier: "owner" }) };
}

async function storedValues(
  t: ReturnType<typeof convexTest>,
  workspace: Id<"workspaces">,
  provider: string,
  credential: Id<"workspace_credentials">,
) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get("workspace_credentials", credential);
    const result = await secrets.get(ctx, {
      namespace: workspaceProviderSecretNamespace(workspace, provider),
      name: row?.secretName ?? provider,
    });
    return result.ok ? JSON.parse(result.value) : null;
  });
}

describe("API key pools", () => {
  test("owners add, rename, disable, replace, and remove several keys per provider", async () => {
    const { t, workspace, owner } = await setup();
    const first = await owner.mutation(anyApi.providers.createCredential, {
      workspace,
      provider: "keyed",
      label: "  Team key  ",
      credentials: { API_KEY: "sk-first-1111" },
    });
    const second = await owner.mutation(anyApi.providers.createCredential, {
      workspace,
      provider: "keyed",
      priority: 2,
      weight: 3,
      credentials: { API_KEY: "sk-second-2222" },
    });

    expect(await owner.query(anyApi.providers.listCredentials, { workspace })).toEqual([
      {
        _id: first,
        provider: "keyed",
        name: "Team key",
        label: "Team key",
        preview: { API_KEY: "****1111" },
        enabled: true,
        priority: 0,
        weight: 1,
      },
      {
        _id: second,
        provider: "keyed",
        name: "****2222",
        preview: { API_KEY: "****2222" },
        enabled: true,
        priority: 2,
        weight: 3,
      },
    ]);

    await owner.mutation(anyApi.providers.updateCredential, {
      workspace,
      credential: second,
      label: "Backup",
      enabled: false,
      credentials: { API_KEY: "sk-rotated-3333" },
    });
    expect(await storedValues(t, workspace, "keyed", second)).toEqual({
      API_KEY: "sk-rotated-3333",
    });
    // The other key's secret is untouched by its sibling's rotation.
    expect(await storedValues(t, workspace, "keyed", first)).toEqual({ API_KEY: "sk-first-1111" });

    await owner.mutation(anyApi.providers.deleteCredential, {
      workspace,
      provider: "keyed",
      credential: first,
    });
    const remaining = await owner.query(anyApi.providers.listCredentials, { workspace });
    expect(remaining).toMatchObject([
      { _id: second, name: "Backup", preview: { API_KEY: "****3333" }, enabled: false },
    ]);
    expect(
      await t.run(async (ctx) =>
        secrets.get(ctx, {
          namespace: workspaceProviderSecretNamespace(workspace, "keyed"),
          name: first,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  test("rejects incomplete keys, OAuth providers, and non-owners", async () => {
    const { t, workspace, owner } = await setup();
    await expect(
      owner.mutation(anyApi.providers.createCredential, {
        workspace,
        provider: "keyed",
        credentials: {},
      }),
    ).rejects.toThrow("Missing required credential value: API_KEY");
    await expect(
      owner.mutation(anyApi.providers.createCredential, {
        workspace,
        provider: OPENAI_CODEX_SLUG,
        credentials: {},
      }),
    ).rejects.toThrow("accounts through its login flow");

    await t.run(async (ctx) => {
      await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    });
    const member = t.withIdentity({ tokenIdentifier: "member" });
    await expect(
      member.mutation(anyApi.providers.createCredential, {
        workspace,
        provider: "keyed",
        credentials: { API_KEY: "sk-member" },
      }),
    ).rejects.toThrow();
    await expect(member.query(anyApi.providers.listCredentials, { workspace })).rejects.toThrow();
  });
});

describe("OAuth account pools", () => {
  const cookie = (session: string) => `lwc_chatgpt_subscription=${session}.signature`;

  async function bind(
    harness: Awaited<ReturnType<typeof setup>>,
    account: string,
    session: string,
  ) {
    await harness.t.mutation(anyApi.providers.bindOAuthCredential, {
      workspace: harness.workspace,
      provider: OPENAI_CODEX_SLUG,
      userId: "owner",
      account,
      credentials: { sessionCookie: cookie(session) },
      preview: { account: `${account}@example.test` },
    });
  }

  async function sessionExists(harness: Awaited<ReturnType<typeof setup>>, session: string) {
    return await harness.t.run(async (ctx) => {
      const rows = await ctx.db.query("subscription_state").collect();
      return rows.some((row) => row.key === session);
    });
  }

  test("logins add accounts, reconnects replace the account's session, removal ends it", async () => {
    const harness = await setup();
    await harness.t.run(async (ctx) => {
      for (const session of ["s1", "s2", "s3"]) {
        await ctx.db.insert("subscription_state", {
          provider: OPENAI_CODEX_SLUG,
          namespace: "session",
          key: session,
          value: {},
        });
      }
    });
    const list = () =>
      harness.owner.query(anyApi.providers.listCredentials, { workspace: harness.workspace });

    await bind(harness, "alice", "s1");
    await bind(harness, "alice", "s1");
    await bind(harness, "bob", "s2");
    expect((await list()).map((entry: { name: string }) => entry.name)).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);

    // Logging in to a connected account again keeps one credential and ends the old session.
    await bind(harness, "alice", "s3");
    const accounts = await list();
    expect(accounts).toHaveLength(2);
    const alice = accounts[0]._id as Id<"workspace_credentials">;
    expect(await storedValues(harness.t, harness.workspace, OPENAI_CODEX_SLUG, alice)).toEqual({
      sessionCookie: cookie("s3"),
    });
    expect(await sessionExists(harness, "s1")).toBe(false);

    // A logged-out session unbinds only its own account.
    await harness.t.mutation(anyApi.providers.unbindOAuthCredential, {
      workspace: harness.workspace,
      provider: OPENAI_CODEX_SLUG,
      userId: "owner",
      credentials: { sessionCookie: cookie("s2") },
    });
    expect((await list()).map((entry: { _id: string }) => entry._id)).toEqual([alice]);

    await harness.owner.mutation(anyApi.providers.deleteCredential, {
      workspace: harness.workspace,
      provider: OPENAI_CODEX_SLUG,
      credential: alice,
    });
    expect(await list()).toEqual([]);
    expect(await sessionExists(harness, "s3")).toBe(false);
  });
});

test("editing Default pricing updates ordinary requests' base quote and preserves model configuration", async () => {
  const { t, workspace, owner } = await setup();
  const model = {
    model: "example",
    upstream_model_id: "custom-upstream",
    context: 272000,
    max_output: 5000,
    pricing: { input: "0.000001", output: "0.000005" },
    supported_parameters: ["max_tokens" as const],
    moderated: false,
  };
  const configurationId = await t.run(async (ctx) => {
    const configuration = await ctx.db
      .query("workspace_configurations")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", workspace).eq("provider", "keyed"),
      )
      .first();
    if (!configuration?.snapshot) throw new Error("Missing fixture configuration");
    await ctx.db.patch("workspace_configurations", configuration._id, {
      snapshot: { ...configuration.snapshot, models: [model] },
    });
    return configuration._id;
  });
  await owner.mutation(anyApi.providers.setProviderModelServiceTiers, {
    workspace,
    slug: "keyed",
    model: "example",
    service_tiers: [{ id: "default", pricing: { input: "0.000002", output: "0.0000075" } }],
  });
  const saved = await t.run((ctx) => ctx.db.get("workspace_configurations", configurationId));
  expect(saved?.snapshot?.models[0]).toMatchObject({
    upstream_model_id: "custom-upstream",
    context: 272000,
    max_output: 5000,
    pricing: { input: "0.000002", output: "0.0000075" },
    service_tiers: [{ id: "default", pricing: { input: "0.000002", output: "0.0000075" } }],
  });
});
