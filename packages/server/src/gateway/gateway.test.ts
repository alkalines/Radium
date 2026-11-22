import { and, count, eq } from "drizzle-orm";
import { OPENAI_CODEX_SLUG } from "contracts/provider_slugs";
import { DEFAULT_ROUTING_SETTINGS } from "contracts/routing/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addModel, addProvider, offer } from "../../test/gateway";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { appRouter } from "../trpc/router";
import { workerGateway, workers } from "../worker/schema";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { bindOAuthCredential, unbindOAuthCredential } from "./credentials";
import { hashApiKey, resolveApiKey } from "./keys";
import { pickRoute, reportAttempt } from "./routing/state";
import {
  apiKeys,
  authors,
  credentialLimits,
  models,
  subscriptionSessions,
  workspaceCredentials,
  workspaceProviders,
} from "./schema";
import { getSecret, workspaceProviderSecretNamespace } from "./secrets";

// The Gateway's tRPC surface through the real router: owner/member/outsider/archived boundaries
// for every procedure, behavior ported from `convex/{providers,keys,routing}.test.ts`, and the
// invariants that relied on Convex serializing mutations.

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
let workspace = "";
let archived = "";

const call = (role: Role | Headers) =>
  appRouter.createCaller({
    runtime: test.runtime,
    headers: role instanceof Headers ? role : users[role].headers,
  });
const db = () => test.runtime.drivers.db;

async function addWorkspace(ownerId: string, values: Partial<typeof workspaces.$inferInsert> = {}) {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId, name: "Workspace", ...values })
    .returning();
  return row!.id;
}

async function storedValues(workspaceId: string, provider: string, credential: string) {
  const result = await getSecret(db(), test.runtime.secrets, {
    namespace: workspaceProviderSecretNamespace(workspaceId, provider),
    name: credential,
  });
  return result.ok ? JSON.parse(result.value) : null;
}

const keyedProvider = {
  slug: "keyed",
  name: "Keyed",
  npm: "@ai-sdk/openai-compatible" as const,
  env: ["API_KEY"],
  api: "https://upstream.example.test/v1",
};

const globalModel = (slug: string) => ({
  name: slug,
  slug,
  launch_date: 1_700_000_000_000,
  type: "chat" as const,
  description: `${slug} model`,
  reasoning: false,
  features: {},
  architecture: { input_modalities: ["text"], output_modalities: ["text"], tokenizer: "GPT" },
  author: { name: "Lab", slug: "lab" },
});

beforeAll(async () => {
  test = await createTestRuntime();
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `gateway-${role}@example.test`);
  }
  workspace = await addWorkspace(users.owner.id);
  archived = await addWorkspace(users.owner.id, { archivedAt: new Date() });
  for (const target of [workspace, archived]) {
    await db()
      .insert(workspaceMembers)
      .values({ workspace: target, userId: users.member.id, role: "member" });
  }
  await call("owner").providers.importProvider({
    workspace,
    provider: keyedProvider,
    models: [{ global: globalModel("lab/one"), provider: offer("lab/one") }],
  });
  await db().insert(workspaceProviders).values({
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
});

afterAll(async () => {
  await test?.close();
});

