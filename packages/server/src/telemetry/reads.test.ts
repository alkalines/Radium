import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import {
  caller,
  captureDeferred,
  captureRequest,
  insertBlob,
  insertNode,
  insertRequest,
  insertSession,
  insertToolset,
  openWireBlob,
  requestRow,
  setArchived,
  telemetryWorkspace,
} from "../../test/telemetry";
import { chats } from "../chatroom/schema";
import { telemetryBlobs, telemetryRequests } from "./schema";

// Owner telemetry reads and settings against real Postgres: the owner-only boundary of every
// procedure, personal-chat privacy and deleted-chat hiding on every read path, the Convex
// `telemetryReads` cases, settings, and sealed envelopes in the object store.

let test: TestRuntime;
const db = () => test.runtime.drivers.db;
const at = (ms: number) => new Date(ms);

beforeAll(async () => {
  test = await createTestRuntime();
  captureDeferred(test.runtime);
});

afterAll(async () => {
  await test?.close();
});

const notFound = { code: "NOT_FOUND" };

describe("authorization", () => {
  it("every telemetry procedure is owner-only; members, outsiders and archived workspaces get NOT_FOUND", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const session = await insertSession(runtime, f.workspace, "boundary");
    const request = await insertRequest(runtime, f.workspace, { requestId: "boundary", session });
    const workspace = f.workspace;
    const calls = (account: typeof f.owner) => {
      const api = caller(runtime, account).telemetry;
      return {
        getSettings: () => api.getSettings({ workspace }),
        setSettings: () =>
          api.setSettings({ workspace, enabled: true, recordInputs: false, recordOutputs: false }),
        getSummary: () => api.getSummary({ workspace, since: 0 }),
        listRequests: () => api.listRequests({ workspace }),
        listSessions: () => api.listSessions({ workspace }),
        getRequest: () => api.getRequest({ request }),
        getRequestMessages: () => api.getRequestMessages({ request }),
        getSession: () => api.getSession({ session }),
        deleteRequest: () => api.deleteRequest({ request }),
        deleteSession: () => api.deleteSession({ session }),
      };
    };

    for (const account of [f.member, f.outsider]) {
      for (const [name, call] of Object.entries(calls(account))) {
        await expect(call(), `${name} as non-owner`).rejects.toMatchObject(notFound);
      }
    }
    await setArchived(runtime, workspace, true);
    for (const [name, call] of Object.entries(calls(f.owner))) {
      await expect(call(), `${name} archived`).rejects.toMatchObject(notFound);
    }
    await setArchived(runtime, workspace, false);

    const owner = calls(f.owner);
    const { deleteRequest, deleteSession, ...reads } = owner;
    for (const [name, call] of Object.entries(reads)) {
      await expect(call(), name).resolves.toBeDefined();
    }
    await expect(deleteRequest()).resolves.toBeNull();
    await expect(deleteSession()).resolves.toBeNull();
  });

  it("unknown ids are the same NOT_FOUND", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const api = caller(test.runtime, f.owner).telemetry;
    await expect(api.getRequest({ request: crypto.randomUUID() })).rejects.toMatchObject(notFound);
    await expect(api.getSession({ session: crypto.randomUUID() })).rejects.toMatchObject(notFound);
    await expect(
      api.listRequests({ workspace: f.workspace, session: crypto.randomUUID() }),
    ).rejects.toMatchObject(notFound);
  });
});

