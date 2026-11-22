import { and, asc, count, eq } from "drizzle-orm";
import {
  decodeCapsule,
  generateEncryptionKeyPair,
  openCapsule,
  openWithCapsule,
  toBase64Url,
} from "radium-crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { chats } from "../chatroom/schema";
import { e2eeWorkspaceEpochs } from "../e2ee/schema";
import { apiKeys } from "../gateway/schema";
import type { Runtime } from "../runtime";
import { appRouter } from "../trpc/router";
import { workspaceMembers } from "../workspaces/schema";
import { updateWorkspaceSettings } from "../workspaces/settings";
import { setWorkspaceKeyEpoch } from "../workspaces/workspaces";
import {
  startCapture,
  telemetrySettingsFor,
  type CaptureResult,
  type TelemetryRequestContext,
} from "./capture";
import { canonicalJson } from "./canonical";
import { blobHash, nodeHash } from "./hash";
import { deepestExistingPrefix } from "./ingest";
import {
  telemetryBlobs,
  telemetryNodes,
  telemetryRequests,
  telemetrySessions,
  telemetryToolsetTools,
} from "./schema";
import type { TelemetryAttempt, TelemetrySettings } from "contracts/telemetry/validators";

// Capture write path against real Postgres: rows written for non-streaming and streaming
// requests, content sealed to the owner key, lineage, redaction and upgrade, ownership claims and
// the invariants that relied on Convex serializing mutations (shared blobs and prefixes, forks).

type Message = Record<string, unknown>;
type BlobRow = typeof telemetryBlobs.$inferSelect;
type RequestRow = typeof telemetryRequests.$inferSelect;

const recordAll: TelemetrySettings = { enabled: true, recordInputs: true, recordOutputs: true };
const recordNothing: TelemetrySettings = {
  enabled: true,
  recordInputs: false,
  recordOutputs: false,
};
const session = { primary: "header:session-1", isSubagent: false };

let test: TestRuntime;
let accounts = 0;
let requestCount = 0;
let clock = 1_700_000_000_000;
/** Owner key seeds by workspace. */
const seeds = new Map<string, Uint8Array>();

const db = () => test.runtime.drivers.db;

beforeAll(async () => {
  test = await createTestRuntime();
});

