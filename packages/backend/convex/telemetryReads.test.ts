/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
import schema from "./schema";

type TestIdentity = { tokenIdentifier?: string; subject?: string; email?: string; name?: string };
type AuthContext = { auth: { getUserIdentity: () => Promise<TestIdentity | null> } };

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.tokenIdentifier ?? identity?.subject;
    if (!identity || !userId) return null;
    return {
      _id: userId,
      email: identity.email ?? `${userId}@example.invalid`,
      name: identity.name ?? userId,
    };
  });
  return { getAuthUser, getAnyUserById: vi.fn(), safeGetAuthUser: getAuthUser };
});

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: authMock.getAuthUser,
    getAnyUserById: authMock.getAnyUserById,
    safeGetAuthUser: authMock.safeGetAuthUser,
  },
}));

const modules = import.meta.glob("./**/*.ts");

function makeTest() {
  return convexTest({ schema, modules });
}

function asUser(t: ReturnType<typeof makeTest>, userId: string) {
  return t.withIdentity({
    tokenIdentifier: userId,
    subject: userId,
    email: `${userId}@example.invalid`,
    name: userId,
  });
}

type Ctx = Parameters<Parameters<ReturnType<typeof makeTest>["run"]>[0]>[0];
type RequestFields = Partial<Doc<"telemetry_requests">> & { requestId: string };

async function workspaceFixture(t: ReturnType<typeof makeTest>) {
  return await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Telemetry",
    });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    const chat = (userId: string, scope: "personal" | "workspace") =>
      ctx.db.insert("aisdk_chats", {
        userId,
        workspace,
        scope,
        activeStream: false,
        lastInteractionAt: 1,
      });
    return {
      workspace,
      sharedChat: await chat("owner", "workspace"),
      memberPersonalChat: await chat("member", "personal"),
    };
  });
}

function insertBlob(
  ctx: Ctx,
  workspace: Id<"workspaces">,
  kind: Doc<"telemetry_blobs">["kind"],
  hash: string,
  value?: unknown,
  meta?: Doc<"telemetry_blobs">["meta"],
) {
  const content = value === undefined ? undefined : JSON.stringify(value);
  return ctx.db.insert("telemetry_blobs", {
    workspace,
    hash,
    kind,
    size: content?.length ?? 0,
    content,
    meta,
  });
}

function insertRequest(ctx: Ctx, workspace: Id<"workspaces">, fields: RequestFields) {
  return ctx.db.insert("telemetry_requests", {
    workspace,
    source: "gateway",
    model: "provider/model",
    stream: false,
    status: "ok",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    attempts: [],
    recordsInputs: true,
    recordsOutputs: true,
    lineage: { kind: "root" },
    ...fields,
  });
}