describe("privacy", () => {
  it("hides another user's personal and shared chats and deleted chats on every read", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const [doomed] = await db().insert(chats).values({ workspace: ws, userId: f.owner.id, scope: "workspace" }).returning();

    const blob = await insertBlob(runtime, ws, "message", "privacy-m1", { role: "user", content: "secret" });
    const node = await insertNode(runtime, ws, "privacy-n1", 1, undefined, blob);

    const gatewaySession = await insertSession(runtime, ws, "gateway-session");
    const privateSession = await insertSession(runtime, ws, "private-session", {
      source: "chatroom",
      chat: f.memberPersonalChat,
    });
    const sharedSession = await insertSession(runtime, ws, "shared-session", {
      source: "chatroom",
      chat: f.memberSharedChat,
    });
    const doomedSession = await insertSession(runtime, ws, "doomed-session", {
      source: "chatroom",
      chat: doomed!.id,
    });
    const visibleSession = await insertSession(runtime, ws, "visible-session", {
      source: "chatroom",
      chat: f.sharedChat,
    });

    const gateway = await insertRequest(runtime, ws, { requestId: "gw", startedAt: at(10), session: gatewaySession });
    const inGatewaySession = await insertRequest(runtime, ws, {
      requestId: "gw-private",
      startedAt: at(20),
      session: gatewaySession,
      chat: f.memberPersonalChat,
      input: node,
      durationMs: 9999,
    });
    const personal = await insertRequest(runtime, ws, {
      requestId: "personal",
      startedAt: at(30),
      session: privateSession,
      chat: f.memberPersonalChat,
      input: node,
    });
    const shared = await insertRequest(runtime, ws, {
      requestId: "shared",
      startedAt: at(40),
      session: sharedSession,
      chat: f.memberSharedChat,
    });
    const deleted = await insertRequest(runtime, ws, {
      requestId: "deleted",
      startedAt: at(50),
      session: doomedSession,
      chat: doomed!.id,
    });
    const visible = await insertRequest(runtime, ws, {
      requestId: "visible",
      startedAt: at(60),
      session: visibleSession,
      chat: f.sharedChat,
    });
    await db().delete(chats).where(eq(chats.id, doomed!.id));

    const api = caller(runtime, f.owner).telemetry;
    const list = await api.listRequests({ workspace: ws, limit: 50 });
    expect(list.page.map((row) => row.id)).toEqual([visible, gateway]);

    const summary = await api.getSummary({ workspace: ws, since: 0 });
    expect(summary.requests).toBe(2);
    expect(summary.durationP95).toBe(1);

    const sessions = await api.listSessions({ workspace: ws, limit: 25 });
    expect(sessions.page.map((row) => row.id).sort()).toEqual([gatewaySession, visibleSession].sort());
    expect(sessions.page.find((row) => row.id === gatewaySession)).toMatchObject({
      requestCount: 1,
      lastRequestAt: 10,
    });

    const timeline = await api.getSession({ session: gatewaySession });
    expect(timeline.requests.map((row) => row.id)).toEqual([gateway]);
    await expect(
      api.listRequests({ workspace: ws, session: gatewaySession }),
    ).resolves.toMatchObject({ page: [{ id: gateway }] });

    for (const session of [privateSession, sharedSession, doomedSession]) {
      await expect(api.getSession({ session })).rejects.toMatchObject(notFound);
      await expect(api.listRequests({ workspace: ws, session })).rejects.toMatchObject(notFound);
      await expect(api.deleteSession({ session })).rejects.toMatchObject(notFound);
    }
    for (const request of [inGatewaySession, personal, shared, deleted]) {
      await expect(api.getRequest({ request })).rejects.toMatchObject(notFound);
      await expect(api.getRequestMessages({ request })).rejects.toMatchObject(notFound);
      await expect(api.deleteRequest({ request })).rejects.toMatchObject(notFound);
    }
    expect(JSON.stringify([list, summary, sessions, timeline])).not.toContain("secret");
  });
});

