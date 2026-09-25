/// <reference types="vite/client" />

import { register as registerMigrations } from "@convex-dev/migrations/test";
import { register as registerSecretStore } from "convex-secret-store/test";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import schema from "./schema";
import { hashText } from "./key";
import {
  MCP_SECRET_NAME,
  mcpSecretNamespace,
  secrets,
  workspaceMcpSecretNamespace,
} from "./secrets";

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
  };
});

vi.mock("@convex-dev/better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/better-auth")>()),
  createClient: () => authMock,
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

function asUser(t: ReturnType<typeof makeTest>, userId: string) {
  return t.withIdentity({
    tokenIdentifier: userId,
    subject: userId,
    email: `${userId}@example.invalid`,
    name: userId,
  });
}

test("lists unmigrated legacy keys and revokes a legacy mapping atomically", async () => {
  const t = makeTest();
  const hashes = {
    legacyOnly: await hashText("legacy-only-secret"),
    revokedLegacy: await hashText("revoked-legacy-secret"),
    mapped: await hashText("mapped-secret"),
    workspace: await hashText("workspace-secret"),
    revokedWorkspace: await hashText("revoked-workspace-secret"),
  };
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", { credits: 100, userId: "owner" });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Legacy workspace",
      legacyBalance: balance,
    });
    const legacyOnly = await ctx.db.insert("keys", {
      balance,
      usedCredits: 0,
      name: "Legacy only",
      hash: hashes.legacyOnly,
      preview: "rad-sk-...only",
    });
    const revokedLegacy = await ctx.db.insert("keys", {
      balance,
      usedCredits: 0,
      name: "Revoked legacy",
      hash: hashes.revokedLegacy,
      revokedAt: 1,
      preview: "rad-sk-...oked",
    });
    const mappedLegacy = await ctx.db.insert("keys", {
      balance,
      usedCredits: 0,
      name: "Mapped legacy",
      hash: hashes.mapped,
      preview: "rad-sk-...pped",
    });
    const mappedApi = await ctx.db.insert("api_keys", {
      workspace,
      name: "Mapped workspace",
      hash: hashes.mapped,
      preview: "rad-sk-...pped",
      legacyKey: mappedLegacy,
    });
    const workspaceKey = await ctx.db.insert("api_keys", {
      workspace,
      name: "Workspace key",
      hash: hashes.workspace,
      preview: "rad-sk-...pace",
    });
    const revokedWorkspace = await ctx.db.insert("api_keys", {
      workspace,
      name: "Revoked workspace",
      hash: hashes.revokedWorkspace,
      revokedAt: 1,
      preview: "rad-sk-...oked",
    });
    return {
      balance,
      workspace,
      legacyOnly,
      revokedLegacy,
      mappedLegacy,
      mappedApi,
      workspaceKey,
      revokedWorkspace,
    };
  });

  const owner = asUser(t, "owner");
  const listed = await owner.query(anyApi.keys.listKeys, { workspace: ids.workspace });
  expect(listed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "legacy", _id: ids.legacyOnly }),
      expect.objectContaining({ source: "workspace", _id: ids.mappedApi }),
      expect.objectContaining({ source: "workspace", _id: ids.workspaceKey }),
    ]),
  );
  expect(listed).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ _id: ids.revokedLegacy }),
      expect.objectContaining({ _id: ids.mappedLegacy }),
      expect.objectContaining({ _id: ids.revokedWorkspace }),
    ]),
  );

  await expect(
    asUser(t, "outsider").mutation(anyApi.keys.deleteLegacyKey, {
      workspace: ids.workspace,
      keyId: ids.legacyOnly,
    }),
  ).rejects.toThrow("Workspace not found.");

  await owner.mutation(anyApi.keys.deleteLegacyKey, {
    workspace: ids.workspace,
    keyId: ids.mappedLegacy,
  });
  const revocations = await t.run(async (ctx) => {
    const legacy = await ctx.db.get("keys", ids.mappedLegacy);
    const workspace = await ctx.db.get("api_keys", ids.mappedApi);
    return { legacy: legacy?.revokedAt, workspace: workspace?.revokedAt };
  });
  expect(revocations.legacy).toBeDefined();
  expect(revocations.workspace).toBe(revocations.legacy);
  await expect(t.query(anyApi.key.getKeyInfo, { key: "mapped-secret" })).rejects.toThrow(
    "This key is invalid!",
  );
});

