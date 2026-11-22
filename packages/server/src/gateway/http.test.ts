import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addModel,
  addProvider,
  offer,
  setRouting,
  upstreamError,
  upstreamStream,
} from "../../test/gateway";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { chats } from "../chatroom/schema";
import { jobs } from "../jobs/schema";
import { telemetryRequests } from "../telemetry/schema";
import { appRouter } from "../trpc/router";
import { chatCompletions } from "../usage/schema";
import { workers } from "../worker/schema";
import { updateWorkspaceSettings } from "../workspaces/settings";
import { workspaces } from "../workspaces/schema";
import { createInternalGatewayProvider, type SettledGeneration } from "./completions";
import { hashApiKey } from "./keys";
import { apiKeys, workspaceCredentials } from "./schema";

// `/api/openai/v1/*` through the Hono app with a stubbed upstream: key boundaries, the Convex
// error shapes, streaming and non-streaming completions with their side effects.

const MODEL = "test-model";
let test: TestRuntime;
let ownerId = "";
let workspace = "";
let key = "";
let keyId = "";
/** Upstream requests the stub received (URL and the API key header). */
let upstreamCalls: Array<{ url: string; authorization: string | null }> = [];
let upstream: (url: string) => Response | Promise<Response>;

async function newWorkspace() {
  const [row] = await test.runtime.drivers.db
    .insert(workspaces)
    .values({ ownerId, name: "Gateway" })
    .returning();
  return row!.id;
}

async function newKey(target: string) {
  const created = await appRouter
    .createCaller({ runtime: test.runtime, headers: ownerHeaders })
    .keys.create({ workspace: target, name: "test key" });
  return created;
}

let ownerHeaders: Headers;

beforeAll(async () => {
  test = await createTestRuntime();
  const owner = await classicUser(test.runtime, "http-owner@example.test");
  ownerId = owner.id;
  ownerHeaders = owner.headers;
  await addModel(test.runtime, MODEL);
  workspace = await newWorkspace();
  await addProvider(test.runtime, workspace, { slug: "first", models: [offer(MODEL)] });
  await addProvider(test.runtime, workspace, {
    slug: "second",
    models: [offer(MODEL)],
    routing: { priority: -1 },
  });
  await setRouting(test.runtime, workspace, { strategy: "fill-first", requestRetry: 0 });
  ({ key, id: keyId } = await newKey(workspace));
  const stub = async (input: string | URL, init?: RequestInit) => {
    const request = new Request(String(input), init);
    upstreamCalls.push({ url: request.url, authorization: request.headers.get("authorization") });
    return await upstream(request.url);
  };
  // The stub is the network: every upstream call of the runtime goes through it.
  test.runtime.fetch = stub as typeof fetch;
});

beforeEach(async () => {
  upstreamCalls = [];
  upstream = () => upstreamStream(["Hello", " world"]);
  // Each test starts without cooldowns.
  await test.runtime.drivers.kv.send("DEL", [`routing:cooldowns:${workspace}`]);
});

afterAll(async () => {
  await test?.close();
});

