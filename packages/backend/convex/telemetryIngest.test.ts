/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { decodeCapsule, generateEncryptionKeyPair, openCapsule, openWithCapsule } from "radium-crypto";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import schema from "./schema";
import { startCapture } from "../src/telemetry/capture";
import { blobHash, nodeHash } from "../src/telemetry/hash";
import { canonicalJson } from "../src/telemetry/canonical";
import { loadBlob, loadChain, loadToolset } from "../src/telemetry/store";
import type { LoadedBlob } from "contracts/telemetry/store";
import type { TelemetryAttempt, TelemetrySettings } from "contracts/telemetry/validators";

vi.mock("./auth", () => ({
  authComponent: { getAuthUser: vi.fn(), getAnyUserById: vi.fn(), safeGetAuthUser: vi.fn() },
}));

const modules = import.meta.glob("./**/*.ts");
type TestConvex = ReturnType<typeof makeTest>;
type Message = Record<string, unknown>;

function makeTest() {
  return convexTest({ schema, modules });
}

const recordAll: TelemetrySettings = { enabled: true, recordInputs: true, recordOutputs: true };
const recordNothing: TelemetrySettings = {
  enabled: true,
  recordInputs: false,
  recordOutputs: false,
};
const session = { primary: "header:session-1", isSubagent: false };

let clock = 0;
let requestCount = 0;
const seeds = new Map<string, Uint8Array>();
let priorSecret: string | undefined;

// Scheduled export deliveries must not run: they belong to the export slice's own tests.
beforeEach(() => {
  priorSecret = process.env.TELEMETRY_HASH_SECRET;
  process.env.TELEMETRY_HASH_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  vi.useFakeTimers();
  clock = 1_000;
  requestCount = 0;
});
afterEach(() => {
  if (priorSecret === undefined) delete process.env.TELEMETRY_HASH_SECRET;
  else process.env.TELEMETRY_HASH_SECRET = priorSecret;
  seeds.clear();
  vi.useRealTimers();
});

/** An action context whose Convex calls run against the in-memory test backend. */
function actionCtx(t: TestConvex) {
  return {
    runQuery: (fn: Parameters<TestConvex["query"]>[0], args: Parameters<TestConvex["query"]>[1]) =>
      t.query(fn, args),
    runMutation: (
      fn: Parameters<TestConvex["mutation"]>[0],
      args: Parameters<TestConvex["mutation"]>[1],
    ) => t.mutation(fn, args),
    storage: { store: (blob: Blob) => t.run((ctx) => ctx.storage.store(blob)) },
  } as unknown as ActionCtx;
}

async function makeWorkspace(t: TestConvex) {
  const keys = await generateEncryptionKeyPair();
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Workspace", keyEpoch: 1 });
    await ctx.db.insert("e2ee_workspace_epochs", {
      workspace, epoch: 1, suite: 1, memberKeyId: "member", ownerKeyId: "owner",
      memberPublicKey: keys.publicKey.slice().buffer as ArrayBuffer,
      ownerPublicKey: keys.publicKey.slice().buffer as ArrayBuffer,
      createdBy: "owner", createdAt: 1,
    });
    return workspace;
  });
  seeds.set(workspace, keys.seed);
  return workspace;
}

async function openBlob(workspace: Id<"workspaces">, blob: LoadedBlob | null) {
  if (!blob?.sealed?.envelope) return undefined;
  const sealed = blob.sealed;
  const capsuleKey = await openCapsule({
    seed: seeds.get(workspace)!,
    capsule: decodeCapsule(new Uint8Array(sealed.capsule)),
    aad: { table: "telemetry_capsules", workspace, parent: sealed.requestId, record: sealed.requestId, field: "capsule" },
  });
  const bytes = await openWithCapsule({
    capsuleKey, envelope: new Uint8Array(sealed.envelope!),
    aad: { table: "telemetry_blobs", workspace, parent: sealed.requestId, record: blob.hash, field: "content" },
    pad: "content",
  });
  return JSON.parse(new TextDecoder().decode(bytes)) as { content?: string; meta?: unknown };
}

async function value(workspace: Id<"workspaces">, blob: LoadedBlob | null) {
  const content = (await openBlob(workspace, blob))?.content;
  return content === undefined ? undefined : JSON.parse(content);
}