afterAll(async () => {
  await test?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A personal workspace through the real router; `keyed` gives it an owner key epoch. */
async function makeWorkspace(options: { keyed?: boolean } = {}) {
  const owner = await classicUser(test.runtime, `telemetry${++accounts}@example.test`);
  const workspace = await appRouter
    .createCaller({ runtime: test.runtime, headers: owner.headers })
    .workspaces.ensurePersonal();
  if (options.keyed ?? true) {
    const keys = await generateEncryptionKeyPair();
    await db()
      .insert(e2eeWorkspaceEpochs)
      .values({
        workspace,
        epoch: 1,
        suite: 1,
        memberKeyId: toBase64Url(new Uint8Array(16).fill(1)),
        memberPublicKey: keys.publicKey,
        ownerKeyId: toBase64Url(new Uint8Array(16).fill(2)),
        ownerPublicKey: keys.publicKey,
        createdBy: owner.id,
      });
    await setWorkspaceKeyEpoch(db(), workspace, 1);
    seeds.set(workspace, keys.seed);
  }
  return { workspace: workspace as string, owner };
}

type Workspace = { workspace: string; owner: { id: string; headers: Headers } };

/** Decrypts a sealed blob with the workspace owner's seed, as the owner's client would. */
async function openBlob(workspace: string, blob: BlobRow | undefined, hash = blob?.hash) {
  if (!blob?.sealedEnvelope) return undefined;
  const requestId = blob.sealedRequestId!;
  const capsuleKey = await openCapsule({
    seed: seeds.get(workspace)!,
    capsule: decodeCapsule(blob.sealedCapsule!),
    aad: { table: "telemetry_capsules", workspace, parent: requestId, record: requestId, field: "capsule" },
  });
  const plaintext = await openWithCapsule({
    capsuleKey,
    envelope: blob.sealedEnvelope,
    aad: { table: "telemetry_blobs", workspace, parent: requestId, record: hash!, field: "content" },
    pad: "content",
  });
  return JSON.parse(new TextDecoder().decode(plaintext)) as { content?: string; meta?: unknown };
}

async function value(workspace: string, blob: BlobRow | undefined) {
  const content = (await openBlob(workspace, blob))?.content;
  return content === undefined ? undefined : JSON.parse(content);
}

async function blobById(id: string | null | undefined) {
  if (!id) return undefined;
  const [row] = await db().select().from(telemetryBlobs).where(eq(telemetryBlobs.id, id));
  return row;
}

/** The message values of a request's input chain from the root, and the output message. */
async function chainValues(workspace: string, request: RequestRow) {
  const nodes: Array<typeof telemetryNodes.$inferSelect> = [];
  for (let id = request.input; id; ) {
    const [node] = await db().select().from(telemetryNodes).where(eq(telemetryNodes.id, id));
    nodes.unshift(node!);
    id = node!.parent;
  }
  return await Promise.all(nodes.map(async (node) => value(workspace, await blobById(node.blob))));
}

async function toolValues(workspace: string, toolsetId: string | null) {
  if (!toolsetId) return [];
  const members = await db()
    .select()
    .from(telemetryToolsetTools)
    .where(eq(telemetryToolsetTools.toolset, toolsetId))
    .orderBy(asc(telemetryToolsetTools.position));
  return await Promise.all(members.map(async (member) => value(workspace, await blobById(member.tool))));
}

type RecordInput = {
  workspace: Workspace;
  body: Record<string, unknown>;
  /** Assistant text returned for the request. */
  output?: string;
  requestId?: string;
  settings?: TelemetrySettings;
  headers?: Record<string, string>;
  sessionKey?: { primary: string; fallback?: string; isSubagent: boolean } | null;
  attempts?: TelemetryAttempt[];
  runtime?: Runtime;
  context?: Partial<TelemetryRequestContext>;
  source?: "gateway" | "chatroom";
  result?: CaptureResult;
};

/** One request through capture exactly as the gateway drives it; resolves to its requestId. */
async function record(input: RecordInput) {
  const requestId = input.requestId ?? `request-${++requestCount}`;
  const capture = startCapture(
    input.runtime ?? test.runtime,
    {
      workspace: input.workspace.workspace,
      userId: input.workspace.owner.id,
      requestId,
      settings: input.settings ?? recordAll,
      ...input.context,
    },
    {
      rawBody: input.body,
      headers: new Headers(input.headers),
      session: input.sessionKey === null ? undefined : (input.sessionKey ?? session),
      source: input.source ?? "gateway",
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
    } as never);
  }
  await capture.finish(input.result ?? { status: "ok" });
  return { requestId, workspace: input.workspace.workspace };
}

async function stored(request: { requestId: string; workspace: string }) {
  const [row] = await db()
    .select()
    .from(telemetryRequests)
    .where(
      and(
        eq(telemetryRequests.workspace, request.workspace),
        eq(telemetryRequests.requestId, request.requestId),
      ),
    );
  return row;
}

async function recordStored(input: RecordInput) {
  const row = await stored(await record(input));
  if (!row) throw new Error("Request was not captured.");
  return row;
}

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

function body(messages: Message[], extra: Record<string, unknown> = {}) {
  return { model: "provider/model", messages, ...extra };
}

/** Node hashes at depth 1..n for a message chain, as capture computes them. */
async function chainHashes(workspace: string, messages: Message[]) {
  const secret = test.runtime.config.TELEMETRY_HASH_SECRET!;
  const hashes: string[] = [];
  let parent: string | undefined;
  for (const message of messages) {
    const blob = await blobHash(secret, workspace, "message", canonicalJson(message));
    parent = await nodeHash(secret, workspace, parent, blob);
    hashes.push(parent);
  }
  return hashes;
}

async function counts(workspace: string) {
  const [nodes] = await db()
    .select({ total: count() })
    .from(telemetryNodes)
    .where(eq(telemetryNodes.workspace, workspace));
  const blobs = await db().select().from(telemetryBlobs).where(eq(telemetryBlobs.workspace, workspace));
  const [requests] = await db()
    .select({ total: count() })
    .from(telemetryRequests)
    .where(eq(telemetryRequests.workspace, workspace));
  return {
    nodes: nodes!.total,
    requests: requests!.total,
    blobs,
    messageBlobs: blobs.filter((blob) => blob.kind === "message").length,
  };
}

describe("settings", () => {
  it("reads capture settings from the workspace row, defaulting to off", async () => {
    const { workspace } = await makeWorkspace();
    expect(await telemetrySettingsFor(db(), workspace)).toEqual({
      enabled: false,
      recordInputs: false,
      recordOutputs: false,
      retentionDays: undefined,
    });
    await updateWorkspaceSettings(db(), workspace, {
      telemetryEnabled: true,
      telemetryRecordOutputs: true,
      telemetryRetentionDays: 30,
    });
    expect(await telemetrySettingsFor(db(), workspace)).toEqual({
      enabled: true,
      recordInputs: false,
      recordOutputs: true,
      retentionDays: 30,
    });
  });
});

describe("capture", () => {
  it("seals content to the owner key and binds each envelope to its workspace and hash", async () => {
    const workspace = await makeWorkspace();
    const request = await recordStored({ workspace, body: body([user("sensitive prompt")]) });
    const [node] = await db().select().from(telemetryNodes).where(eq(telemetryNodes.id, request.input!));
    const blob = await blobById(node!.blob);

    expect(blob).toMatchObject({ content: null, meta: null, storageKey: null, legacyContent: null });
    expect(blob!.sealedEnvelope).toBeInstanceOf(Uint8Array);
    expect(await value(workspace.workspace, blob)).toEqual(user("sensitive prompt"));
    await expect(openBlob(workspace.workspace, blob, "wrong")).rejects.toThrow();
    const { blobs } = await counts(workspace.workspace);
    expect(blobs.every((row) => row.content === null && row.legacyContent === null)).toBe(true);
  });

  it("stores no content in a workspace without an owner key, and still records the request", async () => {
    const workspace = await makeWorkspace({ keyed: false });
    const request = await recordStored({
      workspace,
      body: body([user("secret")]),
      result: { status: "error", error: { message: "secret failure", status: 500 } },
    });
    const { blobs } = await counts(workspace.workspace);
    expect(blobs.length).toBeGreaterThan(0);
    for (const blob of blobs) {
      expect(blob).toMatchObject({
        content: null,
        meta: null,
        storageKey: null,
        sealedEpoch: null,
        sealedEnvelope: null,
      });
    }
    expect(request).toMatchObject({
      status: "error",
      errorMessage: null,
      sealedErrorEnvelope: null,
      recordsInputs: true,
    });
  });

  it("writes nothing at all while the deployment has no hash secret", async () => {
    const workspace = await makeWorkspace();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = { ...test.runtime, config: { ...test.runtime.config, TELEMETRY_HASH_SECRET: undefined } };
    const capture = startCapture(
      runtime,
      { workspace: workspace.workspace, userId: workspace.owner.id, requestId: "no-secret", settings: recordAll },
      { rawBody: body([user("secret")]), source: "gateway", model: "m", stream: true, startedAt: 1 },
    );
    capture.attempt({ provider: "p", startedAt: 1, durationMs: 1, outcome: "ok" });
    capture.outputChunk({ id: "x", created: 1, model: "m", object: "chat.completion.chunk", choices: [] } as never);
    capture.recordGeneration({ genTime: 1, ttft: 1 });
    capture.recordChatCompletion("completion");
    await capture.finish({ status: "ok" });
    await capture.finish({ status: "ok" });

    const stored = await counts(workspace.workspace);
    expect(stored).toMatchObject({ nodes: 0, requests: 0, blobs: [] });
    expect(errors).not.toHaveBeenCalled();
    expect(await db().select().from(telemetrySessions).where(eq(telemetrySessions.workspace, workspace.workspace))).toEqual([]);
  });

  it("captures a non-streaming request with routing, usage, timing and a sealed error", async () => {
    const workspace = await makeWorkspace();
    const capture = startCapture(
      test.runtime,
      { workspace: workspace.workspace, userId: workspace.owner.id, requestId: "plain", settings: recordAll },
      {
        rawBody: body([user("question")], { tools: [{ type: "function", function: { name: "lookup" } }] }),
        headers: new Headers({ "x-title": "client", authorization: "Bearer nope" }),
        session,
        source: "gateway",
        model: "provider/model",
        requestedServiceTier: "priority",
        stream: false,
        startedAt: ++clock,
      },
    );
    capture.attempt({ provider: "first", startedAt: 1, durationMs: 5, outcome: "error", status: 503, message: "upstream down" });
    capture.attempt({ provider: "second", providerModel: "pm", startedAt: 9, durationMs: 20, outcome: "ok" });
    capture.outputResponse({
      id: "resp-1",
      created: 1,
      model: "m",
      object: "chat.completion",
      usage: {},
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "answer" } }],
    } as never);
    capture.recordGeneration({
      genId: "gen-1",
      usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 1 }, prompt_tokens_details: { cached_tokens: 3 } },
      genTime: 120,
      ttft: 30,
      serviceTier: "default",
      estimatedCost: 0.5,
    });
    await capture.finish({ status: "ok" });

    const row = (await stored({ requestId: "plain", workspace: workspace.workspace }))!;
    expect(row).toMatchObject({
      source: "gateway",
      model: "provider/model",
      provider: "second",
      stream: false,
      status: "ok",
      finishReason: "length",
      providerGenerationId: "gen-1",
      requestedServiceTier: "priority",
      servedServiceTier: "default",
      ttftMs: 30,
      generationMs: 120,
      estimatedCost: 0.5,
      canceled: false,
      recordsInputs: true,
      recordsOutputs: true,
      lineage: { kind: "root" },
      errorMessage: null,
    });
    expect(row.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      reasoningTokens: 1,
      cacheReadTokens: 3,
    });
    // Attempt messages are sealed with the error; the row keeps only structured facts.
    expect(row.attempts).toEqual([
      { provider: "first", startedAt: 1, durationMs: 5, outcome: "error", status: 503 },
      { provider: "second", providerModel: "pm", startedAt: 9, durationMs: 20, outcome: "ok" },
    ]);
    expect(row.sealedErrorEnvelope).toBeInstanceOf(Uint8Array);
    expect(row.endedAt.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime());

    const [output] = await db().select().from(telemetryNodes).where(eq(telemetryNodes.id, row.output!));
    expect(output).toMatchObject({ origin: "output", depth: 2, parent: row.input });
    expect(await value(workspace.workspace, await blobById(output!.blob))).toEqual(assistant("answer"));
    const headers = await value(workspace.workspace, await blobById(row.headers));
    expect(headers).toEqual({ "x-title": "client" });
    const [session1] = await db().select().from(telemetrySessions).where(eq(telemetrySessions.id, row.session!));
    expect(session1).toMatchObject({ key: "header:session-1", source: "gateway", chat: null });
  });

  it("captures a streaming request, assembling the output from chunks", async () => {
    const workspace = await makeWorkspace();
    const capture = startCapture(
      test.runtime,
      { workspace: workspace.workspace, userId: workspace.owner.id, requestId: "stream", settings: recordAll },
      { rawBody: body([user("stream me")], { stream: true }), session, source: "gateway", model: "provider/model", stream: true, startedAt: ++clock },
    );
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      capture.outputChunk({
        id: "chunk-id",
        created: 1,
        model: "m",
        object: "chat.completion.chunk",
        choices: [{ index: 0, finish_reason: finish, delta: { role: "assistant", content: "", ...delta } }],
      } as never);
    chunk({ content: "Hel" });
    chunk({ content: "lo" });
    chunk({ content: "", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "lookup", arguments: '{"q"' } }] });
    chunk({ content: "", tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, "tool_calls");
    capture.recordGeneration({ genTime: 10, ttft: 2 });
    await capture.finish({ status: "ok" });

    const row = (await stored({ requestId: "stream", workspace: workspace.workspace }))!;
    expect(row).toMatchObject({ stream: true, finishReason: "tool_calls", providerGenerationId: "chunk-id" });
    const [output] = await db().select().from(telemetryNodes).where(eq(telemetryNodes.id, row.output!));
    expect(await value(workspace.workspace, await blobById(output!.blob))).toEqual({
      role: "assistant",
      content: "Hello",
      tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } }],
    });
  });

  it("stores no content or error text with recording off, only keyed fingerprints", async () => {
    const workspace = await makeWorkspace();
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

    const redacted = await recordStored({
      workspace,
      body: body(messages, { tools, temperature: 0.3 }),
      headers: { "x-title": "sensitive header" },
      settings: recordNothing,
      output: "secret answer",
      result: { status: "error", error: { message: "secret failure" } },
    });

    expect(redacted).toMatchObject({
      recordsInputs: false,
      recordsOutputs: false,
      sealedErrorEnvelope: null,
      errorMessage: null,
    });
    const stored = await counts(workspace.workspace);
    const byKind = (kind: string) => stored.blobs.filter((blob) => blob.kind === kind);
    for (const blob of [...byKind("message"), ...byKind("system"), ...byKind("tool"), ...byKind("params"), ...byKind("headers")]) {
      expect(blob).toMatchObject({ content: null, storageKey: null, sealedEnvelope: null, meta: null });
      expect(blob.size).toBeGreaterThan(0);
    }
    expect(JSON.stringify(stored.blobs)).not.toContain("sensitive header");
    // A toolset is only tool hashes, so it is stored sealed whatever the recording settings.
    expect(byKind("toolset")[0]!.sealedEnvelope).toBeInstanceOf(Uint8Array);
    expect(redacted.output).not.toBeNull();

    // The same request recorded later upgrades the redacted blobs in place.
    const recorded = await recordStored({ workspace, body: body(messages, { tools, temperature: 0.3 }) });
    expect(recorded.system).toBe(redacted.system);
    expect(recorded.toolset).toBe(redacted.toolset);
    expect(await value(workspace.workspace, await blobById(recorded.system))).toEqual([messages[0]]);
    expect(await toolValues(workspace.workspace, recorded.toolset)).toEqual(tools);
    expect((await chainValues(workspace.workspace, recorded)).slice(0, 2)).toEqual(messages.slice(1, 3));
    expect((await counts(workspace.workspace)).blobs).toHaveLength(stored.blobs.length);
  });

  it("a decomposed request reassembles into the original body", async () => {
    const workspace = await makeWorkspace();
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
          tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } }],
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

    const request = await recordStored({ workspace, body: original });

    const { messages: _messages, tools: _tools, ...params } = original;
    expect(await value(workspace.workspace, await blobById(request.params))).toEqual(params);
    expect([
      ...(await value(workspace.workspace, await blobById(request.system))),
      ...(await chainValues(workspace.workspace, request)),
    ]).toEqual(original.messages);
    expect(await toolValues(workspace.workspace, request.toolset)).toEqual(original.tools);
  });
});

