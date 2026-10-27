/// <reference types="vite/client" />

import { register as registerMigrations } from "@convex-dev/migrations/test";
import { register as registerSecretStore } from "convex-secret-store/test";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

type AuthContext = {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier?: string; subject?: string } | null> };
};

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.tokenIdentifier ?? identity?.subject;
    return userId ? { _id: userId, email: `${userId}@example.invalid`, name: userId } : null;
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

afterEach(() => {
  vi.useRealTimers();
});

function makeTest() {
  const t = convexTest({ schema, modules });
  registerMigrations(t);
  registerSecretStore(t);
  return t;
}
type T = ReturnType<typeof makeTest>;

function asUser(t: T, userId: string) {
  return t.withIdentity({ tokenIdentifier: userId, subject: userId });
}

const DAY = 86_400_000;
const request = {
  source: "gateway",
  model: "m",
  stream: false,
  status: "ok",
  endedAt: 0,
  durationMs: 0,
  attempts: [],
  recordsInputs: true,
  recordsOutputs: true,
  lineage: { kind: "root" },
} as const;

async function counts(t: T) {
  return await t.run(async (ctx) => ({
    blobs: (await ctx.db.query("telemetry_blobs").collect()).length,
    nodes: (await ctx.db.query("telemetry_nodes").collect()).length,
    tools: (await ctx.db.query("telemetry_toolset_tools").collect()).length,
    requests: (await ctx.db.query("telemetry_requests").collect()).length,
    gc: (await ctx.db.query("telemetry_gc").collect()).length,
  }));
}

/** Two requests sharing a two-message prefix, system prompt, and toolset. */
async function sharedFixture(t: T) {
  return await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "W",
    });
    const blob = (hash: string, kind: "message" | "system" | "tool" | "toolset" | "params") =>
      ctx.db.insert("telemetry_blobs", { workspace, hash, kind, size: 1, content: "1" });
    const [m1, m2, m3a, m3b, system, params, toolset, toolA, toolB] = await Promise.all([
      blob("m1", "message"),
      blob("m2", "message"),
      blob("m3a", "message"),
      blob("m3b", "message"),
      blob("sys", "system"),
      blob("params", "params"),
      blob("toolset", "toolset"),
      blob("toolA", "tool"),
      blob("toolB", "tool"),
    ]);
    await ctx.db.insert("telemetry_toolset_tools", {
      workspace,
      toolset,
      tool: toolA,
      position: 0,
    });
    await ctx.db.insert("telemetry_toolset_tools", {
      workspace,
      toolset,
      tool: toolB,
      position: 1,
    });
    const n1 = await ctx.db.insert("telemetry_nodes", {
      workspace,
      hash: "n1",
      blob: m1,
      depth: 1,
      origin: "input",
    });
    const n2 = await ctx.db.insert("telemetry_nodes", {
      workspace,
      hash: "n2",
      parent: n1,
      blob: m2,
      depth: 2,
      origin: "input",
    });
    const n3a = await ctx.db.insert("telemetry_nodes", {
      workspace,
      hash: "n3a",
      parent: n2,
      blob: m3a,
      depth: 3,
      origin: "input",
    });
    const n3b = await ctx.db.insert("telemetry_nodes", {
      workspace,
      hash: "n3b",
      parent: n2,
      blob: m3b,
      depth: 3,
      origin: "input",
    });
    const shared = { workspace, system, params, toolset, startedAt: 1 };
    const a = await ctx.db.insert("telemetry_requests", {
      ...request,
      ...shared,
      requestId: "a",
      input: n3a,
    });
    const b = await ctx.db.insert("telemetry_requests", {
      ...request,
      ...shared,
      requestId: "b",
      input: n3b,
    });
    return { workspace, a, b };
  });
}

test("GC keeps shared prefix nodes and blobs until the last request is deleted", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const ids = await sharedFixture(t);
  const owner = asUser(t, "owner");
  const before = await counts(t);
  expect(before).toMatchObject({ blobs: 9, nodes: 4, tools: 2, requests: 2 });

  await owner.mutation(anyApi.observability.telemetryRetention.deleteRequest, { request: ids.a });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  // Only A's private leaf node and message blob go.
  expect(await counts(t)).toEqual({ blobs: 8, nodes: 3, tools: 2, requests: 1, gc: 0 });

  await owner.mutation(anyApi.observability.telemetryRetention.deleteRequest, { request: ids.b });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await counts(t)).toEqual({ blobs: 0, nodes: 0, tools: 0, requests: 0, gc: 0 });
});

test("retention deletes only expired requests of workspaces with retentionDays", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const kept = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "o",
      name: "keep",
    });
    const pruned = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "o",
      name: "prune",
    });
    const settings = { builtinToolSets: [], mcpServers: [] };
    await ctx.db.insert("workspace_settings", { workspace: kept, ...settings });
    await ctx.db.insert("workspace_settings", {
      workspace: pruned,
      ...settings,
      telemetry: { enabled: true, recordInputs: true, recordOutputs: true, retentionDays: 7 },
    });
    const insert = (workspace: Id<"workspaces">, requestId: string, startedAt: number) =>
      ctx.db.insert("telemetry_requests", { ...request, workspace, requestId, startedAt });
    const old = now - 8 * DAY;
    const recent = now - 6 * DAY;
    const keptOld = await insert(kept, "old", old);
    const prunedOld = await insert(pruned, "old", old);
    const prunedRecent = await insert(pruned, "recent", recent);
    const oldSession = await ctx.db.insert("telemetry_sessions", {
      workspace: pruned,
      key: "s",
      startedAt: old,
    });
    return { keptOld, prunedOld, prunedRecent, oldSession };
  });

  await t.mutation(anyApi.observability.telemetryRetention.pruneExpired, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await t.run(async (ctx) => ({
    keptOld: await ctx.db.get(ids.keptOld),
    prunedOld: await ctx.db.get(ids.prunedOld),
    prunedRecent: await ctx.db.get(ids.prunedRecent),
    oldSession: await ctx.db.get(ids.oldSession),
  }));
  expect(rows.keptOld).not.toBeNull();
  expect(rows.prunedRecent).not.toBeNull();
  expect(rows.prunedOld).toBeNull();
  expect(rows.oldSession).toBeNull();
});