describe("reads (Convex telemetryReads)", () => {
  it("listRequests pages newest first, filters by status, and skips other users' private chats", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const plain = await insertRequest(runtime, ws, { requestId: "a", startedAt: at(100) });
    await insertRequest(runtime, ws, { requestId: "b", startedAt: at(200), chat: f.memberPersonalChat });
    const shared = await insertRequest(runtime, ws, { requestId: "c", startedAt: at(300), chat: f.sharedChat });
    const failed = await insertRequest(runtime, ws, {
      requestId: "d",
      startedAt: at(400),
      status: "error",
      errorMessage: "boom",
      errorStatus: 500,
    });
    const api = caller(runtime, f.owner).telemetry;

    const first = await api.listRequests({ workspace: ws, limit: 2 });
    expect(first.page.map((row) => row.id)).toEqual([failed, shared]);
    expect(first.page[0]).toMatchObject({ status: "error", error: "boom", startedAt: 400 });
    expect(first.nextCursor).not.toBeNull();

    const pages = [];
    for (let cursor = first.nextCursor; cursor; ) {
      const page = await api.listRequests({ workspace: ws, limit: 2, cursor });
      pages.push(...page.page.map((row) => row.id));
      cursor = page.nextCursor;
    }
    expect(pages).toEqual([plain]);

    const errors = await api.listRequests({ workspace: ws, status: "error" });
    expect(errors.page.map((row) => row.id)).toEqual([failed]);
    const byModel = await api.listRequests({ workspace: ws, model: "other/model" });
    expect(byModel).toEqual({ page: [], nextCursor: null });
  });

  it("a filtered page scans a bounded window and continues after it", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const ws = f.workspace;
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      workspace: ws,
      requestId: `bulk-${index}`,
      source: "gateway" as const,
      model: "provider/model",
      stream: false,
      status: index === 0 ? ("error" as const) : ("ok" as const),
      startedAt: at(index + 1),
      endedAt: at(index + 2),
      durationMs: 1,
      attempts: [],
      recordsInputs: false,
      recordsOutputs: false,
      lineage: { kind: "root" as const },
    }));
    await db().insert(telemetryRequests).values(rows);
    const api = caller(test.runtime, f.owner).telemetry;

    const first = await api.listRequests({ workspace: ws, status: "error" });
    expect(first.page).toEqual([]);
    expect(first.nextCursor).toMatchObject({ at: 2 });
    const second = await api.listRequests({ workspace: ws, status: "error", cursor: first.nextCursor });
    expect(second.page.map((row) => row.startedAt)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
  });

  it("getRequest resolves system and params changes and diffs the toolset", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const tool = (name: string, version: number) =>
      insertBlob(runtime, ws, "tool", `tool-${name}-${version}`, {
        type: "function",
        function: {
          name,
          description: `v${version}`,
          parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
        },
      });
    const weatherV1 = await tool("get_weather", 1);
    const weatherV2 = await tool("get_weather", 2);
    const search = await tool("search", 1);
    const calc = await tool("calc", 1);
    const before = await insertBlob(runtime, ws, "toolset", "set-before", []);
    const after = await insertBlob(runtime, ws, "toolset", "set-after", []);
    await insertToolset(runtime, before, [weatherV1, search]);
    await insertToolset(runtime, after, [search, weatherV2, calc]);
    const systemBefore = await insertBlob(runtime, ws, "system", "sys-1", [{ role: "system", content: "Be brief." }]);
    const systemAfter = await insertBlob(runtime, ws, "system", "sys-2", [{ role: "system", content: "Be thorough." }]);
    const paramsBefore = await insertBlob(runtime, ws, "params", "params-1", { temperature: 0 });
    const paramsAfter = await insertBlob(runtime, ws, "params", "params-2", { temperature: 0.7, top_p: 0.9 });

    const previous = await insertRequest(runtime, ws, { requestId: "previous", startedAt: at(10) });
    const current = await insertRequest(runtime, ws, {
      requestId: "current",
      startedAt: at(20),
      toolset: after,
      system: systemAfter,
      params: paramsAfter,
      lineage: { kind: "continue", request: previous as never },
      changes: {
        previous: previous as never,
        system: { from: systemBefore as never, to: systemAfter as never },
        params: { from: paramsBefore as never, to: paramsAfter as never },
        toolset: { from: before as never, to: after as never },
        model: { from: "old/model", to: "provider/model" },
      },
    });

    const result = await caller(runtime, f.owner).telemetry.getRequest({ request: current });
    const parsed = (blob: { content: string | null } | null | undefined) =>
      blob?.content == null ? undefined : JSON.parse(blob.content);

    expect(result.summary.changedFields.sort()).toEqual(["model", "params", "system", "toolset"]);
    expect(result.related).toMatchObject({ id: previous, startedAt: 10 });
    expect(parsed(result.changes?.system?.from)).toEqual([{ role: "system", content: "Be brief." }]);
    expect(parsed(result.changes?.system?.to)).toEqual([{ role: "system", content: "Be thorough." }]);
    expect(parsed(result.changes?.params?.from)).toEqual({ temperature: 0 });
    expect(parsed(result.changes?.params?.to)).toEqual({ temperature: 0.7, top_p: 0.9 });
    expect(parsed(result.tools[1])).toMatchObject({
      function: { parameters: { $schema: "http://json-schema.org/draft-07/schema#" } },
    });
    expect(result.changes?.model).toEqual({ from: "old/model", to: "provider/model" });
    expect(result.tools.map((blob) => blob.hash)).toEqual(["tool-search-1", "tool-get_weather-2", "tool-calc-1"]);
    expect(result.changes?.tools?.from.map((blob) => blob.hash)).toEqual(["tool-get_weather-1", "tool-search-1"]);
    expect(result.changes?.tools?.to.map((blob) => blob.hash)).toEqual([
      "tool-search-1",
      "tool-get_weather-2",
      "tool-calc-1",
    ]);
    expect(result.request).toMatchObject({ id: current, requestId: "current", sealedError: null, error: null });
  });

  it("getRequestMessages pages newest first, marks new nodes, and rejects off-chain cursors", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const nodes: string[] = [];
    let parent: string | undefined;
    for (let depth = 1; depth <= 5; depth++) {
      const blob = await insertBlob(runtime, ws, "message", `msg-${depth}`, { role: "user", content: `message ${depth}` });
      parent = await insertNode(runtime, ws, `node-${depth}`, depth, parent, blob);
      nodes.push(parent);
    }
    const otherBlob = await insertBlob(runtime, ws, "message", "msg-4b", { role: "user" });
    const sibling = await insertNode(runtime, ws, "node-4b", 4, nodes[2], otherBlob);
    const first = await insertRequest(runtime, ws, { requestId: "first", startedAt: at(1), input: nodes[3], output: nodes[4] });
    const second = await insertRequest(runtime, ws, {
      requestId: "second",
      startedAt: at(2),
      input: nodes[4],
      lineage: { kind: "continue", request: first as never },
    });
    const api = caller(runtime, f.owner).telemetry;

    const newest = await api.getRequestMessages({ request: second, limit: 2 });
    expect(newest.nodes.map((node) => node.depth)).toEqual([4, 5]);
    expect(newest.prefixDepth).toBe(5);
    expect(newest.nodes.map((node) => node.isNew)).toEqual([false, false]);
    expect(newest.more).toBe(true);
    expect(newest.total).toBe(5);

    const older = await api.getRequestMessages({ request: second, cursor: newest.nextCursor, limit: 10 });
    expect(older.nodes.map((node) => node.depth)).toEqual([1, 2, 3]);
    expect(JSON.parse(older.nodes[0]!.message.content!)).toEqual({ role: "user", content: "message 1" });
    expect(older.more).toBe(false);
    expect(older.nextCursor).toBeNull();

    await expect(api.getRequestMessages({ request: second, cursor: sibling })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid message cursor.",
    });
    const output = await api.getRequest({ request: first });
    expect(output.output).toMatchObject({ id: nodes[4], depth: 5 });
  });

  it("getSession groups a rollback and a retry into separate branches", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const node = async (key: string, depth: number, parent: string | undefined, origin: "input" | "output" = "input") =>
      insertNode(runtime, ws, key, depth, parent, await insertBlob(runtime, ws, "message", `blob-${key}`), origin);
    const n1 = await node("n1", 1, undefined);
    const n2 = await node("n2", 2, n1);
    const n3 = await node("n3", 3, n2);
    const n4 = await node("n4", 4, n3, "output");
    const n5 = await node("n5", 5, n4);
    const n6 = await node("n6", 6, n5, "output");
    const n4b = await node("n4b", 4, n3);
    const n5b = await node("n5b", 5, n4b, "output");
    const n6b = await node("n6b", 6, n5b);
    const session = await insertSession(runtime, ws, "session-1");
    const r = (requestId: string, startedAt: number, fields: Partial<typeof telemetryRequests.$inferInsert>) =>
      insertRequest(runtime, ws, { requestId, startedAt: at(startedAt), session, ...fields });
    const r1 = await r("r1", 100, { input: n3, output: n4 });
    const r2 = await r("r2", 200, { input: n5, output: n6, lineage: { kind: "continue", request: r1 as never } });
    const r3 = await r("r3", 300, { input: n4b, output: n5b, lineage: { kind: "branch", request: r2 as never, depth: 3 } });
    const r4 = await r("r4", 400, { input: n6b, lineage: { kind: "continue", request: r3 as never } });
    const r5 = await r("r5", 500, { input: n6b, lineage: { kind: "retry", request: r4 as never } });
    const api = caller(runtime, f.owner).telemetry;

    const result = await api.getSession({ session });
    expect(result.requests.map((row) => [row.id, row.newMessages])).toEqual([
      [r1, 3],
      [r2, 1],
      [r3, 1],
      [r4, 1],
      [r5, 0],
    ]);
    expect(result.lanes).toEqual([
      { id: r1, kind: "root", parentLane: null, forkRequest: null, forkDepth: 0, requests: [r1, r2] },
      { id: r3, kind: "branch", parentLane: r1, forkRequest: r2, forkDepth: 3, requests: [r3, r4] },
      { id: r5, kind: "retry", parentLane: r3, forkRequest: r4, forkDepth: 6, requests: [r5] },
    ]);
    expect(result.truncated).toBe(false);

    const sessions = await api.listSessions({ workspace: ws });
    expect(sessions.page).toMatchObject([{ key: "session-1", requestCount: 5, lastRequestAt: 500 }]);
  });

  it("getSession links its parent and subagent sessions", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const parent = await insertSession(runtime, f.workspace, "parent");
    const session = await insertSession(runtime, f.workspace, "child", { parentKey: "parent" });
    const grandchild = await insertSession(runtime, f.workspace, "grandchild", { parentKey: "child" });
    await insertSession(runtime, f.workspace, "hidden-child", {
      parentKey: "child",
      source: "chatroom",
      chat: f.memberPersonalChat,
    });
    const result = await caller(runtime, f.owner).telemetry.getSession({ session });
    expect(result.parentSession).toEqual({ id: parent, key: "parent" });
    expect(result.children).toEqual([{ id: grandchild, key: "grandchild" }]);
  });

  it("getSummary aggregates owner-visible requests and excludes hidden chats", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const usage = { inputTokens: 10, outputTokens: 5 };
    await insertRequest(runtime, ws, { requestId: "a", startedAt: at(10), durationMs: 100, ttftMs: 10, usage });
    await insertRequest(runtime, ws, { requestId: "b", startedAt: at(20), durationMs: 300, status: "error", usage });
    await insertRequest(runtime, ws, {
      requestId: "hidden",
      startedAt: at(30),
      durationMs: 9999,
      chat: f.memberPersonalChat,
      usage,
    });
    const summary = await caller(runtime, f.owner).telemetry.getSummary({ workspace: ws, since: 0 });
    expect(summary).toMatchObject({
      requests: 2,
      errors: 1,
      errorRate: 0.5,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      durationP50: 100,
      durationP95: 300,
      ttftP50: 10,
      truncated: false,
      topModels: [{ model: "provider/model", requests: 2 }],
    });
  });
});