function completion(body: object, options: { key?: string | null; headers?: object } = {}) {
  const bearer = options.key === undefined ? key : options.key;
  return test.app.request("/api/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

const ask = { model: MODEL, messages: [{ role: "user", content: "Hello" }] };

async function completionsOf(target: string) {
  return await test.runtime.drivers.db
    .select()
    .from(chatCompletions)
    .where(eq(chatCompletions.workspace, target));
}

describe("Gateway key boundaries", () => {
  it("refuses missing, unknown, revoked and archived-workspace keys with 401", async () => {
    for (const path of ["/api/openai/v1/models", "/api/openai/v1/chat/completions"]) {
      const method = path.endsWith("models") ? "GET" : "POST";
      const send = (authorization?: string) =>
        test.app.request(path, {
          method,
          headers: authorization ? { authorization } : {},
          ...(method === "POST" ? { body: JSON.stringify(ask) } : {}),
        });
      const missing = await send();
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({
        error: { message: "The Authorization field is empty!", code: 401 },
      });
      const unknown = await send("Bearer rad-sk-unknown");
      expect(unknown.status).toBe(401);
      expect(await unknown.json()).toEqual({
        error: { message: "The Authorization is invalid!", code: 401 },
      });
    }
    expect(upstreamCalls).toEqual([]);

    const revoked = await newKey(workspace);
    await appRouter
      .createCaller({ runtime: test.runtime, headers: ownerHeaders })
      .keys.delete({ workspace, key: revoked.id });
    expect((await completion(ask, { key: revoked.key })).status).toBe(401);

    const archivedWorkspace = await newWorkspace();
    const archivedKey = await newKey(archivedWorkspace);
    await test.runtime.drivers.db
      .update(workspaces)
      .set({ archivedAt: new Date() })
      .where(eq(workspaces.id, archivedWorkspace));
    expect((await completion(ask, { key: archivedKey.key })).status).toBe(401);
    expect(upstreamCalls).toEqual([]);
  });

  it("answers a deleted Worker key with the actionable message", async () => {
    const [worker] = await test.runtime.drivers.db
      .insert(workers)
      .values({ workspace, name: "Laptop", capabilities: [], status: "active", identityEpoch: 1 })
      .returning();
    const workerKey = "rad-sk-deleted-worker-key";
    await test.runtime.drivers.db.insert(apiKeys).values({
      workspace,
      name: "Laptop key",
      hash: await hashApiKey(workerKey),
      worker: worker!.id,
      revokedAt: new Date(),
    });
    const response = await test.app.request("/api/openai/v1/models", {
      headers: { authorization: `Bearer ${workerKey}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: 401,
        message:
          "The Gateway key of Worker Laptop was deleted. The workspace owner can issue a new key in Settings → Workers.",
      },
    });
  });

  it("lists and serves only the key's own workspace, whatever the request names", async () => {
    const other = await newWorkspace();
    await addModel(test.runtime, "other-model");
    await addProvider(test.runtime, other, { slug: "elsewhere", models: [offer("other-model")] });

    const listed = await test.app.request(`/api/openai/v1/models?workspace=${other}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(listed.status).toBe(200);
    const models = (await listed.json()) as Array<{ id: string; pricing: object; context_length: number }>;
    expect(models.map((model) => model.id)).toEqual([MODEL]);
    expect(models[0]).toMatchObject({
      pricing: { prompt: "0.000001", completion: "0.000002" },
      context_length: 4096,
    });

    // The other workspace's model is not routable with this key.
    const response = await completion({ ...ask, model: "other-model" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Model other-model has no configured providers." });
    expect(upstreamCalls).toEqual([]);
  });

  it("validates the body before the key and reports unknown models", async () => {
    const invalid = await completion({ model: MODEL }, { key: null });
    expect(invalid.status).toBe(400);
    expect(Array.isArray(await invalid.json())).toBe(true);
    const unknown = await completion({ ...ask, model: "nope" });
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({ error: "Unknown model: nope" });
  });
});

describe("completions", () => {
  it("serves a non-streaming completion and records it with its key and cost", async () => {
    const response = await completion(ask);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      provider: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.id).toMatch(/^gen-/);
    expect(body.provider).toBe("first");
    expect(body.choices[0]!.message.content).toBe("Hello world");
    expect(upstreamCalls).toEqual([
      { url: "https://upstream.example.test/v1/chat/completions", authorization: "Bearer first-key-0" },
    ]);

    const [recorded] = await completionsOf(workspace);
    expect(recorded).toMatchObject({
      apiKey: keyId,
      provider: "first",
      streamed: false,
      canceled: false,
      promptTokens: 10,
      completionTokens: 5,
      genId: body.id,
      byok: true,
    });
    // 10 × 0.000001 + 5 × 0.000002
    expect(recorded!.cost).toBeCloseTo(0.00002, 12);
    await test.runtime.drivers.db.delete(chatCompletions).where(eq(chatCompletions.workspace, workspace));
  });

  it("streams SSE chunks with the Gateway id and provider, then [DONE]", async () => {
    const response = await completion({ ...ask, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const events = (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((event) => event.slice("data: ".length));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    expect(new Set(chunks.map((chunk) => chunk.provider))).toEqual(new Set(["first"]));
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("")).toBe("Hello world");

    const [recorded] = await completionsOf(workspace);
    expect(recorded).toMatchObject({ streamed: true, apiKey: keyId, genId: chunks[0].id });
    await test.runtime.drivers.db.delete(chatCompletions).where(eq(chatCompletions.workspace, workspace));
  });

  it("turns Bun's idle timeout off for the streaming request", async () => {
    const timeouts: number[] = [];
    const request = new Request("http://localhost/api/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ ...ask, stream: true }),
    });
    Object.assign(request, {
      runtime: { bun: { server: { timeout: (_: Request, seconds: number) => timeouts.push(seconds) } } },
    });
    const response = await test.app.fetch(request);
    await response.text();
    expect(timeouts).toEqual([0]);
    await test.runtime.drivers.db.delete(chatCompletions).where(eq(chatCompletions.workspace, workspace));
  });

  it("fails over to the next provider before output and cools the failed one", async () => {
    upstream = () =>
      upstreamCalls.length === 1 ? upstreamError(503) : upstreamStream(["from second"]);
    const response = await completion({ ...ask, stream: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"provider":"second"');
    expect(text).not.toContain('"error"');
    expect(upstreamCalls.map((call) => call.authorization)).toEqual([
      "Bearer first-key-0",
      "Bearer second-key-0",
    ]);
    const configuration = await appRouter
      .createCaller({ runtime: test.runtime, headers: ownerHeaders })
      .routing.getConfiguration({ workspace });
    expect(configuration.cooldowns).toMatchObject([
      { provider: "first", reason: "transient", status: 503 },
    ]);
    await test.runtime.drivers.db.delete(chatCompletions).where(eq(chatCompletions.workspace, workspace));
  });

  it("returns the upstream status and error body once failover is exhausted", async () => {
    upstream = () =>
      Response.json(
        { error: { message: "Provider refused inference", code: "usage_limit_reached", type: "usage_limit_reached" } },
        { status: 429, headers: { "retry-after": "15" } },
      );
    const response = await completion(ask);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        message: "Provider refused inference",
        status: 429,
        code: "usage_limit_reached",
        type: "usage_limit_reached",
        provider: "second",
      },
    });
    expect(response.headers.get("retry-after")).toBe("15");
    expect(await completionsOf(workspace)).toEqual([]);
  });

  it("request-invalid upstream errors return without trying another provider", async () => {
    upstream = () => upstreamError(400, "Upstream 400");
    const response = await completion(ask);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Upstream 400", status: 400, provider: "first" },
    });
    expect(upstreamCalls).toHaveLength(1);
  });

  it("queues one debounced budget recompute per budgeted credential", async () => {
    const target = await newWorkspace();
    const [credential] = await addProvider(test.runtime, target, { slug: "budgeted", models: [offer(MODEL)] });
    await test.runtime.drivers.db
      .update(workspaceCredentials)
      .set({ budgetAmount: 5, budgetPeriod: "month" })
      .where(eq(workspaceCredentials.id, credential!));
    const budgetKey = await newKey(target);
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => completion(ask, { key: budgetKey.key })),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await completionsOf(target)).toHaveLength(3);
    const queued = await test.runtime.drivers.db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `limits.budget:${credential}`));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("captures telemetry only when the workspace enables it and the key allows it", async () => {
    const target = await newWorkspace();
    await addProvider(test.runtime, target, { slug: "captured", models: [offer(MODEL)] });
    await updateWorkspaceSettings(test.runtime.drivers.db, target, { telemetryEnabled: true });
    const captured = await newKey(target);
    const silent = await newKey(target);
    await appRouter
      .createCaller({ runtime: test.runtime, headers: ownerHeaders })
      .keys.setKeyTelemetry({ workspace: target, key: silent.id, telemetry: "off" });

    expect((await completion(ask, { key: silent.key })).status).toBe(200);
    expect((await completion(ask, { key: captured.key })).status).toBe(200);
    const requests = await test.runtime.drivers.db
      .select()
      .from(telemetryRequests)
      .where(eq(telemetryRequests.workspace, target));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      apiKey: captured.id,
      source: "gateway",
      status: "ok",
      provider: "captured",
      // Content recording is off: nothing sealed or stored.
      recordsInputs: false,
      recordsOutputs: false,
    });
    expect(requests[0]!.chatCompletion).not.toBeNull();
  });
});

describe("in-process Chatroom models", () => {
  it("serve through the same pipeline and attribute the completion to the chat", async () => {
    const [chat] = await test.runtime.drivers.db
      .insert(chats)
      .values({ workspace, userId: ownerId })
      .returning();
    const settled: SettledGeneration[] = [];
    const provider = createInternalGatewayProvider(
      test.runtime,
      workspace,
      {},
      { actor: ownerId, chatId: chat!.id },
      { onGeneration: (generation) => settled.push(generation) },
    );
    const result = await generateText({ model: provider(MODEL), prompt: "Hello" });
    expect(result.text).toBe("Hello world");
    expect(settled).toMatchObject([{ provider: "first", model: MODEL }]);
    const [recorded] = await completionsOf(workspace);
    expect(recorded).toMatchObject({
      chat: chat!.id,
      userId: ownerId,
      apiKey: null,
      clientSession: null,
      provider: "first",
    });
    await test.runtime.drivers.db.delete(chatCompletions).where(eq(chatCompletions.workspace, workspace));
  });
});