test("capture seals content and binds its envelope to the workspace and hash", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const request = await record(t, { workspace, body: body([user("sensitive prompt")]) });
  const loaded = await t.run(async (ctx) => {
    const node = await ctx.db.get("telemetry_nodes", request.input!);
    return loadBlob(ctx, workspace, node!.blob);
  });
  expect(loaded?.content).toBeUndefined();
  expect(loaded?.meta).toBeUndefined();
  expect(await value(workspace, loaded)).toEqual(user("sensitive prompt"));
  await expect(openBlob(workspace, { ...loaded!, hash: "wrong" })).rejects.toThrow();
});

test("capture suppresses plaintext without an owner key", async () => {
  const t = makeTest();
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "keyless" }),
  );
  const request = await record(t, { workspace, body: body([user("secret")]) });
  const stored = await counts(t, workspace);
  expect(stored.blobs.every((blob) => !blob.content && !blob.meta && !blob.storage && !blob.sealed)).toBe(true);
  expect(request.sealedError).toBeUndefined();
});

test("missing deployment hash secret fails closed without writing telemetry", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  delete process.env.TELEMETRY_HASH_SECRET;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const capture = startCapture(actionCtx(t), {
    workspace, userId: "owner", requestId: "missing-secret", settings: recordAll,
  }, {
    rawBody: body([user("secret")]), source: "gateway", model: "model", stream: false, startedAt: 1,
  });
  await capture.finish({ status: "ok" });
  expect((await counts(t, workspace)).blobs).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("telemetry_requests").collect())).toHaveLength(0);
  errors.mockRestore();
});

type RecordInput = {
  workspace: Id<"workspaces">;
  body: Record<string, unknown>;
  /** Assistant text returned for the request. */
  output?: string;
  requestId?: string;
  settings?: TelemetrySettings;
  headers?: Record<string, string>;
  sessionKey?: { primary: string; fallback?: string; isSubagent: boolean } | null;
  attempts?: TelemetryAttempt[];
};

/** Run one request through capture exactly as the gateway does, then return its stored row. */
async function record(t: TestConvex, input: RecordInput) {
  const requestId = input.requestId ?? `request-${++requestCount}`;
  const capture = startCapture(
    actionCtx(t),
    {
      workspace: input.workspace,
      userId: "owner",
      requestId,
      settings: input.settings ?? recordAll,
    },
    {
      rawBody: input.body,
      headers: new Headers(input.headers),
      session: input.sessionKey === null ? undefined : (input.sessionKey ?? session),
      source: "gateway",
      model: String(input.body.model),
      stream: false,
      startedAt: ++clock,
    },
  );
  for (const attempt of input.attempts ?? []) capture.attempt(attempt);
  if (input.output !== undefined) {
    capture.outputResponse({
      id: "provider-response",
      created: 1,
      model: "m",
      object: "chat.completion",
      usage: {},
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: input.output } },
      ],
    });
  }
  await capture.finish({ status: "ok" });

  const row = await t.run((ctx) =>
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_workspace_and_requestId", (q) =>
        q.eq("workspace", input.workspace).eq("requestId", requestId),
      )
      .unique(),
  );
  if (!row) throw new Error("Request was not captured.");
  return row;
}

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

function body(messages: Message[], extra: Record<string, unknown> = {}) {
  return { model: "provider/model", messages, ...extra };
}

/** Node hashes at depth 1..n for a message chain, as capture computes them. */
async function chainHashes(workspace: Id<"workspaces">, messages: Message[]) {
  const hashes: string[] = [];
  let parent: string | undefined;
  for (const message of messages) {
    const blob = await blobHash(workspace, "message", canonicalJson(message));
    parent = await nodeHash(workspace, parent, blob);
    hashes.push(parent);
  }
  return hashes;
}

function counts(t: TestConvex, workspace: Id<"workspaces">) {
  return t.run(async (ctx) => {
    const nodes = await ctx.db.query("telemetry_nodes").collect();
    const blobs = await ctx.db.query("telemetry_blobs").collect();
    return {
      nodes: nodes.filter((node) => node.workspace === workspace).length,
      messageBlobs: blobs.filter((blob) => blob.workspace === workspace && blob.kind === "message")
        .length,
      blobs: blobs.filter((blob) => blob.workspace === workspace),
    };
  });
}