describe("settings", () => {
  it("reads defaults, clears content flags when disabled, validates and keeps retention", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const api = caller(test.runtime, f.owner).telemetry;
    const workspace = f.workspace;
    expect(await api.getSettings({ workspace })).toEqual({
      enabled: false,
      recordInputs: false,
      recordOutputs: false,
      retentionDays: null,
    });

    await api.setSettings({ workspace, enabled: true, recordInputs: true, recordOutputs: true, retentionDays: 7 });
    expect(await api.getSettings({ workspace })).toEqual({
      enabled: true,
      recordInputs: true,
      recordOutputs: true,
      retentionDays: 7,
    });
    // Omitted retention keeps the stored value; disabling clears the content flags.
    await api.setSettings({ workspace, enabled: false, recordInputs: true, recordOutputs: true });
    expect(await api.getSettings({ workspace })).toEqual({
      enabled: false,
      recordInputs: false,
      recordOutputs: false,
      retentionDays: 7,
    });
    for (const retentionDays of [0, 1.5, 3651]) {
      await expect(
        api.setSettings({ workspace, enabled: true, recordInputs: false, recordOutputs: false, retentionDays }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Retention") });
    }
    await api.setSettings({ workspace, enabled: true, recordInputs: false, recordOutputs: true, retentionDays: null });
    expect(await api.getSettings({ workspace })).toMatchObject({ recordOutputs: true, retentionDays: null });
  });
});

describe("sealed envelopes in the object store", () => {
  it("stores an oversized envelope once as an object, reuses it, and returns it for the owner to open", async () => {
    const f = await telemetryWorkspace(test.runtime, { keyed: true });
    const { runtime } = test;
    const huge = { role: "user", content: "x".repeat(1_000_000) };

    const first = captureRequest(runtime, { workspace: f.workspace, userId: f.owner.id, messages: [huge] });
    await first.capture.finish({ status: "ok" });
    const second = captureRequest(runtime, {
      workspace: f.workspace,
      userId: f.owner.id,
      messages: [huge, { role: "assistant", content: "a" }, { role: "user", content: "next" }],
    });
    await second.capture.finish({ status: "ok" });

    const stored = await db()
      .select()
      .from(telemetryBlobs)
      .where(eq(telemetryBlobs.workspace, f.workspace));
    const objectRows = stored.filter((row) => row.storageKey !== null);
    expect(objectRows).toHaveLength(1);
    expect(objectRows[0]!.storageKey).toMatch(/^files\/[0-9a-f-]{36}$/);
    expect(objectRows[0]!.sealedEnvelope).toBeNull();
    const listed = await runtime.drivers.objects.list({ prefix: "files/", cursor: null, limit: 100 });
    expect(listed.keys.map((object) => object.key)).toContain(objectRows[0]!.storageKey);

    const row = await requestRow(runtime, f.workspace, first.requestId);
    const messages = await caller(runtime, f.owner).telemetry.getRequestMessages({ request: row!.id });
    const [node] = messages.nodes;
    // The local-disk store cannot presign, so the envelope comes inline.
    expect(node!.message.sealed).toMatchObject({ storageUrl: null, envelope: expect.any(String) });
    const opened = await openWireBlob(f.workspace, f.seed!, node!.message);
    expect(JSON.parse(opened.content!)).toEqual(huge);
  });
});