describe("deduplication", () => {
  it("stores shared prefixes once per workspace and never across workspaces", async () => {
    const first = await makeWorkspace();
    const second = await makeWorkspace();
    const prefix = [user("u1"), assistant("a1"), user("u2")];
    const tools = [{ type: "function", function: { name: "lookup" } }];
    const system = { role: "system", content: "rules" };

    const short = await recordStored({ workspace: first, body: body([system, ...prefix], { tools }) });
    const long = await recordStored({
      workspace: first,
      body: body([system, ...prefix, assistant("a2"), user("u3")], { tools }),
    });

    expect(await counts(first.workspace)).toMatchObject({ nodes: 5, messageBlobs: 5 });
    expect(long.system).toBe(short.system);
    expect(long.toolset).toBe(short.toolset);
    expect(long.params).toBe(short.params);

    const other = await recordStored({ workspace: second, body: body([system, ...prefix], { tools }) });
    expect(await counts(second.workspace)).toMatchObject({ nodes: 3, messageBlobs: 3 });
    expect(other.system).not.toBe(short.system);
    expect((await blobById(other.system))!.hash).not.toBe((await blobById(short.system))!.hash);
  });

  it("finds the deepest stored depth for empty, partial and full chains", async () => {
    const workspace = await makeWorkspace();
    const chain = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")];
    await record({ workspace, body: body(chain) });

    const search = async (messages: Message[]) =>
      deepestExistingPrefix(db(), workspace.workspace, await chainHashes(workspace.workspace, messages));

    expect((await search([])).depth).toBe(0);
    expect((await search([user("unknown")])).depth).toBe(0);
    expect((await search([...chain.slice(0, 3), assistant("diverges"), user("u3")])).depth).toBe(3);
    const full = await search(chain);
    expect(full.depth).toBe(5);
    expect(full.node).toBeDefined();
    expect((await search([...chain, user("more")])).depth).toBe(5);
  });

  it("stores each blob and node once when requests sharing a conversation arrive together", async () => {
    const workspace = await makeWorkspace();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const tools = [
      { type: "function", function: { name: "lookup" } },
      { type: "function", function: { name: "search" } },
    ];
    const shared = [{ role: "system", content: "rules" }, user("u1"), assistant("a1"), user("u2")];
    const requests = Array.from({ length: 8 }, (_, index) =>
      record({
        workspace,
        // Half the requests extend the shared prefix with the same message, half with their own.
        body: body([...shared, user(index % 2 === 0 ? "common" : `own ${index}`)], { tools }),
        output: "answer",
        sessionKey: { primary: `session-${index % 2}`, isSubagent: false },
      }),
    );
    const done = await Promise.all(requests);

    expect(errors).not.toHaveBeenCalled();
    const written = await counts(workspace.workspace);
    expect(written.requests).toBe(8);
    // u1, a1, u2, "common", 4 own messages; every request produces the same "answer" output node
    // under its own input node: 1 + 4 distinct inputs → 5 outputs.
    expect(written.nodes).toBe(3 + 1 + 4 + 5);
    const hashes = written.blobs.map((blob) => blob.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(written.blobs.filter((blob) => blob.kind === "tool")).toHaveLength(2);
    const toolsets = written.blobs.filter((blob) => blob.kind === "toolset");
    expect(toolsets).toHaveLength(1);
    expect(
      await db().select().from(telemetryToolsetTools).where(eq(telemetryToolsetTools.toolset, toolsets[0]!.id)),
    ).toHaveLength(2);
    for (const request of done) expect(await stored(request)).toBeDefined();
  });

  it("flags every concurrent child of a message but the first as a fork", async () => {
    const workspace = await makeWorkspace();
    const root = await recordStored({ workspace, body: body([user("u1")]), output: "a1" });
    expect(root.lineage).toEqual({ kind: "root" });

    const children = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        recordStored({ workspace, body: body([user("u1"), assistant("a1"), user(`child ${index}`)]), output: "x" }),
      ),
    );

    const kinds = children.map((child) => child.lineage.kind);
    expect(kinds.filter((kind) => kind === "continue")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "branch")).toHaveLength(5);
  });
});