test("uses only matching default legacy telemetry and materializes complete settings", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const defaultWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Default workspace",
    });
    const otherWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Other workspace",
    });
    await ctx.db.insert("chatroom_settings", {
      userId: "owner",
      defaultModel: "legacy-model",
      titleModel: "legacy-title-model",
      enableChainOfThought: false,
      telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
      builtinToolSets: ["legacy-tool"],
      mcpServers: [],
    });
    await ctx.db.insert("workspace_settings", {
      workspace: otherWorkspace,
      defaultModel: "current-model",
      builtinToolSets: [],
      mcpServers: [],
    });
    return { defaultWorkspace, otherWorkspace };
  });

  const owner = asUser(t, "owner");
  const expectedLegacyTelemetry = { enabled: true, recordInputs: true, recordOutputs: true };
  expect(
    await owner.query(anyApi.telemetry.getSettings, { workspace: ids.defaultWorkspace }),
  ).toEqual(expectedLegacyTelemetry);
  expect(await t.query(anyApi.telemetry.getSettingsForUser, { userId: "owner" })).toEqual(
    expectedLegacyTelemetry,
  );
  expect(
    await t.query(anyApi.telemetry.getSettingsForWorkspace, { workspace: ids.defaultWorkspace }),
  ).toEqual(expectedLegacyTelemetry);

  const defaults = { enabled: false, recordInputs: false, recordOutputs: false };
  expect(
    await owner.query(anyApi.telemetry.getSettings, { workspace: ids.otherWorkspace }),
  ).toEqual(defaults);
  expect(
    await t.query(anyApi.telemetry.getSettingsForWorkspace, { workspace: ids.otherWorkspace }),
  ).toEqual(defaults);

  await owner.mutation(anyApi.telemetry.setSettings, {
    workspace: ids.defaultWorkspace,
    enabled: false,
    recordInputs: true,
    recordOutputs: true,
  });
  const materialized = await t.run(
    async (ctx) =>
      await ctx.db
        .query("workspace_settings")
        .withIndex("by_workspace", (q) => q.eq("workspace", ids.defaultWorkspace))
        .unique(),
  );
  expect(materialized).toMatchObject({
    workspace: ids.defaultWorkspace,
    defaultModel: "legacy-model",
    titleModel: "legacy-title-model",
    enableChainOfThought: false,
    builtinToolSets: ["legacy-tool"],
    mcpServers: [],
    telemetry: defaults,
  });
});

test("separates historical credit activity from BYOK estimates", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", { credits: 100, userId: "owner" });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Activity workspace",
      legacyBalance: balance,
    });
    const author = await ctx.db.insert("authors", { name: "Test", slug: "test" });
    const model = await ctx.db.insert("models", {
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
    const legacyKey = await ctx.db.insert("keys", {
      balance,
      usedCredits: 0,
      name: "Legacy key",
      hash: "legacy-hash",
      preview: "rad-sk-...gacy",
    });
    const apiKey = await ctx.db.insert("api_keys", {
      workspace,
      name: "BYOK key",
      hash: "api-hash",
      preview: "rad-sk-...byok",
    });
    const response = (cost: number, tokens: number) => ({
      genId: `gen-${cost}`,
      providerGenId: `provider-${cost}`,
      usage: {
        prompt_tokens: tokens,
        completion_tokens: tokens,
        completion_tokens_details: { reasoning_tokens: 0 },
        prompt_tokens_details: { cached_tokens: 0, written_cache_tokens: 0 },
      },
      pricing: {
        prompt_tokens: tokens,
        completion_tokens: tokens,
        prompt_tokens_details: { cached_tokens: 0 },
        cost,
      },
      ttft: 1,
      gen_time: 2,
      finish_reason: "stop",
    });
    await ctx.db.insert("chat_completions", {
      bill: { workspace, balance, key: legacyKey },
      request: { provider: "legacy", byok: false, model, streamed: false, canceled: false },
      response: response(3, 1),
    });
    await ctx.db.insert("chat_completions", {
      bill: { workspace, apiKey },
      request: { provider: "byok", byok: true, model, streamed: false, canceled: false },
      response: response(7, 2),
    });
    return { workspace, legacyKey, apiKey };
  });

  const owner = asUser(t, "owner");
  const activity = await owner.query(anyApi.logs.getActivity, {
    workspace: ids.workspace,
    since: 0,
  });
  expect(activity.summary.requests).toBe(2);
  expect(activity.usageTypes).toMatchObject({
    byok: { requests: 1, cost: 7 },
    legacyCredits: { requests: 1, cost: 3 },
  });
  expect(activity.apiKeys).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: `legacy:${ids.legacyKey}`, name: "Legacy key" }),
      expect.objectContaining({ id: `api:${ids.apiKey}`, name: "BYOK key" }),
    ]),
  );

  const usage = await owner.query(anyApi.usage.getUsage, { workspace: ids.workspace });
  expect(usage.completions).toBe(2);
  expect(usage.recent.map((completion: { byok: boolean }) => completion.byok)).toEqual([
    true,
    false,
  ]);
});