test("listRequests pages newest first, filters by status, and hides other users' private chats", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const requests = await t.run(async (ctx) => ({
    plain: await insertRequest(ctx, ids.workspace, { requestId: "a", startedAt: 100 }),
    hidden: await insertRequest(ctx, ids.workspace, {
      requestId: "b",
      startedAt: 200,
      chatId: ids.memberPersonalChat,
    }),
    shared: await insertRequest(ctx, ids.workspace, {
      requestId: "c",
      startedAt: 300,
      chatId: ids.sharedChat,
    }),
    failed: await insertRequest(ctx, ids.workspace, {
      requestId: "d",
      startedAt: 400,
      status: "error",
      error: { message: "boom", status: 500 },
    }),
  }));
  const owner = asUser(t, "owner");

  const first = await owner.query(api.observability.telemetry.listRequests, {
    workspace: ids.workspace,
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(first.page.map((row) => row._id)).toEqual([requests.failed, requests.shared]);
  expect(first.isDone).toBe(false);

  const second = await owner.query(api.observability.telemetry.listRequests, {
    workspace: ids.workspace,
    paginationOpts: { numItems: 2, cursor: first.continueCursor },
  });
  expect(second.page.map((row) => row._id)).toEqual([requests.plain]);

  const errors = await owner.query(api.observability.telemetry.listRequests, {
    workspace: ids.workspace,
    status: "error",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(errors.page.map((row) => row._id)).toEqual([requests.failed]);

  for (const user of ["member", "outsider"]) {
    await expect(
      asUser(t, user).query(api.observability.telemetry.listRequests, {
        workspace: ids.workspace,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow();
    await expect(
      asUser(t, user).query(api.observability.telemetry.getRequest, { request: requests.plain }),
    ).rejects.toThrow();
  }
  await expect(
    owner.query(api.observability.telemetry.getRequest, { request: requests.hidden }),
  ).rejects.toThrow("Request not found.");
  await expect(
    owner.query(api.observability.telemetry.getRequestMessages, { request: requests.hidden }),
  ).rejects.toThrow("Request not found.");
});

test("getRequest resolves system and params changes and diffs the toolset", async () => {
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const requestId = await t.run(async (ctx) => {
    // JSON Schema keys such as `$schema` are not valid Convex field names.
    const tool = (name: string, version: number) =>
      insertBlob(ctx, workspace, "tool", `tool-${name}-${version}`, {
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
    const before = await insertBlob(ctx, workspace, "toolset", "set-before", []);
    const after = await insertBlob(ctx, workspace, "toolset", "set-after", []);
    const members = (set: Id<"telemetry_blobs">, tools: Id<"telemetry_blobs">[]) =>
      Promise.all(
        tools.map((toolId, position) =>
          ctx.db.insert("telemetry_toolset_tools", {
            workspace,
            toolset: set,
            tool: toolId,
            position,
          }),
        ),
      );
    await members(before, [weatherV1, search]);
    await members(after, [search, weatherV2, calc]);

    const systemBefore = await insertBlob(ctx, workspace, "system", "sys-1", [
      { role: "system", content: "Be brief." },
    ]);
    const systemAfter = await insertBlob(ctx, workspace, "system", "sys-2", [
      { role: "system", content: "Be thorough." },
    ]);
    const paramsBefore = await insertBlob(ctx, workspace, "params", "params-1", { temperature: 0 });
    const paramsAfter = await insertBlob(ctx, workspace, "params", "params-2", {
      temperature: 0.7,
      top_p: 0.9,
    });

    const previous = await insertRequest(ctx, workspace, { requestId: "previous", startedAt: 10 });
    return await insertRequest(ctx, workspace, {
      requestId: "current",
      startedAt: 20,
      toolset: after,
      system: systemAfter,
      params: paramsAfter,
      lineage: { kind: "continue", request: previous },
      changes: {
        previous,
        system: { from: systemBefore, to: systemAfter },
        params: { from: paramsBefore, to: paramsAfter },
        toolset: { from: before, to: after },
        model: { from: "old/model", to: "provider/model" },
      },
    });
  });

  const result = await asUser(t, "owner").query(api.observability.telemetry.getRequest, {
    request: requestId,
  });

  expect(result.summary.changedFields.sort()).toEqual(["model", "params", "system", "toolset"]);
  expect(result.related).toMatchObject({ startedAt: 10 });
  const parsed = (blob: { content?: string } | null | undefined) =>
    blob?.content === undefined ? undefined : JSON.parse(blob.content);
  expect(parsed(result.changes?.system?.from)).toEqual([{ role: "system", content: "Be brief." }]);
  expect(parsed(result.changes?.system?.to)).toEqual([{ role: "system", content: "Be thorough." }]);
  expect(parsed(result.changes?.params?.from)).toEqual({ temperature: 0 });
  expect(parsed(result.changes?.params?.to)).toEqual({ temperature: 0.7, top_p: 0.9 });
  expect(parsed(result.tools[1]?.blob)).toMatchObject({
    function: { parameters: { $schema: "http://json-schema.org/draft-07/schema#" } },
  });
  expect(result.changes?.model).toEqual({ from: "old/model", to: "provider/model" });
  expect(result.tools.map((tool) => tool.name)).toEqual(["search", "get_weather", "calc"]);

  const tools = result.changes?.tools;
  expect(tools?.added.map((tool) => tool.name)).toEqual(["calc"]);
  expect(tools?.removed).toEqual([]);
  expect(tools?.changed.map((tool) => tool.name)).toEqual(["get_weather"]);
  expect(tools?.changed[0].before.hash).toBe("tool-get_weather-1");
  expect(tools?.changed[0].after.hash).toBe("tool-get_weather-2");
  expect(tools?.reordered).toBe(true);
});

test("getRequestMessages pages newest first, marks new nodes, and rejects off-chain cursors", async () => {
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const ids = await t.run(async (ctx) => {
    const nodes: Id<"telemetry_nodes">[] = [];
    let parent: Id<"telemetry_nodes"> | undefined;
    for (let depth = 1; depth <= 5; depth++) {
      const blob = await insertBlob(ctx, workspace, "message", `msg-${depth}`, {
        role: "user",
        content: `message ${depth}`,
      });
      parent = await ctx.db.insert("telemetry_nodes", {
        workspace,
        hash: `node-${depth}`,
        parent,
        blob,
        depth,
        origin: "input",
      });
      nodes.push(parent);
    }
    // A sibling of depth 4 from another branch.
    const otherBlob = await insertBlob(ctx, workspace, "message", "msg-4b", { role: "user" });
    const sibling = await ctx.db.insert("telemetry_nodes", {
      workspace,
      hash: "node-4b",
      parent: nodes[2],
      blob: otherBlob,
      depth: 4,
      origin: "input",
    });
    const first = await insertRequest(ctx, workspace, {
      requestId: "first",
      startedAt: 1,
      input: nodes[3],
      output: nodes[4],
    });
    const second = await insertRequest(ctx, workspace, {
      requestId: "second",
      startedAt: 2,
      input: nodes[4],
      lineage: { kind: "continue", request: first },
    });
    return { nodes, sibling, second };
  });
  const owner = asUser(t, "owner");

  const newest = await owner.query(api.observability.telemetry.getRequestMessages, {
    request: ids.second,
    limit: 2,
  });
  expect(newest.nodes.map((node) => node.depth)).toEqual([4, 5]);
  // The first request already stored depth 4 as input and depth 5 as its output.
  expect(newest.prefixDepth).toBe(5);
  expect(newest.nodes.map((node) => node.isNew)).toEqual([false, false]);
  expect(newest.more).toBe(true);
  expect(newest.total).toBe(5);

  const older = await owner.query(api.observability.telemetry.getRequestMessages, {
    request: ids.second,
    cursor: newest.nextCursor,
    limit: 10,
  });
  expect(older.nodes.map((node) => node.depth)).toEqual([1, 2, 3]);
  expect(JSON.parse(older.nodes[0]!.message.content!)).toEqual({
    role: "user",
    content: "message 1",
  });
  expect(older.more).toBe(false);

  await expect(
    owner.query(api.observability.telemetry.getRequestMessages, {
      request: ids.second,
      cursor: ids.sibling,
    }),
  ).rejects.toThrow("Invalid message cursor.");
});

test("getSession groups a rollback and a retry into separate branches", async () => {
  const t = makeTest();
  const { workspace } = await workspaceFixture(t);
  const ids = await t.run(async (ctx) => {
    const node = async (
      key: string,
      depth: number,
      parent: Id<"telemetry_nodes"> | undefined,
      origin: "input" | "output" = "input",
    ) =>
      ctx.db.insert("telemetry_nodes", {
        workspace,
        hash: key,
        parent,
        depth,
        origin,
        blob: await insertBlob(ctx, workspace, "message", `blob-${key}`),
      });
    const n1 = await node("n1", 1, undefined);
    const n2 = await node("n2", 2, n1);
    const n3 = await node("n3", 3, n2);
    const n4 = await node("n4", 4, n3, "output");
    const n5 = await node("n5", 5, n4);
    const n6 = await node("n6", 6, n5, "output");
    // After rolling back to depth 3 the client sends a different depth-4 message.
    const n4b = await node("n4b", 4, n3);
    const n5b = await node("n5b", 5, n4b, "output");
    const n6b = await node("n6b", 6, n5b);

    const session = await ctx.db.insert("telemetry_sessions", {
      workspace,
      key: "session-1",
      startedAt: 100,
    });
    const r = (requestId: string, startedAt: number, fields: Partial<Doc<"telemetry_requests">>) =>
      insertRequest(ctx, workspace, { requestId, startedAt, session, ...fields });
    const r1 = await r("r1", 100, { input: n3, output: n4 });
    const r2 = await r("r2", 200, {
      input: n5,
      output: n6,
      lineage: { kind: "continue", request: r1 },
    });
    const r3 = await r("r3", 300, {
      input: n4b,
      output: n5b,
      lineage: { kind: "branch", request: r2, depth: 3 },
    });
    const r4 = await r("r4", 400, {
      input: n6b,
      lineage: { kind: "continue", request: r3 },
    });
    const r5 = await r("r5", 500, {
      input: n6b,
      lineage: { kind: "retry", request: r4 },
    });
    return { session, r1, r2, r3, r4, r5 };
  });

  const result = await asUser(t, "owner").query(api.observability.telemetry.getSession, {
    session: ids.session,
  });

  expect(result.requests.map((row) => [row._id, row.newMessages])).toEqual([
    [ids.r1, 3],
    [ids.r2, 1],
    [ids.r3, 1],
    [ids.r4, 1],
    [ids.r5, 0],
  ]);
  expect(result.lanes).toEqual([
    {
      id: ids.r1,
      kind: "root",
      parentLane: null,
      forkRequest: null,
      forkDepth: 0,
      requests: [ids.r1, ids.r2],
    },
    {
      id: ids.r3,
      kind: "branch",
      parentLane: ids.r1,
      forkRequest: ids.r2,
      forkDepth: 3,
      requests: [ids.r3, ids.r4],
    },
    {
      id: ids.r5,
      kind: "retry",
      parentLane: ids.r3,
      forkRequest: ids.r4,
      forkDepth: 6,
      requests: [ids.r5],
    },
  ]);

  const sessions = await asUser(t, "owner").query(api.observability.telemetry.listSessions, {
    workspace: await t.run(
      async (ctx) => (await ctx.db.get("telemetry_sessions", ids.session))!.workspace,
    ),
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(sessions.page).toMatchObject([{ key: "session-1", requestCount: 5, lastRequestAt: 500 }]);
});

test("getSummary aggregates owner-visible requests and excludes hidden chats", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  await t.run(async (ctx) => {
    const base = { usage: { inputTokens: 10, outputTokens: 5 } };
    await insertRequest(ctx, ids.workspace, {
      requestId: "a",
      startedAt: 10,
      durationMs: 100,
      ttftMs: 10,
      ...base,
    });
    await insertRequest(ctx, ids.workspace, {
      requestId: "b",
      startedAt: 20,
      durationMs: 300,
      status: "error",
      ...base,
    });
    await insertRequest(ctx, ids.workspace, {
      requestId: "hidden",
      startedAt: 30,
      durationMs: 9999,
      chatId: ids.memberPersonalChat,
      ...base,
    });
  });
  const summary = await asUser(t, "owner").query(api.observability.telemetry.getSummary, {
    workspace: ids.workspace,
    since: 0,
  });
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
