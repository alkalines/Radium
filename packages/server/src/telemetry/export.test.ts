import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import {
  caller,
  captureDeferred,
  captureRequest,
  insertRequest,
  insertSession,
  requestRow,
  setArchived,
  telemetryWorkspace,
  type TelemetryWorkspace,
} from "../../test/telemetry";
import { apiKeys, secrets } from "../gateway/schema";
import { dispatchJobs } from "../jobs/outbox";
import { jobs } from "../jobs/schema";
import { EXPORT_JOB, runExportJob } from "./export";
import { finishRequest } from "./ingest";
import { isSampled } from "./otlp";
import { telemetryDestinations } from "./schema";

// Export destinations and delivery against real Postgres and Valkey, with `runtime.fetch`
// stubbed (no network): the owner boundary, the Convex `telemetryExport` cases, the job queued
// with a captured request, at-most-once delivery per (request, destination), and content export
// from memory.

let test: TestRuntime;
let settle: () => Promise<void>;
const fetchMock = vi.fn<typeof fetch>();
const db = () => test.runtime.drivers.db;

beforeAll(async () => {
  test = await createTestRuntime();
  test.runtime.fetch = fetchMock;
  settle = captureDeferred(test.runtime);
});

afterAll(async () => {
  await test?.close();
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Fixture = TelemetryWorkspace & { keyA: string; keyB: string; foreignKey: string };

async function setup(options: { keyed?: boolean } = {}): Promise<Fixture> {
  const f = await telemetryWorkspace(test.runtime, options);
  const key = async (workspace: string, name: string) => {
    const [row] = await db()
      .insert(apiKeys)
      .values({ workspace, name, hash: crypto.randomUUID() })
      .returning();
    return row!.id;
  };
  return {
    ...f,
    keyA: await key(f.workspace, "A"),
    keyB: await key(f.workspace, "B"),
    foreignKey: await key(f.outsider.workspace, "Foreign"),
  };
}

const exportApi = (f: Fixture) => caller(test.runtime, f.owner).telemetryExport;

/** A captured Gateway request, optionally in a session and attributed to an API key. */
async function request(f: Fixture, options: { requestId: string; sessionKey?: string; apiKey?: string }) {
  const session = options.sessionKey
    ? await insertSession(test.runtime, f.workspace, options.sessionKey)
    : undefined;
  return await insertRequest(test.runtime, f.workspace, {
    requestId: options.requestId,
    apiKey: options.apiKey,
    session,
    model: "test-model",
    provider: "test-provider",
    startedAt: new Date(1_700_000_000_000),
    endedAt: new Date(1_700_000_000_500),
    durationMs: 500,
    recordsInputs: false,
    recordsOutputs: false,
  });
}

const deliver = (requestId: string) => runExportJob(test.runtime, { request: requestId });

function sentUrls() {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function sentBody(index = 0) {
  return String(fetchMock.mock.calls[index]![1]!.body);
}

async function destinationRow(id: string) {
  const [row] = await db().select().from(telemetryDestinations).where(eq(telemetryDestinations.id, id));
  return row;
}

describe("authorization", () => {
  it("every export procedure is owner-only; members, outsiders and archived workspaces get NOT_FOUND", async () => {
    const f = await setup();
    const { id } = await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "Hook",
      endpoint: "https://hooks.example.com",
    });
    const workspace = f.workspace;
    const calls = (account: typeof f.owner) => {
      const api = caller(test.runtime, account).telemetryExport;
      return {
        listDestinations: () => api.listDestinations({ workspace }),
        createDestination: () =>
          api.createDestination({ workspace, kind: "otlp", name: "x", endpoint: "https://x.example.com" }),
        updateDestination: () => api.updateDestination({ workspace, destination: id, name: "y" }),
        testDestination: () => api.testDestination({ workspace, destination: id }),
        deleteDestination: () => api.deleteDestination({ workspace, destination: id }),
      };
    };
    for (const account of [f.member, f.outsider]) {
      for (const [name, call] of Object.entries(calls(account))) {
        await expect(call(), name).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    }
    await setArchived(test.runtime, workspace, true);
    for (const [name, call] of Object.entries(calls(f.owner))) {
      await expect(call(), `${name} archived`).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await setArchived(test.runtime, workspace, false);
    expect(fetchMock).not.toHaveBeenCalled();

    // A destination of another workspace is not found through the caller's own workspace.
    const other = caller(test.runtime, f.outsider).telemetryExport;
    await expect(
      other.deleteDestination({ workspace: f.outsider.workspace, destination: id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Destination not found." });
    await expect(
      other.testDestination({ workspace: f.outsider.workspace, destination: id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await exportApi(f).listDestinations({ workspace })).toHaveLength(1);
  });
});

describe("destination management (Convex telemetryExport)", () => {
  it("owners manage destinations and header values are never returned or stored in the row", async () => {
    const f = await setup();
    const api = exportApi(f);
    const secretValue = "Bearer super-secret-token";
    const { id } = await api.createDestination({
      workspace: f.workspace,
      kind: "otlp",
      name: "  Collector  ",
      endpoint: "https://otel.example.com",
      headers: { Authorization: secretValue },
      includeApiKeys: [f.keyA],
    });

    const listed = await api.listDestinations({ workspace: f.workspace });
    expect(listed).toEqual([
      {
        id,
        kind: "otlp",
        name: "Collector",
        endpoint: "https://otel.example.com",
        enabled: true,
        privacyMode: true,
        samplingRate: 1,
        includeApiKeys: [f.keyA],
        excludeApiKeys: [],
        hasHeaders: true,
        lastDeliveryAt: null,
        lastError: null,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(secretValue);
    expect(JSON.stringify(await destinationRow(id))).not.toContain(secretValue);
    const [secret] = await db()
      .select()
      .from(secrets)
      .where(eq(secrets.namespace, `workspace:${f.workspace}:telemetry:${id}`));
    expect(secret).toMatchObject({ name: "headers" });
    expect(JSON.stringify(secret)).not.toContain(secretValue);

    // Omitted headers keep the stored secret; an empty map clears it.
    await api.updateDestination({ workspace: f.workspace, destination: id, name: "Renamed", enabled: false });
    expect(await api.listDestinations({ workspace: f.workspace })).toMatchObject([
      { name: "Renamed", enabled: false, hasHeaders: true },
    ]);
    await api.updateDestination({ workspace: f.workspace, destination: id, headers: {} });
    expect(await api.listDestinations({ workspace: f.workspace })).toMatchObject([{ hasHeaders: false }]);

    await api.updateDestination({ workspace: f.workspace, destination: id, headers: { "x-key": "k" } });
    await api.deleteDestination({ workspace: f.workspace, destination: id });
    expect(await api.listDestinations({ workspace: f.workspace })).toEqual([]);
    expect(
      await db().select().from(secrets).where(eq(secrets.namespace, `workspace:${f.workspace}:telemetry:${id}`)),
    ).toEqual([]);
  });

  it("rejects insecure endpoints, bad sampling, bad headers and API keys of another workspace", async () => {
    const f = await setup();
    const api = exportApi(f);
    const base = { workspace: f.workspace, kind: "webhook" as const, name: "Hook" };
    const refused = async (input: Partial<Parameters<typeof api.createDestination>[0]>, message: string) =>
      await expect(
        api.createDestination({ ...base, endpoint: "https://hooks.example.com", ...input }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(message) });

    for (const endpoint of [
      "http://hooks.example.com",
      "https://user:pass@hooks.example.com",
      "ftp://hooks.example.com",
      "http://10.0.0.1",
      "not a url",
    ]) {
      await refused({ endpoint }, "https");
    }
    await refused({ samplingRate: 1.5 }, "Sampling");
    await refused({ samplingRate: -0.1 }, "Sampling");
    await refused({ excludeApiKeys: [f.foreignKey] }, "Unknown API key");
    await refused({ includeApiKeys: [crypto.randomUUID()] }, "Unknown API key");
    await refused({ headers: { "bad header": "v" } }, "Invalid header name");
    await refused({ headers: { ok: "line\r\nbreak" } }, "Invalid value for header ok");
    await refused({ name: "   " }, "name is required");
    await refused({ name: "n".repeat(81) }, "too long");

    // Loopback http is allowed (Convex `parseDestinationEndpoint`).
    for (const endpoint of ["http://localhost:4318", "http://127.0.0.1:4318", "http://[::1]:4318"]) {
      await api.createDestination({ ...base, endpoint });
    }
  });

  it("caps a workspace at 20 destinations, also under concurrent creates", async () => {
    const f = await setup();
    const api = exportApi(f);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) =>
        api.createDestination({
          workspace: f.workspace,
          kind: "webhook",
          name: `Hook ${index}`,
          endpoint: "https://hooks.example.com",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
    expect(await api.listDestinations({ workspace: f.workspace })).toHaveLength(20);
  });
});

describe("delivery (Convex telemetryExport)", () => {
  it("posts OTLP to /v1/traces with stored headers and records the delivery", async () => {
    const f = await setup();
    const { id } = await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "otlp",
      name: "Collector",
      endpoint: "https://otel.example.com",
      headers: { "x-api-key": "k-123" },
    });
    await deliver(await request(f, { requestId: "req-1", sessionKey: "s1" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://otel.example.com/v1/traces");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "x-api-key": "k-123" },
    });
    const span = JSON.parse(String(init!.body)).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("chat test-model");
    expect(span.attributes).toContainEqual({ key: "gen_ai.conversation.id", value: { stringValue: "s1" } });

    const row = await destinationRow(id);
    expect(row!.lastDeliveryAt).toBeInstanceOf(Date);
    expect(row!.lastError).toBeNull();
  });

  it("posts webhooks to the endpoint as-is and records failures without throwing or leaking headers", async () => {
    const f = await setup();
    const { id } = await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "Hook",
      endpoint: "https://hooks.example.com/in",
      headers: { authorization: "Bearer hidden" },
    });
    fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
    await expect(deliver(await request(f, { requestId: "req-1" }))).resolves.toBeUndefined();
    expect(sentUrls()).toEqual(["https://hooks.example.com/in"]);
    const row = await destinationRow(id);
    expect(row!.lastError).toBe("HTTP 500");
    expect(JSON.stringify(row)).not.toContain("Bearer hidden");

    fetchMock.mockImplementation(async () => {
      throw new Error("connect refused Bearer hidden");
    });
    await deliver(await request(f, { requestId: "req-2" }));
    expect((await destinationRow(id))!.lastError).toBe("Delivery failed.");

    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await deliver(await request(f, { requestId: "req-3" }));
    expect(await destinationRow(id)).toMatchObject({ lastError: null, lastDeliveryAt: expect.any(Date) });
  });

  it("honors API key include and exclude lists, with exclude winning", async () => {
    const f = await setup();
    const create = (name: string, extra: Record<string, unknown>) =>
      exportApi(f).createDestination({
        workspace: f.workspace,
        kind: "webhook",
        name,
        endpoint: `https://${name}.example.com`,
        ...extra,
      });
    await create("all", {});
    await create("only-a", { includeApiKeys: [f.keyA] });
    await create("not-a", { excludeApiKeys: [f.keyA] });
    await create("a-both", { includeApiKeys: [f.keyA], excludeApiKeys: [f.keyA] });

    await deliver(await request(f, { requestId: "ra", apiKey: f.keyA }));
    expect(sentUrls().sort()).toEqual(["https://all.example.com/", "https://only-a.example.com/"]);

    fetchMock.mockClear();
    await deliver(await request(f, { requestId: "rb", apiKey: f.keyB }));
    expect(sentUrls().sort()).toEqual(["https://all.example.com/", "https://not-a.example.com/"]);

    fetchMock.mockClear();
    await deliver(await request(f, { requestId: "rn" }));
    expect(sentUrls().sort()).toEqual(["https://all.example.com/", "https://not-a.example.com/"]);
  });

  it("samples whole sessions deterministically and skips disabled destinations", async () => {
    const f = await setup();
    const rate = 0.5;
    const keys = Array.from({ length: 40 }, (_, index) => `session-${index}`);
    const decisions = await Promise.all(keys.map((key) => isSampled(key, rate)));
    const kept = keys[decisions.indexOf(true)]!;
    const dropped = keys[decisions.indexOf(false)]!;
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "sampled",
      endpoint: "https://sampled.example.com",
      samplingRate: rate,
    });
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "off",
      endpoint: "https://off.example.com",
      enabled: false,
    });

    const keptSession = await insertSession(test.runtime, f.workspace, kept);
    const keptFirst = await insertRequest(test.runtime, f.workspace, { requestId: "k1", session: keptSession });
    const keptSecond = await insertRequest(test.runtime, f.workspace, { requestId: "k2", session: keptSession });
    await deliver(await request(f, { requestId: "d1", sessionKey: dropped }));
    expect(fetchMock).not.toHaveBeenCalled();

    await deliver(keptFirst);
    await deliver(keptSecond);
    expect(sentUrls()).toEqual(["https://sampled.example.com/", "https://sampled.example.com/"]);
  });

  it("never exports a request the owner cannot see, nor one of an archived workspace", async () => {
    const f = await setup();
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "all",
      endpoint: "https://all.example.com",
    });
    const personal = await insertRequest(test.runtime, f.workspace, { requestId: "p", chat: f.memberPersonalChat });
    const deletedChat = await insertRequest(test.runtime, f.workspace, {
      requestId: "orphan",
      source: "chatroom",
    });
    await deliver(personal);
    await deliver(deletedChat);
    expect(fetchMock).not.toHaveBeenCalled();

    const visible = await insertRequest(test.runtime, f.workspace, { requestId: "v", chat: f.sharedChat });
    await setArchived(test.runtime, f.workspace, true);
    await deliver(visible);
    expect(fetchMock).not.toHaveBeenCalled();
    await setArchived(test.runtime, f.workspace, false);
    await deliver(visible);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("privacy mode strips content from the payload", async () => {
    const f = await setup({ keyed: true });
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "private",
      endpoint: "https://private.example.com",
      privacyMode: true,
    });
    const captured = captureRequest(test.runtime, {
      workspace: f.workspace,
      userId: f.owner.id,
      messages: [
        { role: "system", content: "TOP SECRET" },
        { role: "user", content: "hello" },
      ],
      output: "answer",
    });
    await captured.capture.finish({ status: "ok" });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = sentBody();
    expect(body).not.toContain("TOP SECRET");
    expect(body).not.toContain("gen_ai.system_instructions");
    expect(body).not.toContain("gen_ai.input.messages");
  });
});

describe("export from capture", () => {
  it("finishRequest queues one job with the inserted row, and none for a retried request", async () => {
    const f = await setup();
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "hook",
      endpoint: "https://hook.example.com",
    });
    const input = {
      workspace: f.workspace,
      requestId: "finished",
      source: "gateway" as const,
      userId: f.owner.id,
      model: "m",
      stream: false,
      status: "ok" as const,
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      attempts: [],
      recordsInputs: false,
      recordsOutputs: false,
    };
    const first = await finishRequest(db(), input);
    const again = await finishRequest(db(), input);
    expect(first).toMatchObject({ inserted: true, exportJob: expect.any(String) });
    expect(again).toEqual({ id: first.id, inserted: false, exportJob: null });

    const queued = await db().select().from(jobs).where(eq(jobs.dedupeKey, `${EXPORT_JOB}:${first.id}`));
    expect(queued.map((job) => [job.id, job.payload])).toEqual([[first.exportJob, { request: first.id }]]);
    expect(fetchMock).not.toHaveBeenCalled();

    await dispatchJobs(test.runtime, [first.exportJob]);
    expect(sentUrls()).toEqual(["https://hook.example.com/"]);
    expect(await db().select().from(jobs).where(eq(jobs.id, first.exportJob!))).toEqual([]);
  });

  it("a captured request is exported after commit, and a retried capture exports nothing more", async () => {
    const f = await setup();
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "hook",
      endpoint: "https://hook.example.com",
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const captured = captureRequest(test.runtime, {
        workspace: f.workspace,
        userId: f.owner.id,
        messages: [{ role: "user", content: "hi" }],
        requestId: "same-request",
      });
      await captured.capture.finish({ status: "ok" });
      await settle();
    }
    expect(sentUrls()).toEqual(["https://hook.example.com/"]);
    expect(await db().select().from(jobs).where(eq(jobs.kind, EXPORT_JOB))).toEqual([]);
  });

  it("queues no job while the workspace has no enabled privacy-mode destination", async () => {
    const f = await setup();
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "off",
      endpoint: "https://off.example.com",
      enabled: false,
    });
    const captured = captureRequest(test.runtime, {
      workspace: f.workspace,
      userId: f.owner.id,
      messages: [{ role: "user", content: "hi" }],
    });
    await captured.capture.finish({ status: "ok" });
    const row = await requestRow(test.runtime, f.workspace, captured.requestId);
    expect(await db().select().from(jobs).where(eq(jobs.dedupeKey, `${EXPORT_JOB}:${row!.id}`))).toEqual([]);
  });

  it("duplicate and concurrent export jobs deliver at most once per request and destination", async () => {
    const f = await setup();
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "a",
      endpoint: "https://a.example.com",
    });
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "otlp",
      name: "b",
      endpoint: "https://b.example.com",
    });
    const requestId = await request(f, { requestId: "once" });
    await Promise.all(Array.from({ length: 5 }, () => deliver(requestId)));
    // A retried job after a crash (or a job reclaimed after its claim lapsed) sends nothing again.
    await deliver(requestId);
    expect(sentUrls().sort()).toEqual(["https://a.example.com/", "https://b.example.com/v1/traces"]);
  });

  it("sends recorded content from memory to destinations without privacy mode", async () => {
    const f = await setup({ keyed: true });
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "content",
      endpoint: "https://content.example.com",
      privacyMode: false,
    });
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "private",
      endpoint: "https://private.example.com",
    });
    const captured = captureRequest(test.runtime, {
      workspace: f.workspace,
      userId: f.owner.id,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello there" },
      ],
      output: "general kenobi",
    });
    await captured.capture.finish({ status: "ok" });
    await settle();

    const bodies = new Map(fetchMock.mock.calls.map((call) => [String(call[0]), String(call[1]!.body)]));
    expect([...bodies.keys()].sort()).toEqual(["https://content.example.com/", "https://private.example.com/"]);
    const content = bodies.get("https://content.example.com/")!;
    expect(content).toContain("hello there");
    expect(content).toContain("general kenobi");
    expect(content).toContain("gen_ai.system_instructions");
    expect(bodies.get("https://private.example.com/")).not.toContain("hello there");
  });

  it("content export follows the recording settings", async () => {
    const f = await setup({ keyed: true });
    await exportApi(f).createDestination({
      workspace: f.workspace,
      kind: "webhook",
      name: "content",
      endpoint: "https://content.example.com",
      privacyMode: false,
    });
    const captured = captureRequest(test.runtime, {
      workspace: f.workspace,
      userId: f.owner.id,
      messages: [{ role: "user", content: "do not record" }],
      output: "nor this",
      settings: { enabled: true, recordInputs: false, recordOutputs: false },
    });
    await captured.capture.finish({ status: "ok" });
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentBody()).not.toContain("do not record");
    expect(sentBody()).not.toContain("nor this");
  });
});

describe("testDestination", () => {
  it("sends a synthetic span for owners only and reports the outcome", async () => {
    const f = await setup();
    const api = exportApi(f);
    const { id } = await api.createDestination({
      workspace: f.workspace,
      kind: "otlp",
      name: "Collector",
      endpoint: "https://otel.example.com/v1/traces",
    });
    expect(await api.testDestination({ workspace: f.workspace, destination: id })).toEqual({ ok: true });
    expect(sentUrls()).toEqual(["https://otel.example.com/v1/traces"]);

    await expect(
      caller(test.runtime, f.outsider).telemetryExport.testDestination({ workspace: f.workspace, destination: id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => new Response(null, { status: 502 }));
    expect(await api.testDestination({ workspace: f.workspace, destination: id })).toEqual({
      ok: false,
      error: "HTTP 502",
    });
    expect((await destinationRow(id))!.lastError).toBe("HTTP 502");
  });
});