describe("authorization boundaries", () => {
  // Every owner-only procedure with valid input; members, outsiders and archived workspaces all
  // get the same NOT_FOUND, so a workspace's existence never leaks.
  const ownerOnly = (target: string) => [
    (c: ReturnType<typeof call>) => c.providers.list({ workspace: target }),
    (c: ReturnType<typeof call>) =>
      c.providers.importProvider({ workspace: target, provider: keyedProvider, models: [] }),
    (c: ReturnType<typeof call>) =>
      c.providers.setEnabled({ workspace: target, slug: "keyed", enabled: true }),
    (c: ReturnType<typeof call>) =>
      c.providers.addProviderModels({ workspace: target, slug: "keyed", models: [] }),
    (c: ReturnType<typeof call>) =>
      c.providers.setProviderModelServiceTiers({
        workspace: target,
        slug: "keyed",
        model: "lab/one",
        service_tiers: [],
      }),
    (c: ReturnType<typeof call>) =>
      c.providers.removeProviderModel({ workspace: target, slug: "keyed", model: "x" }),
    (c: ReturnType<typeof call>) => c.providers.deleteProvider({ workspace: target, slug: "none" }),
    (c: ReturnType<typeof call>) => c.providers.listCredentials({ workspace: target }),
    (c: ReturnType<typeof call>) =>
      c.providers.createCredential({
        workspace: target,
        provider: "keyed",
        credentials: { API_KEY: "sk-boundary" },
      }),
    (c: ReturnType<typeof call>) =>
      c.providers.updateCredential({ workspace: target, credential: "none", label: "x" }),
    (c: ReturnType<typeof call>) =>
      c.providers.deleteCredential({ workspace: target, provider: "keyed", credential: "none" }),
    (c: ReturnType<typeof call>) => c.keys.list({ workspace: target }),
    (c: ReturnType<typeof call>) => c.keys.create({ workspace: target, name: "k" }),
    (c: ReturnType<typeof call>) => c.keys.update({ workspace: target, key: "none", name: "k" }),
    (c: ReturnType<typeof call>) => c.keys.delete({ workspace: target, key: "none" }),
    (c: ReturnType<typeof call>) =>
      c.keys.setKeyTelemetry({ workspace: target, key: "none", telemetry: "off" }),
    (c: ReturnType<typeof call>) => c.routing.getConfiguration({ workspace: target }),
    (c: ReturnType<typeof call>) =>
      c.routing.setSettings({ workspace: target, settings: DEFAULT_ROUTING_SETTINGS }),
    (c: ReturnType<typeof call>) =>
      c.routing.setProviderRouting({
        workspace: target,
        provider: "keyed",
        routing: {
          priority: 0,
          weight: 1,
          disableCooling: false,
          modelLevelCooling: false,
          errorRules: [],
        },
      }),
    (c: ReturnType<typeof call>) => c.routing.resetCooldown({ workspace: target, provider: "keyed" }),
  ];

  it("refuses members, outsiders and archived workspaces on every owner procedure", async () => {
    for (const procedure of ownerOnly(workspace)) {
      for (const role of ["member", "outsider"] as const) {
        await expect(procedure(call(role))).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    }
    for (const procedure of ownerOnly(archived)) {
      await expect(procedure(call("owner"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    for (const procedure of ownerOnly(workspace)) {
      await expect(procedure(call(new Headers()))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("lets members read the available models, never outsiders or archived workspaces", async () => {
    const forMember = await call("member").models.availableModels({ workspace });
    expect(forMember.map((model) => model.slug)).toEqual(["lab/one"]);
    expect(forMember[0]).toMatchObject({
      author: { slug: "lab" },
      providers: [{ id: "keyed", name: "Keyed", logo: "keyed", model: "lab/one" }],
    });
    await expect(call("outsider").models.availableModels({ workspace })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      call("owner").models.availableModels({ workspace: archived }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("providers", () => {
  it("imports a snapshot, adds and removes models, never rewriting global catalogue rows", async () => {
    const owner = call("owner");
    const target = await addWorkspace(users.owner.id);
    await owner.providers.importProvider({
      workspace: target,
      provider: { ...keyedProvider, enabled: false },
      models: [
        { global: { ...globalModel("lab/one"), description: "changed" }, provider: offer("lab/one") },
      ],
    });
    const [model] = await db().select().from(models).where(eq(models.slug, "lab/one"));
    expect(model!.description).toBe("lab/one model");

    await owner.providers.addProviderModels({
      workspace: target,
      slug: "keyed",
      models: [{ global: globalModel("lab/two"), provider: offer("lab/two") }],
    });
    await expect(
      owner.providers.addProviderModels({
        workspace: target,
        slug: "keyed",
        models: [{ global: globalModel("lab/three"), provider: offer("lab/other") }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await owner.providers.removeProviderModel({ workspace: target, slug: "keyed", model: "lab/one" });
    const [listed] = await owner.providers.list({ workspace: target });
    expect(listed).toMatchObject({ slug: "keyed", enabled: false, active: true });
    expect(listed!.models.map((entry) => entry.model)).toEqual(["lab/two"]);

    await expect(
      owner.providers.importProvider({
        workspace: target,
        provider: { ...keyedProvider, slug: "no-api", api: undefined },
        models: [],
      }),
    ).rejects.toMatchObject({ message: "OpenAI-compatible providers require an api base URL." });
    await expect(
      owner.providers.setEnabled({ workspace: target, slug: "unknown", enabled: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("editing Default pricing updates the base quote and keeps model configuration", async () => {
    const owner = call("owner");
    const target = await addWorkspace(users.owner.id);
    await owner.providers.importProvider({
      workspace: target,
      provider: keyedProvider,
      models: [
        {
          global: globalModel("lab/one"),
          provider: offer("lab/one", { upstream_model_id: "custom-upstream", context: 272000 }),
        },
      ],
    });
    await owner.providers.setProviderModelServiceTiers({
      workspace: target,
      slug: "keyed",
      model: "lab/one",
      service_tiers: [{ id: "default", pricing: { input: "0.000002", output: "0.0000075" } }],
    });
    const [listed] = await owner.providers.list({ workspace: target });
    expect(listed!.models[0]).toMatchObject({
      upstream_model_id: "custom-upstream",
      context: 272000,
      pricing: { input: "0.000002", output: "0.0000075" },
      service_tiers: [{ id: "default", pricing: { input: "0.000002", output: "0.0000075" } }],
    });
    await expect(
      owner.providers.setProviderModelServiceTiers({
        workspace: target,
        slug: "keyed",
        model: "missing",
        service_tiers: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Provider model not found." });
  });

  it("deleting a provider tombstones it and removes its credentials and secrets", async () => {
    const owner = call("owner");
    const target = await addWorkspace(users.owner.id);
    await owner.providers.importProvider({ workspace: target, provider: keyedProvider, models: [] });
    const credential = await owner.providers.createCredential({
      workspace: target,
      provider: "keyed",
      credentials: { API_KEY: "sk-gone-1234" },
    });
    await owner.providers.deleteProvider({ workspace: target, slug: "keyed" });
    expect(await owner.providers.list({ workspace: target })).toEqual([]);
    expect(await owner.providers.listCredentials({ workspace: target })).toEqual([]);
    expect(await storedValues(target, "keyed", credential)).toBeNull();
    const [row] = await db()
      .select()
      .from(workspaceProviders)
      .where(and(eq(workspaceProviders.workspace, target), eq(workspaceProviders.provider, "keyed")));
    expect(row).toMatchObject({ enabled: false, active: false });
    expect(row!.deletedAt).not.toBeNull();
    // Re-importing lifts the tombstone.
    await owner.providers.importProvider({ workspace: target, provider: keyedProvider, models: [] });
    expect(await owner.providers.list({ workspace: target })).toHaveLength(1);
  });

  it("concurrent imports of one provider leave one configuration and one catalogue row", async () => {
    const target = await addWorkspace(users.owner.id);
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        call("owner").providers.importProvider({
          workspace: target,
          provider: keyedProvider,
          models: [
            {
              global: { ...globalModel(`lab/race-${index % 2}`), author: { name: "Racer", slug: "racer" } },
              provider: offer(`lab/race-${index % 2}`),
            },
          ],
        }),
      ),
    );
    const [configurations] = await db()
      .select({ count: count() })
      .from(workspaceProviders)
      .where(eq(workspaceProviders.workspace, target));
    expect(configurations!.count).toBe(1);
    const [racers] = await db().select({ count: count() }).from(authors).where(eq(authors.slug, "racer"));
    expect(racers!.count).toBe(1);
  });
});

describe("API key pools", () => {
  it("owners add, rename, disable, replace and remove several keys per provider", async () => {
    const owner = call("owner");
    const first = await owner.providers.createCredential({
      workspace,
      provider: "keyed",
      label: "  Team key  ",
      credentials: { API_KEY: "sk-first-1111" },
    });
    const second = await owner.providers.createCredential({
      workspace,
      provider: "keyed",
      priority: 2,
      weight: 3,
      credentials: { API_KEY: "sk-second-2222" },
    });
    expect(await owner.providers.listCredentials({ workspace })).toEqual([
      {
        id: first,
        provider: "keyed",
        name: "Team key",
        label: "Team key",
        preview: { API_KEY: "****1111" },
        enabled: true,
        priority: 0,
        weight: 1,
      },
      {
        id: second,
        provider: "keyed",
        name: "****2222",
        label: null,
        preview: { API_KEY: "****2222" },
        enabled: true,
        priority: 2,
        weight: 3,
      },
    ]);
    // A credential gets its limit snapshot with it.
    const [limits] = await db()
      .select({ count: count() })
      .from(credentialLimits)
      .where(eq(credentialLimits.credential, first));
    expect(limits!.count).toBe(1);

    await owner.providers.updateCredential({
      workspace,
      credential: second,
      label: "Backup",
      enabled: false,
      credentials: { API_KEY: "sk-rotated-3333" },
    });
    expect(await storedValues(workspace, "keyed", second)).toEqual({ API_KEY: "sk-rotated-3333" });
    expect(await storedValues(workspace, "keyed", first)).toEqual({ API_KEY: "sk-first-1111" });

    await owner.providers.deleteCredential({ workspace, provider: "keyed", credential: first });
    expect(await owner.providers.listCredentials({ workspace })).toMatchObject([
      { id: second, name: "Backup", preview: { API_KEY: "****3333" }, enabled: false },
    ]);
    expect(await storedValues(workspace, "keyed", first)).toBeNull();
    await owner.providers.deleteCredential({ workspace, provider: "keyed", credential: second });
  });

  it("refuses incomplete keys, OAuth providers, bad placements and foreign credentials", async () => {
    const owner = call("owner");
    await expect(
      owner.providers.createCredential({ workspace, provider: "keyed", credentials: {} }),
    ).rejects.toMatchObject({ message: "Missing required credential value: API_KEY" });
    await expect(
      owner.providers.createCredential({
        workspace,
        provider: OPENAI_CODEX_SLUG,
        credentials: {},
      }),
    ).rejects.toMatchObject({ message: "Connect ChatGPT accounts through its login flow." });
    await expect(
      owner.providers.createCredential({
        workspace,
        provider: "keyed",
        weight: -1,
        credentials: { API_KEY: "sk" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Weight must be an integer from 0 to 1000000." });

    // Another workspace's credential is unknown here.
    const other = await addWorkspace(users.outsider.id);
    const [foreign] = await addProvider(test.runtime, other, { slug: "keyed" });
    await expect(
      owner.providers.updateCredential({ workspace, credential: foreign!, label: "mine" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      owner.providers.deleteCredential({ workspace, provider: "keyed", credential: foreign! }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the pool cap exact when credentials are added concurrently", async () => {
    const target = await addWorkspace(users.owner.id);
    await call("owner").providers.importProvider({ workspace: target, provider: keyedProvider, models: [] });
    // 48 exist; 5 parallel adds may bring it to 50 and no further.
    for (let index = 0; index < 48; index++) {
      await db().insert(workspaceCredentials).values({ workspace: target, provider: "keyed", preview: {} });
    }
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        call("owner").providers.createCredential({
          workspace: target,
          provider: "keyed",
          credentials: { API_KEY: `sk-cap-${index}` },
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const [total] = await db()
      .select({ count: count() })
      .from(workspaceCredentials)
      .where(eq(workspaceCredentials.workspace, target));
    expect(total!.count).toBe(50);
  });
});

describe("OAuth account pools", () => {
  const cookie = (session: string) => `lwc_chatgpt_subscription=${session}.signature`;
  const bind = (target: string, account: string, session: string) =>
    bindOAuthCredential(test.runtime, {
      workspace: target,
      provider: OPENAI_CODEX_SLUG,
      account,
      credentials: { sessionCookie: cookie(session) },
      preview: { account: `${account}@example.test` },
    });
  const sessionExists = async (session: string) =>
    (
      await db()
        .select()
        .from(subscriptionSessions)
        .where(eq(subscriptionSessions.key, session))
    ).length > 0;

  it("logins add accounts, reconnects replace the account's session, removal ends it", async () => {
    for (const session of ["s1", "s2", "s3"]) {
      await db()
        .insert(subscriptionSessions)
        .values({ provider: OPENAI_CODEX_SLUG, key: session, value: {} });
    }
    const list = async () =>
      (await call("owner").providers.listCredentials({ workspace })).filter(
        (entry) => entry.provider === OPENAI_CODEX_SLUG,
      );

    await bind(workspace, "alice", "s1");
    await bind(workspace, "alice", "s1");
    await bind(workspace, "bob", "s2");
    expect((await list()).map((entry) => entry.name)).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);

    // Logging in to a connected account again keeps one credential and ends the old session.
    await bind(workspace, "alice", "s3");
    const accounts = await list();
    expect(accounts).toHaveLength(2);
    const alice = accounts[0]!.id;
    expect(await storedValues(workspace, OPENAI_CODEX_SLUG, alice)).toEqual({
      sessionCookie: cookie("s3"),
    });
    expect(await sessionExists("s1")).toBe(false);

    // A logged-out session unbinds only its own account.
    await unbindOAuthCredential(test.runtime, {
      workspace,
      provider: OPENAI_CODEX_SLUG,
      credentials: { sessionCookie: cookie("s2") },
    });
    expect((await list()).map((entry) => entry.id)).toEqual([alice]);

    await call("owner").providers.deleteCredential({
      workspace,
      provider: OPENAI_CODEX_SLUG,
      credential: alice,
    });
    expect(await list()).toEqual([]);
    expect(await sessionExists("s3")).toBe(false);
  });

  it("concurrent status polls of one new account create one credential", async () => {
    await Promise.all(Array.from({ length: 5 }, () => bind(workspace, "carol", "s-carol")));
    const rows = await db()
      .select()
      .from(workspaceCredentials)
      .where(and(eq(workspaceCredentials.workspace, workspace), eq(workspaceCredentials.account, "carol")));
    expect(rows).toHaveLength(1);
  });

  it("refuses API-key providers and unconfigured workspaces", async () => {
    await expect(
      bindOAuthCredential(test.runtime, {
        workspace,
        provider: "keyed",
        credentials: { sessionCookie: cookie("x") },
        preview: {},
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("routing configuration", () => {
  it("owners update settings and provider overrides; invalid values are refused", async () => {
    const owner = call("owner");
    const target = await addWorkspace(users.owner.id);
    await owner.providers.importProvider({ workspace: target, provider: keyedProvider, models: [] });
    const credential = await owner.providers.createCredential({
      workspace: target,
      provider: "keyed",
      credentials: { API_KEY: "sk-0000" },
    });
    const settings = { ...DEFAULT_ROUTING_SETTINGS, strategy: "weighted-round-robin" as const, requestRetry: 1 };
    await owner.routing.setSettings({ workspace: target, settings });
    await expect(
      owner.routing.setSettings({ workspace: target, settings: { ...settings, requestRetry: 99 } }),
    ).rejects.toMatchObject({ message: "Request retry must be an integer from 0 to 10." });

    const routing = {
      priority: 5,
      weight: 3,
      disableCooling: true,
      modelLevelCooling: false,
      errorRules: [{ status: 400, match: [], matchRegex: ["("], action: "continue" as const }],
    };
    await expect(
      owner.routing.setProviderRouting({ workspace: target, provider: "keyed", routing }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Invalid error rule regular expression") });
    await expect(
      owner.routing.setProviderRouting({
        workspace: target,
        provider: "keyed",
        routing: { ...routing, errorRules: [] },
        credentials: [{ credential, priority: 2, weight: -1 }],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Weight must be an integer") });
    // A credential of another provider or workspace is refused, and nothing is written.
    const [foreign] = await addProvider(test.runtime, await addWorkspace(users.outsider.id), {
      slug: "keyed",
    });
    await expect(
      owner.routing.setProviderRouting({
        workspace: target,
        provider: "keyed",
        routing: { ...routing, errorRules: [] },
        credentials: [{ credential: foreign!, priority: 1, weight: 1 }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await owner.routing.setProviderRouting({
      workspace: target,
      provider: "keyed",
      routing: { ...routing, errorRules: [] },
      credentials: [{ credential, priority: 2, weight: 4 }],
    });

    const configuration = await owner.routing.getConfiguration({ workspace: target });
    expect(configuration.settings).toEqual(settings);
    expect(configuration.providers).toEqual([
      {
        slug: "keyed",
        name: "Keyed",
        enabled: true,
        credentials: [{ id: credential, name: "****0000", enabled: true, priority: 2, weight: 4 }],
        routing: { ...routing, errorRules: [] },
      },
    ]);
  });

  it("removing a credential drops its cooldowns", async () => {
    const owner = call("owner");
    const target = await addWorkspace(users.owner.id);
    await addModel(test.runtime, "lab/one");
    await owner.providers.importProvider({
      workspace: target,
      provider: keyedProvider,
      models: [{ global: globalModel("lab/one"), provider: offer("lab/one") }],
    });
    const credential = await owner.providers.createCredential({
      workspace: target,
      provider: "keyed",
      credentials: { API_KEY: "sk-cool" },
    });
    await reportAttempt(test.runtime, {
      workspace: target,
      provider: "keyed",
      credential,
      model: "lab/one",
      dispatchedAt: Date.now(),
      outcome: {
        type: "failure",
        reason: "unauthorized",
        credentialScope: false,
        forceCooldown: false,
        rebindOnQuota: false,
        status: 401,
        message: "bad key",
      },
    });
    expect((await owner.routing.getConfiguration({ workspace: target })).cooldowns).toHaveLength(1);
    await owner.providers.deleteCredential({ workspace: target, provider: "keyed", credential });
    expect((await owner.routing.getConfiguration({ workspace: target })).cooldowns).toEqual([]);
    // With no credential left, routing reports the configuration error.
    await expect(
      pickRoute(test.runtime, {
        workspace: target,
        model: "lab/one",
        preferences: { allowFallbacks: true },
        excluded: [],
      }),
    ).rejects.toThrow("No BYOK credentials configured for model lab/one.");
  });
});

describe("API keys", () => {
  it("creates a key shown once, stores only its hash, lists, renames and revokes it", async () => {
    const owner = call("owner");
    const created = await owner.keys.create({ workspace, name: "  CI  " });
    expect(created.key).toMatch(/^rad-sk-[A-Za-z0-9_-]{32}$/);
    expect(created.preview).toBe(`rad-sk-…${created.key.slice(-4)}`);
    const [row] = await db().select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(row!.hash).toBe(await hashApiKey(created.key));
    expect(JSON.stringify(row)).not.toContain(created.key);

    expect(await owner.keys.list({ workspace })).toContainEqual(
      expect.objectContaining({ id: created.id, name: "CI", telemetry: "workspace", worker: null }),
    );
    await expect(owner.keys.create({ workspace, name: "  " })).rejects.toMatchObject({
      message: "Key name is required.",
    });

    const { kv } = test.runtime.drivers;
    expect(await resolveApiKey(db(), kv, created.key)).toMatchObject({
      id: created.id,
      workspace,
      userId: users.owner.id,
      name: "CI",
    });
    // A rename is visible at once, not after the cache expires.
    await owner.keys.update({ workspace, key: created.id, name: "Deploy" });
    expect(await resolveApiKey(db(), kv, created.key)).toMatchObject({ name: "Deploy" });
    await owner.keys.setKeyTelemetry({ workspace, key: created.id, telemetry: "off" });
    expect(await resolveApiKey(db(), kv, created.key)).toMatchObject({ telemetry: "off" });

    expect(await owner.keys.delete({ workspace, key: created.id })).toBe(true);
    await expect(resolveApiKey(db(), kv, created.key)).rejects.toThrow("The Authorization is invalid!");
    expect((await owner.keys.list({ workspace })).map((key) => key.id)).not.toContain(created.id);
    // Deleting again, or a key of another workspace, changes nothing.
    expect(await owner.keys.delete({ workspace, key: created.id })).toBe(true);
    await expect(
      owner.keys.update({ workspace, key: created.id, name: "back" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revoking a Worker key clears its Gateway access and resolves with the actionable error", async () => {
    const [worker] = await db()
      .insert(workers)
      .values({ workspace, name: "Build box", capabilities: [], status: "active", identityEpoch: 1 })
      .returning();
    // Issued the way the Worker slice issues them: an `api_keys` row naming the Worker.
    const key = "rad-sk-worker-issued-key-for-tests";
    const [row] = await db()
      .insert(apiKeys)
      .values({ workspace, name: "Worker key", hash: await hashApiKey(key), worker: worker!.id })
      .returning();
    await db().insert(workerGateway).values({
      worker: worker!.id,
      access: "active",
      telemetry: "workspace",
      apiKey: row!.id,
      updatedAt: new Date(),
    });
    const { kv } = test.runtime.drivers;
    expect(await resolveApiKey(db(), kv, key)).toMatchObject({ worker: worker!.id, workspace });
    expect(await call("owner").keys.list({ workspace })).toContainEqual(
      expect.objectContaining({ id: row!.id, worker: { id: worker!.id, name: "Build box" } }),
    );
    await expect(
      call("owner").keys.setKeyTelemetry({ workspace, key: row!.id, telemetry: "off" }),
    ).rejects.toMatchObject({
      message: "Set Gateway telemetry for this key on its Worker in Settings → Workers.",
    });

    await call("owner").keys.delete({ workspace, key: row!.id });
    const [access] = await db()
      .select()
      .from(workerGateway)
      .where(eq(workerGateway.worker, worker!.id));
    expect(access).toMatchObject({ access: "missing", apiKey: null });
    await expect(resolveApiKey(db(), kv, key)).rejects.toThrow(
      "The Gateway key of Worker Build box was deleted. The workspace owner can issue a new key in Settings → Workers.",
    );
  });

  it("stops resolving a cached key once its workspace is archived", async () => {
    const target = await addWorkspace(users.owner.id);
    const { key } = await call("owner").keys.create({ workspace: target, name: "soon archived" });
    const { kv } = test.runtime.drivers;
    await resolveApiKey(db(), kv, key);
    await call("owner").workspaces.archive({ workspace: target });
    await expect(resolveApiKey(db(), kv, key)).rejects.toThrow("The Authorization is invalid!");
  });

  it("a resolution racing a revoke never caches the revoked key", async () => {
    const { key, id } = await call("owner").keys.create({ workspace, name: "racy" });
    const { kv } = test.runtime.drivers;
    // A resolution that read the key as active, then stalls before caching it until the revoke
    // has committed and invalidated the cache.
    const { promise: revoked, resolve: release } = Promise.withResolvers<void>();
    const { promise: stalled, resolve: reachedSet } = Promise.withResolvers<void>();
    const stalling = {
      async send(command: string, args: string[]) {
        if (command === "SET") {
          reachedSet();
          await revoked;
        }
        return await kv.send(command, args);
      },
    };
    const racing = resolveApiKey(db(), stalling, key);
    await stalled;
    await call("owner").keys.delete({ workspace, key: id });
    release();
    await racing;
    await expect(resolveApiKey(db(), kv, key)).rejects.toThrow("The Authorization is invalid!");
  });
});