test("a decomposed request reassembles into the original body", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const original = {
    model: "provider/model",
    stream: true,
    temperature: 0.2,
    top_k: 40,
    reasoning: { effort: "high" },
    metadata: { trace: "x" },
    vendor_extension: { a: [1, 2, { b: null }] },
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "developer", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "system", content: "a later system message stays in the chain" },
      { role: "user", content: "thanks" },
    ],
    tools: [
      { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
      { type: "function", function: { name: "other", description: "o" } },
    ],
  };

  const request = await record(t, { workspace, body: original });

  const reassembled = await t.run(async (ctx) => {
    const system = await loadBlob(ctx, workspace, request.system);
    const { nodes } = await loadChain(ctx, workspace, request.input, 100);
    const tools = await loadToolset(ctx, workspace, request.toolset);
    const params = await loadBlob(ctx, workspace, request.params);
    return {
      ...(await value(workspace, params) as object),
      messages: [
        ...(await value(workspace, system) as unknown[]),
        ...(await Promise.all(nodes.map((node) => value(workspace, node.message)))),
      ],
      tools: await Promise.all(tools.map((tool) => value(workspace, tool))),
    };
  });
  expect(reassembled).toEqual(original);
});

test("shared prefixes are stored once per workspace and never across workspaces", async () => {
  const t = makeTest();
  const first = await makeWorkspace(t);
  const second = await makeWorkspace(t);
  const prefix = [user("u1"), assistant("a1"), user("u2")];
  const tools = [{ type: "function", function: { name: "lookup" } }];
  const system = { role: "system", content: "rules" };

  const short = await record(t, {
    workspace: first,
    body: body([system, ...prefix], { tools }),
  });
  const long = await record(t, {
    workspace: first,
    body: body([system, ...prefix, assistant("a2"), user("u3")], { tools }),
  });

  expect(await counts(t, first)).toMatchObject({ nodes: 5, messageBlobs: 5 });
  expect(long.system).toBe(short.system);
  expect(long.toolset).toBe(short.toolset);
  expect(long.params).toBe(short.params);

  const other = await record(t, { workspace: second, body: body([system, ...prefix], { tools }) });
  expect(await counts(t, second)).toMatchObject({ nodes: 3, messageBlobs: 3 });
  expect(other.system).not.toBe(short.system);
  const hashes = await t.run(async (ctx) => {
    const a = await ctx.db.get("telemetry_blobs", short.system!);
    const b = await ctx.db.get("telemetry_blobs", other.system!);
    return [a?.hash, b?.hash];
  });
  expect(hashes[0]).not.toBe(hashes[1]);
});

test("prefix search returns the deepest stored depth for empty, partial, and full chains", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const stored = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")];
  await record(t, { workspace, body: body(stored) });

  const search = (messages: Message[]) =>
    chainHashes(workspace, messages).then((hashes) =>
      t.query(internal.observability.telemetryIngest.deepestExistingPrefix, { workspace, hashes }),
    );

  expect((await search([])).depth).toBe(0);
  expect((await search([user("unknown")])).depth).toBe(0);
  const partial = await search([...stored.slice(0, 3), assistant("diverges"), user("u3")]);
  expect(partial.depth).toBe(3);
  const full = await search(stored);
  expect(full.depth).toBe(5);
  expect(full.node).toBeDefined();
  expect((await search([...stored, user("more")])).depth).toBe(5);
});