test("migrates explicit chat history after its creator loses membership", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Shared workspace",
    });
    await ctx.db.insert("workspace_members", {
      workspace,
      userId: "member",
      role: "member",
    });
    const chat = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      messages: [],
      chat_completions: [],
      activeStream: false,
      lastInteractionAt: 1,
    });
    const trace = await ctx.db.insert("telemetry_traces", {
      workspace,
      userId: "member",
      chatId: chat,
      source: "chatroom",
      requestId: "member-request",
      callId: "member-call",
      operationId: "member-operation",
      functionId: "member-function",
      provider: "provider",
      model: "model",
      status: "ok",
      startedAt: 1,
      recordsInputs: false,
      recordsOutputs: false,
    });
    const span = await ctx.db.insert("telemetry_spans", {
      trace,
      kind: "model",
      name: "model",
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    });
    const membership = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_userId", (q) =>
        q.eq("workspace", workspace).eq("userId", "member"),
      )
      .unique();
    if (!membership) throw new Error("membership fixture missing");
    await ctx.db.delete("workspace_members", membership._id);
    return { workspace, chat, trace, span };
  });

  await expect(t.mutation(anyApi.migrations.chatsToWorkspaces, oneBatch)).resolves.toMatchObject({
    processed: 1,
    isDone: true,
  });
  await expect(t.mutation(anyApi.migrations.tracesToWorkspaces, oneBatch)).resolves.toMatchObject({
    processed: 1,
    isDone: true,
  });
  await expect(t.mutation(anyApi.migrations.spansToWorkspaces, oneBatch)).resolves.toMatchObject({
    processed: 1,
    isDone: true,
  });
  const span = await t.run((ctx) => ctx.db.get("telemetry_spans", ids.span));
  expect(span?.workspace).toBe(ids.workspace);
  expect((await t.run((ctx) => ctx.db.get("aisdk_chats", ids.chat)))?.workspace).toBe(
    ids.workspace,
  );

  const paginationOpts = { numItems: 25, cursor: null };
  expect((await t.query(anyApi.migrations.verifyChats, { paginationOpts })).pageClean).toBe(true);
  expect((await t.query(anyApi.migrations.verifyTraces, { paginationOpts })).pageClean).toBe(true);
  expect((await t.query(anyApi.migrations.verifySpans, { paginationOpts })).pageClean).toBe(true);
});

test("keeps legacy span migration restricted to the balance owner", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", { credits: 0, userId: "owner" });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Legacy workspace",
      legacyBalance: balance,
    });
    await ctx.db.insert("workspace_members", {
      workspace,
      userId: "member",
      role: "member",
    });
    const trace = await ctx.db.insert("telemetry_traces", {
      workspace,
      balance,
      userId: "member",
      source: "gateway",
      requestId: "legacy-request",
      callId: "legacy-call",
      operationId: "legacy-operation",
      functionId: "legacy-function",
      provider: "provider",
      model: "model",
      status: "ok",
      startedAt: 1,
      recordsInputs: false,
      recordsOutputs: false,
    });
    const span = await ctx.db.insert("telemetry_spans", {
      trace,
      balance,
      kind: "model",
      name: "model",
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    });
    return { span };
  });

  await expect(t.mutation(anyApi.migrations.spansToWorkspaces, oneBatch)).rejects.toThrow(
    "legacy span trace does not match its balance owner",
  );
  const span = await t.run((ctx) => ctx.db.get("telemetry_spans", ids.span));
  expect(span?.workspace).toBeUndefined();
});

