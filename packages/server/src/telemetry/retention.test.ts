import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  requestRow,
  telemetryWorkspace,
} from "../../test/telemetry";
import { jobs } from "../jobs/schema";
import { updateWorkspaceSettings } from "../workspaces/settings";
import { GC_JOB, pruneTelemetry, runGcJob } from "./retention";
import {
  telemetryBlobs,
  telemetryNodes,
  telemetryRequests,
  telemetrySessions,
  telemetryToolsetTools,
} from "./schema";
import { queryRows } from "./store";

// Owner deletes, retention and garbage collection against real Postgres: the Convex
// `telemetryRetention` cases, session deletes, object-store envelopes, and GC racing a capture
// that references the same content.

let test: TestRuntime;
let settle: () => Promise<void>;
const db = () => test.runtime.drivers.db;
const DAY = 86_400_000;

beforeAll(async () => {
  test = await createTestRuntime();
  settle = captureDeferred(test.runtime);
});

afterAll(async () => {
  await test?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function counts(workspace: string) {
  const total = async (query: Promise<Array<{ total: number }>>) => (await query)[0]!.total;
  return {
    blobs: await total(db().select({ total: count() }).from(telemetryBlobs).where(eq(telemetryBlobs.workspace, workspace))),
    nodes: await total(db().select({ total: count() }).from(telemetryNodes).where(eq(telemetryNodes.workspace, workspace))),
    tools: await total(
      db()
        .select({ total: count() })
        .from(telemetryToolsetTools)
        .innerJoin(telemetryBlobs, eq(telemetryBlobs.id, telemetryToolsetTools.toolset))
        .where(eq(telemetryBlobs.workspace, workspace)),
    ),
    requests: await total(
      db().select({ total: count() }).from(telemetryRequests).where(eq(telemetryRequests.workspace, workspace)),
    ),
  };
}

/** Resolves once some backend of this database waits on a row lock (GC behind a capture). */
async function lockWaiter() {
  for (;;) {
    const rows = await queryRows<{ waiting: number }>(
      db(),
      sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("garbage collection (Convex telemetryRetention)", () => {
  it("keeps shared prefix nodes and blobs until the last request is deleted", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const blob = (hash: string, kind: "message" | "system" | "tool" | "toolset" | "params") =>
      insertBlob(runtime, ws, kind, hash, 1);
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
    await insertToolset(runtime, toolset, [toolA, toolB]);
    const n1 = await insertNode(runtime, ws, "n1", 1, undefined, m1);
    const n2 = await insertNode(runtime, ws, "n2", 2, n1, m2);
    const n3a = await insertNode(runtime, ws, "n3a", 3, n2, m3a);
    const n3b = await insertNode(runtime, ws, "n3b", 3, n2, m3b);
    const shared = { system, params, toolset };
    const a = await insertRequest(runtime, ws, { requestId: "a", input: n3a, ...shared });
    const b = await insertRequest(runtime, ws, { requestId: "b", input: n3b, ...shared });
    expect(await counts(ws)).toEqual({ blobs: 9, nodes: 4, tools: 2, requests: 2 });

    const api = caller(runtime, f.owner).telemetry;
    await api.deleteRequest({ request: a });
    await settle();
    // Only A's own leaf node and its message blob go.
    expect(await counts(ws)).toEqual({ blobs: 8, nodes: 3, tools: 2, requests: 1 });

    await api.deleteRequest({ request: b });
    await settle();
    expect(await counts(ws)).toEqual({ blobs: 0, nodes: 0, tools: 0, requests: 0 });
    expect(await db().select().from(jobs).where(eq(jobs.kind, GC_JOB))).toEqual([]);
  });

  it("collects a deleted chain that two deleted requests branched from", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    let parent: string | undefined;
    for (let depth = 1; depth <= 30; depth++) {
      parent = await insertNode(runtime, ws, `deep-${depth}`, depth, parent, await insertBlob(runtime, ws, "message", `deep-m${depth}`, depth));
    }
    const left = await insertNode(runtime, ws, "left", 31, parent, await insertBlob(runtime, ws, "message", "left-m", "l"));
    const right = await insertNode(runtime, ws, "right", 31, parent, await insertBlob(runtime, ws, "message", "right-m", "r"));
    const session = await insertSession(runtime, ws, "branches");
    await insertRequest(runtime, ws, { requestId: "left", input: left, session });
    await insertRequest(runtime, ws, { requestId: "right", input: right, session });

    await caller(runtime, f.owner).telemetry.deleteSession({ session });
    await settle();
    expect(await counts(ws)).toEqual({ blobs: 0, nodes: 0, tools: 0, requests: 0 });
    expect(await db().select().from(telemetrySessions).where(eq(telemetrySessions.id, session))).toEqual([]);
  });

  it("deletes the object-store envelope of a collected blob", async () => {
    const f = await telemetryWorkspace(test.runtime, { keyed: true });
    const { runtime } = test;
    const first = captureRequest(runtime, {
      workspace: f.workspace,
      userId: f.owner.id,
      messages: [{ role: "user", content: "y".repeat(1_000_000) }],
    });
    await first.capture.finish({ status: "ok" });
    const [stored] = await db()
      .select()
      .from(telemetryBlobs)
      .where(and(eq(telemetryBlobs.workspace, f.workspace), eq(telemetryBlobs.kind, "message")));
    expect(stored!.storageKey).not.toBeNull();
    expect(await runtime.drivers.objects.stat(stored!.storageKey!)).not.toBeNull();

    const row = await requestRow(runtime, f.workspace, first.requestId);
    await caller(runtime, f.owner).telemetry.deleteRequest({ request: row!.id });
    await settle();
    expect(await counts(f.workspace)).toMatchObject({ blobs: 0, nodes: 0, requests: 0 });
    expect(await runtime.drivers.objects.stat(stored!.storageKey!)).toBeNull();
  });
});

describe("retention", () => {
  it("deletes only expired requests of workspaces with retentionDays, and their empty sessions", async () => {
    const kept = await telemetryWorkspace(test.runtime);
    const pruned = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const now = Date.now();
    await updateWorkspaceSettings(db(), pruned.workspace, {
      telemetryEnabled: true,
      telemetryRetentionDays: 7,
    });
    const old = new Date(now - 8 * DAY);
    const recent = new Date(now - 6 * DAY);
    const keptOld = await insertRequest(runtime, kept.workspace, { requestId: "old", startedAt: old });
    const oldSession = await insertSession(runtime, pruned.workspace, "s", { startedAt: old });
    const busySession = await insertSession(runtime, pruned.workspace, "busy", { startedAt: old });
    const prunedOld = await insertRequest(runtime, pruned.workspace, {
      requestId: "old",
      startedAt: old,
      session: oldSession,
    });
    const prunedRecent = await insertRequest(runtime, pruned.workspace, {
      requestId: "recent",
      startedAt: recent,
      session: busySession,
    });

    const result = await pruneTelemetry(runtime, now);
    await settle();
    expect(result.requests).toBeGreaterThanOrEqual(1);
    const ids = (
      await db()
        .select({ id: telemetryRequests.id })
        .from(telemetryRequests)
        .where(inArray(telemetryRequests.id, [keptOld, prunedOld, prunedRecent]))
    ).map((row) => row.id);
    expect(ids.sort()).toEqual([keptOld, prunedRecent].sort());
    const sessions = (
      await db()
        .select({ id: telemetrySessions.id })
        .from(telemetrySessions)
        .where(inArray(telemetrySessions.id, [oldSession, busySession]))
    ).map((row) => row.id);
    expect(sessions).toEqual([busySession]);
  });
});

describe("owner deletes", () => {
  it("deleteRequest is owner-only and hides requests of other users' personal chats", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const plain = await insertRequest(runtime, f.workspace, { requestId: "plain" });
    const hidden = await insertRequest(runtime, f.workspace, { requestId: "hidden", chat: f.memberPersonalChat });

    await expect(
      caller(runtime, f.member).telemetry.deleteRequest({ request: plain }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(runtime, f.owner).telemetry.deleteRequest({ request: hidden }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Request not found." });
    await caller(runtime, f.owner).telemetry.deleteRequest({ request: plain });
    await settle();

    const left = await db()
      .select({ id: telemetryRequests.id })
      .from(telemetryRequests)
      .where(eq(telemetryRequests.workspace, f.workspace));
    expect(left.map((row) => row.id)).toEqual([hidden]);
  });

  it("deleteSession removes the session's own requests and keeps it while other chats' requests remain", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const session = await insertSession(runtime, f.workspace, "mixed");
    const own = await Promise.all(
      Array.from({ length: 3 }, (_, index) => insertRequest(runtime, f.workspace, { requestId: `own-${index}`, session })),
    );
    const foreign = await insertRequest(runtime, f.workspace, {
      requestId: "foreign",
      session,
      chat: f.memberPersonalChat,
    });

    await caller(runtime, f.owner).telemetry.deleteSession({ session });
    await settle();
    const left = await db()
      .select({ id: telemetryRequests.id })
      .from(telemetryRequests)
      .where(eq(telemetryRequests.session, session));
    expect(left.map((row) => row.id)).toEqual([foreign]);
    expect(own).toHaveLength(3);
    expect(await db().select().from(telemetrySessions).where(eq(telemetrySessions.id, session))).toHaveLength(1);
  });
});

describe("GC racing capture", () => {
  it("waits for an uncommitted reference and keeps the referenced blob and node", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const blob = await insertBlob(runtime, ws, "system", "race-system", ["s"]);
    const message = await insertBlob(runtime, ws, "message", "race-message", "m");
    const node = await insertNode(runtime, ws, "race-node", 1, undefined, message);

    const inserted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = db().transaction(async (tx) => {
      await tx.insert(telemetryRequests).values({
        workspace: ws,
        requestId: "race",
        source: "gateway",
        model: "m",
        stream: false,
        status: "ok",
        startedAt: new Date(),
        endedAt: new Date(),
        durationMs: 0,
        attempts: [],
        recordsInputs: false,
        recordsOutputs: false,
        lineage: { kind: "root" },
        system: blob,
        input: node,
      });
      inserted.resolve();
      await release.promise;
    });
    await inserted.promise;

    const gc = runGcJob(runtime, { workspace: ws, nodes: [node], blobs: [blob, message] });
    await lockWaiter();
    release.resolve();
    await holder;
    await gc;

    expect(await counts(ws)).toMatchObject({ blobs: 2, nodes: 1, requests: 1 });
  });

  it("a capture whose reused content GC collected meanwhile stores it again", async () => {
    const f = await telemetryWorkspace(test.runtime);
    const { runtime } = test;
    const ws = f.workspace;
    const messages = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
    ];
    const first = captureRequest(runtime, { workspace: ws, userId: f.owner.id, messages, output: "hi" });
    await first.capture.finish({ status: "ok" });
    const firstRow = await requestRow(runtime, ws, first.requestId);

    // Delete the only request that used the content; its collection runs below, by hand.
    await db().delete(telemetryRequests).where(eq(telemetryRequests.id, firstRow!.id));
    const payload = {
      workspace: ws,
      nodes: [firstRow!.input!, firstRow!.output!],
      blobs: [firstRow!.system!, firstRow!.params!],
    };

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The second capture looks up the stored content while it still exists...
    const second = captureRequest(runtime, { workspace: ws, userId: f.owner.id, messages, output: "hi" });
    // The lookups are reads with no observable signal; give them time to finish (a local
    // database answers them in a few milliseconds).
    await new Promise((resolve) => setTimeout(resolve, 300));
    // ...then GC collects it before the request references it.
    await runGcJob(runtime, payload);
    expect(await counts(ws)).toMatchObject({ nodes: 0, requests: 0 });
    await second.capture.finish({ status: "ok" });
    errors.mockRestore();

    const stored = await requestRow(runtime, ws, second.requestId);
    expect(stored).toBeDefined();
    const [input] = await db().select().from(telemetryNodes).where(eq(telemetryNodes.id, stored!.input!));
    expect(input).toMatchObject({ depth: 1 });
    expect(stored!.output).not.toBeNull();
    const [system] = await db().select().from(telemetryBlobs).where(eq(telemetryBlobs.id, stored!.system!));
    expect(system).toMatchObject({ kind: "system" });
  });
});