test("lineage classifies continue, retry, rewrite, branch, compacted, and root", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const [u1, a1, u2, a2x, u3, a3, u4, uZ] = [
    user("u1"),
    assistant("a1"),
    user("u2"),
    assistant("a2x"),
    user("u3"),
    assistant("a3"),
    user("u4"),
    user("uZ"),
  ];

  const root = await record(t, { workspace, body: body([u1]), output: "a1" });
  expect(root.lineage).toEqual({ kind: "root" });

  const next = await record(t, { workspace, body: body([u1, a1, u2]), output: "a2" });
  expect(next.lineage).toEqual({ kind: "continue", request: root._id, depth: 2 });

  const retry = await record(t, { workspace, body: body([u1, a1, u2]), output: "a2 again" });
  expect(retry.lineage).toEqual({ kind: "retry", request: next._id, depth: 3 });

  const rewrite = await record(t, {
    workspace,
    body: body([u1, a1, u2, a2x, u3]),
    output: "a3",
  });
  expect(rewrite.lineage).toEqual({ kind: "rewrite", request: retry._id, depth: 3 });

  const resumed = await record(t, {
    workspace,
    body: body([u1, a1, u2, a2x, u3, a3, u4]),
    output: "a4",
  });
  expect(resumed.lineage).toEqual({ kind: "continue", request: rewrite._id, depth: 6 });

  // Rolling back to an interior message that never ended a request starts a sibling branch.
  const branch = await record(t, { workspace, body: body([u1, a1, u2, a2x, uZ]), output: "az" });
  expect(branch.lineage).toEqual({ kind: "branch", request: resumed._id, depth: 4 });

  const compacted = await record(t, {
    workspace,
    body: body([user("summary of everything so far")]),
  });
  expect(compacted.lineage).toEqual({ kind: "compacted" });

  // Rolling back to an earlier output that later turns already continued is also a branch.
  const rollback = await record(t, {
    workspace,
    body: body([u1, a1, u2, a2x, u3, a3, user("other path")]),
    output: "a5",
  });
  expect(rollback.lineage).toEqual({ kind: "branch", request: rewrite._id, depth: 6 });

  // Both branches stay stored under the shared parent.
  const children = await t.run(async (ctx) => {
    const nodes = await ctx.db.query("telemetry_nodes").collect();
    const parent = nodes.find((node) => node.depth === 4 && node.origin === "input");
    return nodes.filter((node) => node.parent === parent?._id).length;
  });
  expect(children).toBe(2);
});

test("system prompt, tool, parameter, and model changes are detected against the previous request", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const lookup = { type: "function", function: { name: "lookup" } };
  const search = { type: "function", function: { name: "search" } };
  const rules = (text: string): Message => ({ role: "system", content: text });
  const messages = [user("hello")];

  const first = await record(t, {
    workspace,
    body: body([rules("v1"), ...messages], { tools: [lookup], temperature: 0.2 }),
  });
  expect(first.changes).toBeUndefined();

  const system = await record(t, {
    workspace,
    body: body([rules("v2"), ...messages], { tools: [lookup], temperature: 0.2 }),
  });
  expect(system.changes).toEqual({
    previous: first._id,
    system: { from: first.system, to: system.system },
  });

  const tools = await record(t, {
    workspace,
    body: body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.2 }),
  });
  expect(tools.changes).toEqual({
    previous: system._id,
    toolset: { from: system.toolset, to: tools.toolset },
  });

  const params = await record(t, {
    workspace,
    body: body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.7 }),
  });
  expect(params.changes).toEqual({
    previous: tools._id,
    params: { from: tools.params, to: params.params },
  });

  const unchanged = await record(t, {
    workspace,
    body: body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.7 }),
  });
  expect(unchanged.changes).toBeUndefined();

  const model = await record(t, {
    workspace,
    body: {
      ...body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.7 }),
      model: "other/model",
    },
  });
  expect(model.changes?.model).toEqual({ from: "provider/model", to: "other/model" });
});

test("recording inputs off keeps keyed hashes but suppresses content and metadata, then upgrades", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const messages: Message[] = [
    { role: "system", content: "secret rules" },
    user("secret question"),
    {
      role: "assistant",
      content: "secret",
      tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "secret result" },
    user("secret follow-up"),
  ];
  const tools = [{ type: "function", function: { name: "lookup", description: "secret" } }];

  const redacted = await record(t, {
    workspace,
    body: body(messages, { tools, temperature: 0.3 }),
    headers: { "x-title": "sensitive header" },
    settings: recordNothing,
    output: "secret answer",
  });

  expect(redacted).toMatchObject({ recordsInputs: false, recordsOutputs: false });
  const stored = await counts(t, workspace);
  const byKind = (kind: string) => stored.blobs.filter((blob) => blob.kind === kind);
  for (const blob of [...byKind("message"), ...byKind("system"), ...byKind("tool")]) {
    expect(blob.content).toBeUndefined();
    expect(blob.storage).toBeUndefined();
    expect(blob.size).toBeGreaterThan(0);
  }
  expect(stored.blobs.every((blob) => blob.meta === undefined && blob.content === undefined)).toBe(true);
  expect(byKind("params")[0]!.sealed).toBeUndefined();
  expect(byKind("headers")[0]!.sealed).toBeUndefined();
  expect(JSON.stringify(stored.blobs)).not.toContain("sensitive header");
  expect(JSON.stringify(stored.blobs)).not.toContain("lookup");
  expect(byKind("toolset")[0]!.sealed).toBeDefined();
  expect(redacted.output).toBeDefined();

  // The same request recorded later upgrades the system prompt and tools in place.
  const recorded = await record(t, {
    workspace,
    body: body(messages, { tools, temperature: 0.3 }),
  });
  expect(recorded.system).toBe(redacted.system);
  expect(recorded.toolset).toBe(redacted.toolset);
  const upgraded = await t.run(async (ctx) => ({
    system: await loadBlob(ctx, workspace, recorded.system),
    tools: await loadToolset(ctx, workspace, recorded.toolset),
  }));
  expect(await value(workspace, upgraded.system)).toEqual([messages[0]]);
  expect(await Promise.all(upgraded.tools.map((tool) => value(workspace, tool)))).toEqual(tools);
  expect((await counts(t, workspace)).blobs).toHaveLength(stored.blobs.length);
});