test("verification reports duplicate workspace credential metadata", async () => {
  const t = makeTest();
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Credential workspace",
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("workspace_credentials", {
      workspace,
      provider: "provider",
      preview: {},
    });
    await ctx.db.insert("workspace_credentials", {
      workspace,
      provider: "provider",
      preview: {},
    });
  });

  const result = await t.query(anyApi.migrations.verifyWorkspaceCredentials, {
    paginationOpts: { numItems: 25, cursor: null },
  });
  expect(result.issues.credential_metadata_duplicate).toBe(2);
});

test("workspace credential migration fails before using duplicate metadata", async () => {
  const t = makeTest();
  await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", { credits: 0, userId: "owner" });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Duplicate workspace",
      legacyBalance: balance,
    });
    await ctx.db.insert("providers", {
      slug: "provider",
      name: "Provider",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      enabled: true,
      models: [],
    });
    await ctx.db.insert("workspace_configurations", {
      workspace,
      provider: "provider",
      enabled: true,
      active: true,
      snapshot: {
        slug: "provider",
        name: "Provider",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: [],
      },
    });
    await ctx.db.insert("workspace_credentials", {
      workspace,
      provider: "provider",
      preview: {},
    });
    await ctx.db.insert("workspace_credentials", {
      workspace,
      provider: "provider",
      preview: {},
    });
  });

  await expect(t.mutation(anyApi.migrations.workspaceCredentials, oneBatch)).rejects.toThrow(
    "duplicate provider credential metadata",
  );
});

test("does not copy stale MCP secrets for servers without bearer auth", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "MCP workspace",
    });
    const server = await ctx.db.insert("mcp_servers", {
      userId: "owner",
      name: "Unauthenticated server",
      url: "https://mcp.example.invalid",
      transport: "http",
      auth: { type: "none" },
    });
    await secrets.put(ctx, {
      namespace: mcpSecretNamespace(server),
      name: MCP_SECRET_NAME,
      value: "stale-token",
      metadata: { kind: "mcp", mcpServer: server },
    });
    return { workspace, server };
  });

  await expect(
    t.mutation(anyApi.migrations.mcpServersToWorkspaces, oneBatch),
  ).resolves.toMatchObject({
    processed: 1,
    isDone: true,
  });
  const stored = await t.run(async (ctx) => ({
    server: await ctx.db.get("mcp_servers", ids.server),
    source: await secrets.get(ctx, {
      namespace: mcpSecretNamespace(ids.server),
      name: MCP_SECRET_NAME,
    }),
    destination: await secrets.get(ctx, {
      namespace: workspaceMcpSecretNamespace(ids.workspace, ids.server),
      name: MCP_SECRET_NAME,
    }),
  }));
  expect(stored.server?.workspace).toBe(ids.workspace);
  expect(stored.source.ok).toBe(true);
  expect(stored.destination).toEqual({ ok: false, reason: "not_found" });
  const listed = await asUser(t, "owner").query(anyApi.mcp.listServers, {
    workspace: ids.workspace,
  });
  expect(listed).toEqual([
    expect.objectContaining({ _id: ids.server, auth: { type: "none" }, hasSecret: false }),
  ]);
});

test("MCP metadata reads and updates require recovery for unusable bearer tokens", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "MCP recovery workspace",
    });
    const server = await ctx.db.insert("mcp_servers", {
      userId: "owner",
      workspace,
      name: "Bearer server",
      url: "https://mcp.example.invalid",
      transport: "http",
      auth: { type: "bearer" },
    });
    return { workspace, server };
  });

  const getSecret = vi.spyOn(secrets, "get");
  try {
    for (const reason of ["expired", "key_unavailable"] as const) {
      getSecret.mockClear();
      getSecret.mockResolvedValue({ ok: false, reason });
      await expect(
        asUser(t, "owner").query(anyApi.mcp.listServers, { workspace: ids.workspace }),
      ).rejects.toThrow("Secret Store recovery required");
      expect(getSecret).toHaveBeenCalledTimes(1);
      await expect(
        asUser(t, "owner").mutation(anyApi.mcp.updateServer, {
          workspace: ids.workspace,
          server: ids.server,
          auth: { type: "bearer" },
        }),
      ).rejects.toThrow("Secret Store recovery required");
      expect(getSecret).toHaveBeenCalledTimes(2);
    }
  } finally {
    getSecret.mockRestore();
  }
});