describe("lineage", () => {
  it("classifies continue, retry, rewrite, branch, compacted and root", async () => {
    const workspace = await makeWorkspace();
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

    const root = await recordStored({ workspace, body: body([u1]), output: "a1" });
    expect(root.lineage).toEqual({ kind: "root" });

    const next = await recordStored({ workspace, body: body([u1, a1, u2]), output: "a2" });
    expect(next.lineage).toEqual({ kind: "continue", request: root.id, depth: 2 });

    const retry = await recordStored({ workspace, body: body([u1, a1, u2]), output: "a2 again" });
    expect(retry.lineage).toEqual({ kind: "retry", request: next.id, depth: 3 });

    const rewrite = await recordStored({ workspace, body: body([u1, a1, u2, a2x, u3]), output: "a3" });
    expect(rewrite.lineage).toEqual({ kind: "rewrite", request: retry.id, depth: 3 });

    const resumed = await recordStored({
      workspace,
      body: body([u1, a1, u2, a2x, u3, a3, u4]),
      output: "a4",
    });
    expect(resumed.lineage).toEqual({ kind: "continue", request: rewrite.id, depth: 6 });

    // Rolling back to an interior message that never ended a request starts a sibling branch.
    const branch = await recordStored({ workspace, body: body([u1, a1, u2, a2x, uZ]), output: "az" });
    expect(branch.lineage).toEqual({ kind: "branch", request: resumed.id, depth: 4 });

    const compacted = await recordStored({ workspace, body: body([user("summary of everything so far")]) });
    expect(compacted.lineage).toEqual({ kind: "compacted" });

    // Rolling back to an earlier output that later turns already continued is also a branch.
    const rollback = await recordStored({
      workspace,
      body: body([u1, a1, u2, a2x, u3, a3, user("other path")]),
      output: "a5",
    });
    expect(rollback.lineage).toEqual({ kind: "branch", request: rewrite.id, depth: 6 });

    // Both branches stay stored under the shared parent.
    const nodes = await db().select().from(telemetryNodes).where(eq(telemetryNodes.workspace, workspace.workspace));
    const parent = nodes.find((node) => node.depth === 4 && node.origin === "input");
    expect(nodes.filter((node) => node.parent === parent?.id)).toHaveLength(2);
  });

  it("detects system prompt, tool, parameter and model changes against the previous request", async () => {
    const workspace = await makeWorkspace();
    const lookup = { type: "function", function: { name: "lookup" } };
    const search = { type: "function", function: { name: "search" } };
    const rules = (text: string): Message => ({ role: "system", content: text });
    const messages = [user("hello")];

    const first = await recordStored({
      workspace,
      body: body([rules("v1"), ...messages], { tools: [lookup], temperature: 0.2 }),
    });
    expect(first.changes).toBeNull();

    const system = await recordStored({
      workspace,
      body: body([rules("v2"), ...messages], { tools: [lookup], temperature: 0.2 }),
    });
    expect(system.changes).toEqual({ previous: first.id, system: { from: first.system, to: system.system } });

    const tools = await recordStored({
      workspace,
      body: body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.2 }),
    });
    expect(tools.changes).toEqual({ previous: system.id, toolset: { from: system.toolset, to: tools.toolset } });

    const params = await recordStored({
      workspace,
      body: body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.7 }),
    });
    expect(params.changes).toEqual({ previous: tools.id, params: { from: tools.params, to: params.params } });

    const unchanged = await recordStored({
      workspace,
      body: body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.7 }),
    });
    expect(unchanged.changes).toBeNull();

    const model = await recordStored({
      workspace,
      body: { ...body([rules("v2"), ...messages], { tools: [lookup, search], temperature: 0.7 }), model: "other/model" },
    });
    expect(model.changes?.model).toEqual({ from: "provider/model", to: "other/model" });
  });

  it("finishing the same request twice, even together, stores it once", async () => {
    const workspace = await makeWorkspace();
    const input = { workspace, body: body([user("hi")]), requestId: "same-request", output: "hello" };

    const first = await recordStored(input);
    const second = await recordStored(input);
    expect(second.id).toBe(first.id);

    const parallel = { ...input, requestId: "parallel-request" };
    await Promise.all([record(parallel), record(parallel), record(parallel)]);
    expect((await counts(workspace.workspace)).requests).toBe(2);
  });

  it("message-hash sessions share the first-turn key and subagents record their parent", async () => {
    const workspace = await makeWorkspace();

    const first = await recordStored({
      workspace,
      body: body([user("u1")]),
      sessionKey: { primary: "msg:first", isSubagent: false },
    });
    const second = await recordStored({
      workspace,
      body: body([user("u1"), assistant("a1"), user("u2")]),
      sessionKey: { primary: "msg:second", fallback: "msg:first", isSubagent: false },
    });
    const child = await recordStored({
      workspace,
      body: body([user("delegated")]),
      sessionKey: { primary: "claude:child", fallback: "claude:parent", isSubagent: true },
    });
    const none = await recordStored({ workspace, body: body([user("anonymous")]), sessionKey: null });

    expect(second.session).toBe(first.session);
    const sessions = await db()
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.workspace, workspace.workspace))
      .orderBy(asc(telemetrySessions.startedAt));
    expect(sessions.map((row) => [row.key, row.parentKey])).toEqual([
      ["msg:first", null],
      ["claude:child", "claude:parent"],
    ]);
    expect(child.session).toBe(sessions[1]!.id);
    expect(none.session).toBeNull();
  });
});