test("finishing the same request twice stores and schedules it once", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const input = { workspace, body: body([user("hi")]), requestId: "same-request", output: "hello" };

  const first = await record(t, input);
  const second = await record(t, input);

  expect(second._id).toBe(first._id);
  const { requests, scheduled } = await t.run(async (ctx) => ({
    requests: await ctx.db.query("telemetry_requests").collect(),
    scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
  }));
  expect(requests).toHaveLength(1);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.args).toEqual([{ request: first._id }]);
});

test("message-hash sessions share the first-turn key and subagents record their parent", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);

  const first = await record(t, {
    workspace,
    body: body([user("u1")]),
    sessionKey: { primary: "msg:first", isSubagent: false },
  });
  const second = await record(t, {
    workspace,
    body: body([user("u1"), assistant("a1"), user("u2")]),
    sessionKey: { primary: "msg:second", fallback: "msg:first", isSubagent: false },
  });
  const child = await record(t, {
    workspace,
    body: body([user("delegated")]),
    sessionKey: { primary: "claude:child", fallback: "claude:parent", isSubagent: true },
  });

  expect(second.session).toBe(first.session);
  const sessions = await t.run((ctx) => ctx.db.query("telemetry_sessions").collect());
  expect(sessions.map((row) => [row.key, row.parentKey])).toEqual([
    ["msg:first", undefined],
    ["claude:child", "claude:parent"],
  ]);
  expect(child.session).toBe(sessions[1]!._id);
});

test("oversized content goes to file storage once and is reused", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const huge = user("x".repeat(1_000_000));

  const first = await record(t, { workspace, body: body([huge]) });
  await record(t, { workspace, body: body([huge, assistant("a"), user("next")]) });

  const { blob, files } = await t.run(async (ctx) => {
    const node = await ctx.db.get(
      "telemetry_nodes",
      (await ctx.db.get("telemetry_requests", first._id))!.input!,
    );
    const loaded = await loadBlob(ctx, workspace, node!.blob);
    return { blob: loaded, files: await ctx.db.system.query("_storage").collect() };
  });
  expect(blob?.content).toBeUndefined();
  expect(blob?.sealed?.storageUrl).toBeDefined();
  expect(files).toHaveLength(1);
});

test("capture refuses a request whose API key belongs to another workspace", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const otherWorkspace = await makeWorkspace(t);
  const foreignKey = await t.run((ctx) =>
    ctx.db.insert("api_keys", { workspace: otherWorkspace, name: "key", hash: "h" }),
  );
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const capture = startCapture(
    actionCtx(t),
    { workspace, userId: "owner", requestId: "r", settings: recordAll, apiKey: foreignKey },
    {
      rawBody: body([user("hi")]),
      source: "gateway",
      model: "provider/model",
      stream: false,
      startedAt: 1,
    },
  );
  await capture.finish({ status: "ok" });

  errors.mockRestore();
  const requests: Doc<"telemetry_requests">[] = await t.run((ctx) =>
    ctx.db.query("telemetry_requests").collect(),
  );
  expect(requests).toHaveLength(0);
});

const custodyBox = { kind: "custody" as const, keyId: "k", epoch: 1, box: new ArrayBuffer(1) };

