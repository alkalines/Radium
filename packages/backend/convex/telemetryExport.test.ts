/// <reference types="vite/client" />

import { register as registerSecretStore } from "convex-secret-store/test";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { isSampled } from "../src/telemetry/otlp";
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
const fetchMock = vi.fn();
const exportApi = anyApi.observability.telemetryExport;

beforeAll(() => {
  process.env.SECRET_STORE_KEYS = `1:${Buffer.alloc(32, 1).toString("base64")}`;
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (previousSecretStoreKeys === undefined) delete process.env.SECRET_STORE_KEYS;
  else process.env.SECRET_STORE_KEYS = previousSecretStoreKeys;
});

afterEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
});

async function setup() {
  fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
  const t = convexTest({ schema, modules });
  registerSecretStore(t);
  const ids = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Export workspace",
    });
    const keyA = await ctx.db.insert("api_keys", { workspace, name: "A", hash: "hash-a" });
    const keyB = await ctx.db.insert("api_keys", { workspace, name: "B", hash: "hash-b" });
    const otherWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "stranger",
      name: "Other",
    });
    const foreignKey = await ctx.db.insert("api_keys", {
      workspace: otherWorkspace,
      name: "Foreign",
      hash: "hash-f",
    });
    return { workspace, keyA, keyB, foreignKey };
  });
  return {
    t,
    ...ids,
    owner: t.withIdentity({ tokenIdentifier: "owner" }),
    outsider: t.withIdentity({ tokenIdentifier: "stranger" }),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Insert a captured gateway request, optionally in a session and attributed to an API key. */
async function insertRequest(
  { t, workspace }: Pick<Setup, "t" | "workspace">,
  options: { requestId: string; sessionKey?: string; apiKey?: Id<"api_keys"> },
) {
  return await t.run(async (ctx) => {
    const session = options.sessionKey
      ? await ctx.db.insert("telemetry_sessions", {
          workspace,
          key: options.sessionKey,
          startedAt: 1,
        })
      : undefined;
    return await ctx.db.insert("telemetry_requests", {
      workspace,
      requestId: options.requestId,
      source: "gateway",
      apiKey: options.apiKey,
      session,
      model: "test-model",
      provider: "test-provider",
      stream: false,
      status: "ok",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_500,
      durationMs: 500,
      attempts: [],
      recordsInputs: false,
      recordsOutputs: false,
      lineage: { kind: "root" },
    });
  });
}

function sentUrls() {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe("destination management", () => {
  test("owners manage destinations and header values are never returned", async () => {
    const { owner, t, workspace, keyA } = await setup();
    const secretValue = "Bearer super-secret-token";

    const id = await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "otlp",
      name: "  Collector  ",
      endpoint: "https://otel.example.com",
      headers: { Authorization: secretValue },
      includeApiKeys: [keyA],
    });

    const listed = await owner.query(exportApi.listDestinations, { workspace });
    expect(listed).toEqual([
      {
        _id: id,
        kind: "otlp",
        name: "Collector",
        endpoint: "https://otel.example.com",
        enabled: true,
        privacyMode: false,
        samplingRate: 1,
        includeApiKeys: [keyA],
        excludeApiKeys: [],
        hasHeaders: true,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(secretValue);
    const raw = await t.run((ctx) => ctx.db.get("telemetry_destinations", id));
    expect(JSON.stringify(raw)).not.toContain(secretValue);

    // Omitted headers keep the stored secret; an empty map clears it.
    await owner.mutation(exportApi.updateDestination, {
      workspace,
      destination: id,
      name: "Renamed",
      enabled: false,
    });
    expect(await owner.query(exportApi.listDestinations, { workspace })).toMatchObject([
      { name: "Renamed", enabled: false, hasHeaders: true },
    ]);
    await owner.mutation(exportApi.updateDestination, { workspace, destination: id, headers: {} });
    expect(await owner.query(exportApi.listDestinations, { workspace })).toMatchObject([
      { hasHeaders: false },
    ]);

    await owner.mutation(exportApi.deleteDestination, { workspace, destination: id });
    expect(await owner.query(exportApi.listDestinations, { workspace })).toEqual([]);
  });

  test("rejects non-owners, insecure endpoints, bad sampling, and foreign API keys", async () => {
    const { owner, outsider, workspace, foreignKey } = await setup();
    const base = { workspace, kind: "webhook" as const, name: "Hook" };

    await expect(
      outsider.mutation(exportApi.createDestination, {
        ...base,
        endpoint: "https://hooks.example.com",
      }),
    ).rejects.toThrow();
    await expect(outsider.query(exportApi.listDestinations, { workspace })).rejects.toThrow();

    await expect(
      owner.mutation(exportApi.createDestination, {
        ...base,
        endpoint: "http://hooks.example.com",
      }),
    ).rejects.toThrow("https");
    await expect(
      owner.mutation(exportApi.createDestination, {
        ...base,
        endpoint: "https://hooks.example.com",
        samplingRate: 1.5,
      }),
    ).rejects.toThrow("Sampling");
    await expect(
      owner.mutation(exportApi.createDestination, {
        ...base,
        endpoint: "https://hooks.example.com",
        excludeApiKeys: [foreignKey],
      }),
    ).rejects.toThrow("Unknown API key");

    // Loopback http is allowed.
    await owner.mutation(exportApi.createDestination, {
      ...base,
      endpoint: "http://localhost:4318",
    });
  });

  test("cannot modify a destination through another workspace", async () => {
    const { owner, outsider, t, workspace } = await setup();
    const id = await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "webhook",
      name: "Hook",
      endpoint: "https://hooks.example.com",
    });
    const otherWorkspace = await t.run(async (ctx) => {
      const rows = await ctx.db.query("workspaces").collect();
      return rows.find((row) => row.ownerId === "stranger")!._id;
    });

    await expect(
      outsider.mutation(exportApi.deleteDestination, {
        workspace: otherWorkspace,
        destination: id,
      }),
    ).rejects.toThrow("not found");
    expect(await owner.query(exportApi.listDestinations, { workspace })).toHaveLength(1);
  });
});

describe("deliver", () => {
  test("posts OTLP to /v1/traces with stored headers and records the delivery", async () => {
    const setupResult = await setup();
    const { owner, t, workspace } = setupResult;
    const destination = await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "otlp",
      name: "Collector",
      endpoint: "https://otel.example.com",
      headers: { "x-api-key": "k-123" },
    });
    const request = await insertRequest(setupResult, { requestId: "req-1", sessionKey: "s1" });

    await t.action(exportApi.deliver, { request });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://otel.example.com/v1/traces");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-api-key": "k-123",
    });
    const body = JSON.parse(init.body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("chat test-model");

    const row = await t.run((ctx) => ctx.db.get("telemetry_destinations", destination));
    expect(row?.lastDeliveryAt).toBeTypeOf("number");
    expect(row?.lastError).toBeUndefined();
  });

  test("posts webhooks to the endpoint as-is and records failures without throwing", async () => {
    const setupResult = await setup();
    const { owner, t, workspace } = setupResult;
    const destination = await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "webhook",
      name: "Hook",
      endpoint: "https://hooks.example.com/in",
      headers: { authorization: "Bearer hidden" },
    });
    const request = await insertRequest(setupResult, { requestId: "req-1" });
    fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));

    await expect(t.action(exportApi.deliver, { request })).resolves.toBeNull();

    expect(sentUrls()).toEqual(["https://hooks.example.com/in"]);
    const row = await t.run((ctx) => ctx.db.get("telemetry_destinations", destination));
    expect(row?.lastError).toBe("HTTP 500");
    expect(JSON.stringify(row)).not.toContain("Bearer hidden");

    fetchMock.mockImplementation(async () => {
      throw new Error("connect refused");
    });
    await expect(t.action(exportApi.deliver, { request })).resolves.toBeNull();
    const failed = await t.run((ctx) => ctx.db.get("telemetry_destinations", destination));
    expect(failed?.lastError).toBe("connect refused");
  });

  test("honors API key include and exclude lists, with exclude winning", async () => {
    const setupResult = await setup();
    const { owner, workspace, keyA, keyB, t } = setupResult;
    const create = (name: string, extra: Record<string, unknown>) =>
      owner.mutation(exportApi.createDestination, {
        workspace,
        kind: "webhook",
        name,
        endpoint: `https://${name}.example.com`,
        ...extra,
      });
    await create("all", {});
    await create("only-a", { includeApiKeys: [keyA] });
    await create("not-a", { excludeApiKeys: [keyA] });
    await create("a-both", { includeApiKeys: [keyA], excludeApiKeys: [keyA] });

    const requestA = await insertRequest(setupResult, { requestId: "ra", apiKey: keyA });
    await t.action(exportApi.deliver, { request: requestA });
    expect(sentUrls().sort()).toEqual(["https://all.example.com/", "https://only-a.example.com/"]);

    fetchMock.mockClear();
    const requestB = await insertRequest(setupResult, { requestId: "rb", apiKey: keyB });
    await t.action(exportApi.deliver, { request: requestB });
    expect(sentUrls().sort()).toEqual(["https://all.example.com/", "https://not-a.example.com/"]);

    // A request without an API key never matches a non-empty include list.
    fetchMock.mockClear();
    const requestNone = await insertRequest(setupResult, { requestId: "rn" });
    await t.action(exportApi.deliver, { request: requestNone });
    expect(sentUrls().sort()).toEqual(["https://all.example.com/", "https://not-a.example.com/"]);
  });

  test("samples whole sessions deterministically and skips disabled destinations", async () => {
    const setupResult = await setup();
    const { owner, workspace, t } = setupResult;
    const rate = 0.5;
    const keys = Array.from({ length: 40 }, (_, index) => `session-${index}`);
    const decisions = await Promise.all(keys.map((key) => isSampled(key, rate)));
    const kept = keys[decisions.indexOf(true)];
    const dropped = keys[decisions.indexOf(false)];

    await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "webhook",
      name: "sampled",
      endpoint: "https://sampled.example.com",
      samplingRate: rate,
    });
    const disabled = await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "webhook",
      name: "off",
      endpoint: "https://off.example.com",
      enabled: false,
    });
    expect(disabled).toBeDefined();

    const keptFirst = await insertRequest(setupResult, { requestId: "k1", sessionKey: kept });
    const keptSecond = await insertRequest(setupResult, { requestId: "k2", sessionKey: kept });
    const droppedRequest = await insertRequest(setupResult, {
      requestId: "d1",
      sessionKey: dropped,
    });

    await t.action(exportApi.deliver, { request: droppedRequest });
    expect(fetchMock).not.toHaveBeenCalled();

    await t.action(exportApi.deliver, { request: keptFirst });
    await t.action(exportApi.deliver, { request: keptSecond });
    expect(sentUrls()).toEqual(["https://sampled.example.com/", "https://sampled.example.com/"]);
  });

  test("privacy mode strips content from the payload", async () => {
    const setupResult = await setup();
    const { owner, workspace, t } = setupResult;
    await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "webhook",
      name: "private",
      endpoint: "https://private.example.com",
      privacyMode: true,
    });
    const request = await insertRequest(setupResult, { requestId: "p1" });
    await t.run(async (ctx) => {
      const system = await ctx.db.insert("telemetry_blobs", {
        workspace,
        hash: "sys",
        kind: "system",
        size: 10,
        content: JSON.stringify([{ role: "system", content: "TOP SECRET" }]),
      });
      await ctx.db.patch("telemetry_requests", request, { system, recordsInputs: true });
    });

    await t.action(exportApi.deliver, { request });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).not.toContain("TOP SECRET");
    expect(body).not.toContain("gen_ai.system_instructions");
  });
});

describe("testDestination", () => {
  test("sends a synthetic span for owners only", async () => {
    const { owner, outsider, workspace } = await setup();
    const destination = await owner.mutation(exportApi.createDestination, {
      workspace,
      kind: "otlp",
      name: "Collector",
      endpoint: "https://otel.example.com/v1/traces",
    });

    const result = await owner.action(exportApi.testDestination, { workspace, destination });
    expect(result).toEqual({ ok: true });
    expect(sentUrls()).toEqual(["https://otel.example.com/v1/traces"]);

    await expect(
      outsider.action(exportApi.testDestination, { workspace, destination }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => new Response(null, { status: 502 }));
    expect(await owner.action(exportApi.testDestination, { workspace, destination })).toEqual({
      ok: false,
      error: "HTTP 502",
    });
  });
});