describe("ownership claims", () => {
  async function refused(input: RecordInput) {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = await record(input);
    expect(await stored(request)).toBeUndefined();
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  }

  it("refuses an API key of another workspace and accepts the workspace's own", async () => {
    const workspace = await makeWorkspace();
    const other = await makeWorkspace();
    const [own] = await db()
      .insert(apiKeys)
      .values({ workspace: workspace.workspace, name: "own", hash: crypto.randomUUID() })
      .returning();
    const [foreign] = await db()
      .insert(apiKeys)
      .values({ workspace: other.workspace, name: "foreign", hash: crypto.randomUUID() })
      .returning();

    await refused({ workspace, body: body([user("hi")]), context: { apiKey: foreign!.id } });
    const accepted = await recordStored({ workspace, body: body([user("hi")]), context: { apiKey: own!.id } });
    expect(accepted.apiKey).toBe(own!.id);
  });

  it("refuses a user without access to the workspace", async () => {
    const workspace = await makeWorkspace();
    const outsider = await makeWorkspace();
    await refused({ workspace, body: body([user("hi")]), context: { userId: outsider.owner.id } });

    await db()
      .insert(workspaceMembers)
      .values({ workspace: workspace.workspace, userId: outsider.owner.id, role: "member" });
    const accepted = await recordStored({ workspace, body: body([user("hi")]), context: { userId: outsider.owner.id } });
    expect(accepted.userId).toBe(outsider.owner.id);
  });

  it("requires a chat of the same workspace for Chatroom requests", async () => {
    const workspace = await makeWorkspace();
    const other = await makeWorkspace();
    const [chat] = await db().insert(chats).values({ workspace: workspace.workspace, userId: workspace.owner.id }).returning();
    const [foreignChat] = await db().insert(chats).values({ workspace: other.workspace, userId: other.owner.id }).returning();

    await refused({ workspace, body: body([user("hi")]), source: "chatroom" });
    await refused({ workspace, body: body([user("hi")]), source: "chatroom", context: { chatId: foreignChat!.id } });

    const accepted = await recordStored({
      workspace,
      body: body([user("hi")]),
      source: "chatroom",
      context: { chatId: chat!.id },
    });
    expect(accepted).toMatchObject({ source: "chatroom", chat: chat!.id });
    const [chatSession] = await db().select().from(telemetrySessions).where(eq(telemetrySessions.id, accepted.session!));
    expect(chatSession).toMatchObject({ source: "chatroom", chat: chat!.id });
  });
});