/** Cutover is complete and one historical message blob of the workspace is held in custody. */
async function holdCustodialMessage(t: TestConvex, workspace: Id<"workspaces">, message: Message) {
  const hash = await blobHash(workspace, "message", canonicalJson(message));
  await t.run(async (ctx) => {
    await ctx.db.insert("e2ee_migration_state", {
      key: "global", frozen: false, generation: 2, custodyState: "active", cutoverComplete: true, custodyWrites: 0,
    });
    const blob = await ctx.db.insert("telemetry_blobs", { workspace, hash, kind: "message", size: 10, legacyContent: custodyBox });
    await ctx.db.insert("e2ee_legacy_custody", { table: "telemetry_blobs", record: blob, workspace });
  });
}

async function proofActivity(t: TestConvex, workspace: Id<"workspaces">) {
  return await t.run(async (ctx) => ({
    revisions: (await ctx.db.query("e2ee_telemetry_revisions").collect()).map((row) => row.revision),
    workspace: await ctx.db.get("workspaces", workspace),
    state: await ctx.db.query("e2ee_migration_state").first(),
    refreshes: (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.name.includes("e2ee_telemetry")).length,
  }));
}

test("capture after cutover leaves custody proofs alone unless a request reaches custodial history", async () => {
  const t = makeTest();
  const workspace = await makeWorkspace(t);
  const legacy = user("historical question");
  await holdCustodialMessage(t, workspace, legacy);

  // Unrelated traffic: no revision, no workspace write, no refresh pass, however many requests.
  const before = await proofActivity(t, workspace);
  await record(t, { workspace, body: body([user("fresh one")], { tools: [{ type: "function", function: { name: "lookup" } }] }) });
  await record(t, { workspace, body: body([user("fresh one"), assistant("a"), user("fresh two")]) });
  const unrelated = await proofActivity(t, workspace);
  expect(unrelated.revisions).toEqual([]);
  expect(unrelated.workspace).toEqual(before.workspace);
  expect(unrelated.state).toEqual(before.state);
  expect(unrelated.refreshes).toBe(0);

  // A request whose chain starts at the custodial message reaches custody: one revision, one pass.
  await record(t, { workspace, body: body([legacy]) });
  const related = await proofActivity(t, workspace);
  expect(related.revisions).toEqual([1]);
  expect(related.workspace).toEqual(before.workspace);
  expect(related.state).toMatchObject({ telemetryRefreshPending: true, telemetryRefreshGeneration: 2 });
  expect(related.refreshes).toBe(1);

  // Continuing that conversation natively still reaches it through the hidden ancestor; the next
  // unrelated request does not.
  await record(t, { workspace, body: body([legacy, assistant("a"), user("continued")]) });
  expect((await proofActivity(t, workspace)).revisions).toEqual([2]);
  await record(t, { workspace, body: body([user("fresh three")]) });
  expect((await proofActivity(t, workspace)).revisions).toEqual([2]);

  // Reach is memoized on the nodes: the three on the custodial chain touch custody, the rest do not.
  const nodes = await t.run((ctx) => ctx.db.query("telemetry_nodes").collect());
  expect(nodes.filter((node) => node.custodyFree === false)).toHaveLength(3);
  expect(nodes.filter((node) => node.custodyFree === true)).toHaveLength(nodes.length - 3);
});

test("a proof chain that cannot continue releases its coalescing flags instead of staying pending", async () => {
  const t = makeTest();
  // Writers reopened mid-chain: the freeze the proofs need is gone, so the step throws.
  await t.run((ctx) => ctx.db.insert("e2ee_migration_state", {
    key: "global", frozen: false, generation: 3, custodyState: "active", cutoverComplete: false, custodyWrites: 0,
    telemetryRefreshPending: true, telemetryRefreshGeneration: 3, telemetryRefreshDirty: true,
  }));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await t.mutation(internal.e2ee_telemetry.proveNext, { table: "telemetry_blobs" });
  await t.mutation(internal.e2ee_telemetry.enqueueProofs, { table: "telemetry_blobs" });
  errors.mockRestore();
  const state = await t.run((ctx) => ctx.db.query("e2ee_migration_state").first());
  expect(state).toMatchObject({ telemetryRefreshPending: false, telemetryRefreshDirty: false });
});