test("deleteRequest is owner-only and hides requests of other users' personal chats", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "W",
    });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    const chat = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      messages: [],
      chat_completions: [],
      activeStream: false,
      lastInteractionAt: 1,
    });
    const plain = await ctx.db.insert("telemetry_requests", {
      ...request,
      workspace,
      requestId: "plain",
      startedAt: 1,
    });
    const hidden = await ctx.db.insert("telemetry_requests", {
      ...request,
      workspace,
      requestId: "hidden",
      startedAt: 1,
      chatId: chat,
    });
    return { plain, hidden };
  });
  const remove = anyApi.observability.telemetryRetention.deleteRequest;

  await expect(asUser(t, "member").mutation(remove, { request: ids.plain })).rejects.toThrow(
    "Workspace not found.",
  );
  await expect(asUser(t, "owner").mutation(remove, { request: ids.hidden })).rejects.toThrow(
    "Request not found.",
  );
  await asUser(t, "owner").mutation(remove, { request: ids.plain });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await t.run(async (ctx) => ({
    plain: await ctx.db.get(ids.plain),
    hidden: await ctx.db.get(ids.hidden),
  }));
  expect(rows.plain).toBeNull();
  expect(rows.hidden).not.toBeNull();
});

test("telemetryTracesToRequests converts traces, truncated payloads, and balance-only traces", async () => {
  const t = makeTest();
  const longInput = JSON.stringify({ text: "x".repeat(32_000) }).slice(0, 32_000);
  const ids = await t.run(async (ctx) => {
    const balance = await ctx.db.insert("balances", { credits: 0, userId: "owner" });
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "W",
      legacyBalance: balance,
    });
    const base = {
      userId: "owner",
      source: "gateway" as const,
      callId: "c",
      operationId: "o",
      functionId: "f",
      provider: "p",
      model: "m",
      recordsInputs: true,
      recordsOutputs: true,
    };
    const explicit = await ctx.db.insert("telemetry_traces", {
      ...base,
      workspace,
      requestId: "explicit",
      status: "running",
      startedAt: 100,
    });
    const span = await ctx.db.insert("telemetry_spans", {
      trace: explicit,
      workspace,
      kind: "model",
      name: "gen",
      status: "ok",
      startedAt: 101,
      endedAt: 102,
      durationMs: 1,
    });
    await ctx.db.insert("telemetry_payloads", {
      trace: explicit,
      inputJson: longInput,
      outputJson: '{"ok":true}',
    });
    await ctx.db.insert("telemetry_payloads", { trace: explicit, span, outputJson: "plain text" });
    const legacy = await ctx.db.insert("telemetry_traces", {
      ...base,
      balance,
      requestId: "legacy",
      status: "ok",
      startedAt: 200,
      endedAt: 250,
      durationMs: 50,
      error: "boom",
    });
    const orphan = await ctx.db.insert("telemetry_traces", {
      ...base,
      requestId: "orphan",
      status: "ok",
      startedAt: 300,
    });
    return { workspace, explicit, legacy, orphan };
  });

  await t.mutation(anyApi.migrations.telemetryTracesToRequests, {
    cursor: null,
    batchSize: 10,
    dryRun: false,
    oneBatchOnly: true,
  });

  const result = await t.run(async (ctx) => {
    const requests = await ctx.db.query("telemetry_requests").collect();
    const blobs = await ctx.db.query("telemetry_blobs").collect();
    return {
      requests,
      blobs,
      traces: await ctx.db.query("telemetry_traces").collect(),
      spans: await ctx.db.query("telemetry_spans").collect(),
      payloads: await ctx.db.query("telemetry_payloads").collect(),
    };
  });
  expect(result.traces).toHaveLength(0);
  expect(result.spans).toHaveLength(0);
  expect(result.payloads).toHaveLength(0);
  expect(result.requests.map((r) => r.requestId).sort()).toEqual(["explicit", "legacy"]);

  const explicit = result.requests.find((r) => r.requestId === "explicit")!;
  expect(explicit).toMatchObject({
    workspace: ids.workspace,
    status: "error",
    error: { message: "interrupted before completion" },
    endedAt: 100,
    durationMs: 0,
    lineage: { kind: "root" },
    legacy: { traceId: ids.explicit },
  });
  const blob = (id: Id<"telemetry_blobs"> | undefined) => result.blobs.find((b) => b._id === id)!;
  expect(blob(explicit.legacy?.input).truncated).toBe(true);
  expect(blob(explicit.legacy?.output).truncated).toBeUndefined();
  expect(blob(explicit.legacy?.output).content).toBe('{"ok":true}');
  const spans = JSON.parse(blob(explicit.legacy?.spans).content!);
  expect(spans[0]).toMatchObject({ name: "gen", output: "plain text" });

  const legacy = result.requests.find((r) => r.requestId === "legacy")!;
  expect(legacy).toMatchObject({
    workspace: ids.workspace,
    status: "ok",
    endedAt: 250,
    durationMs: 50,
    error: { message: "boom" },
  });
});
