import { eq, sql } from "drizzle-orm";
import { CAPSULE_BYTES, toBase64Url } from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACP_FRAMES_PER_APPEND, ACP_SEALED_FRAME_BYTES, ACP_WARM_SESSIONS_MAX } from "contracts/acp/contract";
import {
  acpChat,
  acpUsers,
  acpWorkspace,
  sessionOf,
  signedCommand,
  userCaller,
  type Role,
  type Users,
} from "../../test/acp";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { eventually, readOnce } from "../../test/streams";
import { workerIssuerEnv } from "../../test/workers";
import { sweepJobs } from "../jobs/outbox";
import { jobs } from "../jobs/schema";
import { STREAMS_DELETE_JOB } from "../streams/deletion";
import { issueWorkerToken, type WorkerIdentity } from "../worker/signing";
import { ACP_APPEND_BODY_BYTES, coolSessions, epochStreamPath, watch } from "./live";
import { acpSessions } from "./schema";
import { admitWarm, coolingCandidates, coolWarm, isWarm, watchWarm, warmChats } from "./warm";

// ACP epochs on Durable Streams through the real routers and the `/api/streams` proxy: the epoch
// capsule as the stream's first message, the Worker append path (who may append, the epoch
// fence, producer dedupe, size and plaintext refusals), viewer heartbeats and cooling with
// explicit clocks, deletion with the chat and on revocation, personal-chat privacy, and the
// invariants that rest on Valkey scripts and the session row lock.

let test: TestRuntime;
let users: Users;
let fixture: Awaited<ReturnType<typeof acpWorkspace>>;

const db = () => test.runtime.drivers.db;
const kv = () => test.runtime.drivers.kv;
const call = (role: Role) => userCaller(test, users[role].headers);
const MINUTE = 60_000;

beforeAll(async () => {
  test = await createTestRuntime({ env: (await workerIssuerEnv()).env });
  users = await acpUsers(test.runtime, "acp-live");
  fixture = await acpWorkspace(test.runtime, users);
});

afterAll(async () => {
  await test?.close();
});

const capsuleOf = (fill: number) => ({
  chatEpoch: 1,
  capsule: toBase64Url(new Uint8Array(CAPSULE_BYTES).fill(fill)),
  signature: toBase64Url(new Uint8Array(64).fill(fill)),
});

async function tokenOf(identity: WorkerIdentity) {
  const { token } = await issueWorkerToken(
    identity,
    test.runtime.config.WORKER_AUTH_PRIVATE_JWK!,
    test.runtime.config.API_URL,
  );
  return token;
}

const frame = (seq: number, bytes = 64) => ({
  seqFrom: seq,
  seqTo: seq,
  kind: "live",
  payload: toBase64Url(crypto.getRandomValues(new Uint8Array(bytes))),
});

/** `POST /api/streams/c/<chat>/acp/<epoch>` as a Worker sends it. */
async function append(
  chat: string,
  epoch: number,
  body: unknown,
  options: {
    token?: string | null;
    worker?: WorkerIdentity;
    seq?: number;
    producerId?: string;
    contentType?: string;
    raw?: string;
  } = {},
) {
  const worker = options.worker ?? fixture.worker;
  const token = options.token === undefined ? await tokenOf(worker) : options.token;
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
    "producer-id": options.producerId ?? `${worker.workerId}:${epoch}`,
    "producer-epoch": "0",
    "producer-seq": String(options.seq ?? 0),
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await test.app.request(`/api/streams/${epochStreamPath(chat, epoch)}`, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
  const error = response.status >= 400 ? ((await response.json()) as { error: string }).error : null;
  return { status: response.status, error };
}

/** Every message of an epoch stream as `role` reads it (catch-up through the proxy). */
async function messagesOf(role: Role, chat: string, epoch: number) {
  return await readOnce(test.app, users[role].headers, epochStreamPath(chat, epoch), "-1", false);
}

/** A warm ACP chat of `creator` (watched now) whose Worker started `epoch` with capsule `fill`. */
async function startedChat(creator: Role = "owner", options: Parameters<typeof acpChat>[4] = {}, workspace = fixture) {
  const { chat } = await acpChat(test.runtime, users, workspace, creator, { scope: "workspace", ...options });
  expect(await call(creator).acp.watch({ chat, tab: `tab-${chat}` })).toEqual({ warm: true });
  expect(await workspace.machine.worker.acp.startEpoch({ chat, epoch: 1, capsule: capsuleOf(1) })).toEqual({
    accepted: true,
  });
  return chat;
}

describe("epoch streams", () => {
  it("startEpoch stores the capsule as the first message; an exact retry passes, other bytes conflict", async () => {
    const chat = await startedChat();
    const machine = fixture.machine.worker.acp;
    expect((await messagesOf("owner", chat, 1)).messages).toEqual([{ type: "capsule", ...capsuleOf(1) }]);
    expect(await machine.startEpoch({ chat, epoch: 1, capsule: capsuleOf(1) })).toEqual({ accepted: true });
    await expect(machine.startEpoch({ chat, epoch: 1, capsule: capsuleOf(2) })).rejects.toMatchObject({
      message: "ACP_FRAME_CONFLICT",
    });
    expect((await messagesOf("owner", chat, 1)).messages).toHaveLength(1);
    expect(await call("member").acp.getSession({ chat })).toMatchObject({
      epoch: 1,
      warm: true,
      stream: epochStreamPath(chat, 1),
    });

    // The superseded epoch's stream is deleted a minute later, so its readers can move on.
    const before = Date.now();
    expect(await machine.startEpoch({ chat, epoch: 2, capsule: capsuleOf(3) })).toEqual({ accepted: true });
    expect((await messagesOf("owner", chat, 2)).messages).toEqual([{ type: "capsule", ...capsuleOf(3) }]);
    const deletions = await db().select().from(jobs).where(eq(jobs.kind, STREAMS_DELETE_JOB));
    const deletion = deletions.find((job) => JSON.stringify(job.payload).includes(epochStreamPath(chat, 1)));
    expect(deletion!.runAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
  });

  it("only the chat's bound Worker appends, at the open epoch, with its own producer id", async () => {
    const chat = await startedChat();
    const stranger = await acpWorkspace(test.runtime, users);
    expect(await append(chat, 1, [frame(0)], { worker: stranger.worker })).toMatchObject({ status: 404 });
    expect(await append(chat, 1, [frame(0)], { token: null })).toMatchObject({ status: 401 });
    const browser = await test.app.request(`/api/streams/${epochStreamPath(chat, 1)}`, {
      method: "POST",
      headers: { ...Object.fromEntries(users.owner.headers), "content-type": "application/json" },
      body: JSON.stringify([frame(0)]),
    });
    expect(browser.status).toBe(401);
    expect(await append(chat, 2, [frame(0)], { producerId: `${fixture.worker.workerId}:2` })).toMatchObject({
      status: 409,
      error: "ACP_STALE_EPOCH",
    });
    expect(await append(chat, 1, [frame(0)], { producerId: "someone-else" })).toMatchObject({
      status: 400,
      error: "ACP_PRODUCER_REQUIRED",
    });
    expect(await append(chat, 1, [frame(0)], { contentType: "text/plain" })).toMatchObject({ status: 415 });
    // Not a stream path, and not an ACP epoch stream: nothing else accepts appends.
    const other = await test.app.request(`/api/streams/c/${chat}/runs/1`, { method: "POST" });
    expect(other.status).toBe(404);

    const first = { ...frame(0), extra: "dropped" };
    expect(await append(chat, 1, [first])).toMatchObject({ status: 200 });
    // An exact retry (same producer epoch and sequence) is deduplicated by the stream server.
    expect(await append(chat, 1, [first])).toMatchObject({ status: 204 });
    expect(await append(chat, 1, [frame(1), frame(2)], { seq: 1 })).toMatchObject({ status: 200 });
    const { messages } = await messagesOf("member", chat, 1);
    expect(messages).toHaveLength(4);
    expect(messages[1]).toEqual({ seqFrom: 0, seqTo: 0, kind: "live", payload: first.payload });
  });

  it("refuses plaintext, oversized and malformed appends before they reach the stream", async () => {
    const chat = await startedChat();
    const refused = async (body: unknown, error: string, status = 400, raw?: string) =>
      expect(await append(chat, 1, body, { raw })).toEqual({ status, error });
    await refused([{ ...frame(0), payload: JSON.stringify([{ op: "item.upsert" }]) }], "ACP_PLAINTEXT_REFUSED");
    await refused([{ ...frame(0), payload: [{ op: "item.upsert" }] }], "ACP_PLAINTEXT_REFUSED");
    await refused([{ ...frame(0), payload: "" }], "ACP_PLAINTEXT_REFUSED");
    await refused([frame(0, ACP_SEALED_FRAME_BYTES + 1)], "ACP_FRAME_TOO_LARGE", 413);
    await refused(
      Array.from({ length: ACP_FRAMES_PER_APPEND + 1 }, (_, index) => frame(index)),
      "ACP_INVALID_FRAMES",
    );
    await refused([], "ACP_INVALID_FRAMES");
    await refused({ ...frame(0) }, "ACP_INVALID_FRAMES");
    await refused([{ ...frame(0), seqTo: -1 }], "ACP_INVALID_FRAMES");
    await refused([{ ...frame(1), seqTo: 0 }], "ACP_INVALID_FRAMES");
    await refused([{ ...frame(0), seqFrom: 0.5 }], "ACP_INVALID_FRAMES");
    await refused([{ ...frame(0), kind: "other" }], "ACP_INVALID_FRAMES");
    await refused(null, "ACP_INVALID_FRAMES", 400, "{not json");
    await refused(null, "ACP_FRAME_TOO_LARGE", 413, `[${" ".repeat(ACP_APPEND_BODY_BYTES)}]`);
    expect((await messagesOf("owner", chat, 1)).messages).toHaveLength(1);
  });

  it("a personal chat's epoch stream stays unreadable to the workspace owner", async () => {
    const chat = await startedChat("member", { scope: "personal" });
    expect(await append(chat, 1, [frame(0)])).toMatchObject({ status: 200 });
    expect((await messagesOf("member", chat, 1)).messages).toHaveLength(2);
    for (const role of ["owner", "other", "outsider"] as const) {
      expect((await messagesOf(role, chat, 1)).status).toBe(404);
      await expect(call(role).acp.watch({ chat, tab: "peek" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("deleting the chat deletes its open epoch stream", async () => {
    const chat = await startedChat();
    await call("owner").chats.delete({ chatId: chat });
    await eventually(async () => (await test.runtime.streams.tail(epochStreamPath(chat, 1))) === null);
    expect(await isWarm(kv(), fixture.worker.workerId, chat)).toBe(false);
  });

  it("revoking the Worker closes its open epochs and deletes their streams", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const chat = await startedChat("owner", {}, workspace);
    const token = await tokenOf(workspace.worker);
    expect(await append(chat, 1, [frame(0)], { worker: workspace.worker, token })).toMatchObject({ status: 200 });
    await call("owner").workers.revoke({ workspace: workspace.workspace, workerId: workspace.worker.workerId });
    expect(await append(chat, 1, [frame(1)], { worker: workspace.worker, token, seq: 1 })).toMatchObject({
      status: 401,
    });
    expect((await sessionOf(test.runtime, chat)).cooledEpoch).toBe(1);
    await sweepJobs(test.runtime);
    expect(await test.runtime.streams.tail(epochStreamPath(chat, 1))).toBeNull();
  });
});

describe("viewers and cooling", () => {
  it("heartbeats keep a session warm; cooling closes the epoch, and the next watch re-warms a new one", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const machine = workspace.machine.worker.acp;
    const { chat } = await acpChat(test.runtime, users, workspace, "owner", { scope: "workspace" });
    const { stream: inbox } = await workspace.machine.worker.inbox();
    const workerHeaders = new Headers({ authorization: `Bearer ${await tokenOf(workspace.worker)}` });
    // Whether the Worker's inbox got a `warm` doorbell after `offset`.
    const rangWarm = async (offset: string) =>
      (await readOnce(test.app, workerHeaders, inbox, offset, false)).messages.some(
        (event) => typeof event === "object" && event !== null && "topic" in event && event.topic === "warm",
      );
    const inboxStart = (await test.runtime.streams.tail(inbox))!;

    const start = Date.now();
    expect(await watch(test.runtime, users.owner.id, { chat, tab: "tab-1" }, start)).toEqual({ warm: true });
    await eventually(() => rangWarm(inboxStart));
    expect(await machine.startEpoch({ chat, epoch: 1, capsule: capsuleOf(1) })).toEqual({ accepted: true });
    expect(await append(chat, 1, [frame(0)], { worker: workspace.worker })).toMatchObject({ status: 200 });

    // A second Tab four minutes later keeps it warm past the first Tab's window.
    await watch(test.runtime, users.member.id, { chat, tab: "tab-2" }, start + 4 * MINUTE);
    await coolSessions(test.runtime, start + 6 * MINUTE);
    expect(await isWarm(kv(), workspace.worker.workerId, chat)).toBe(true);

    const cooledAt = (await test.runtime.streams.tail(inbox))!;
    await coolSessions(test.runtime, start + 9.5 * MINUTE);
    expect(await isWarm(kv(), workspace.worker.workerId, chat)).toBe(false);
    expect(await sessionOf(test.runtime, chat)).toMatchObject({ epoch: 1, cooledEpoch: 1 });
    expect(await test.runtime.streams.tail(epochStreamPath(chat, 1))).toBeNull();
    expect(await call("owner").acp.getSession({ chat })).toMatchObject({ warm: false, stream: null });
    expect(await append(chat, 1, [frame(1)], { worker: workspace.worker, seq: 1 })).toMatchObject({
      status: 409,
      error: "ACP_STALE_EPOCH",
    });
    await eventually(() => rangWarm(cooledAt));
    expect(await machine.startEpoch({ chat, epoch: 1, capsule: capsuleOf(1) })).toEqual({ accepted: false });
    expect(await machine.startEpoch({ chat, epoch: 2, capsule: capsuleOf(2) })).toEqual({ accepted: false });

    expect(await watch(test.runtime, users.owner.id, { chat, tab: "tab-1" }, start + 10 * MINUTE)).toEqual({
      warm: true,
    });
    // The cooled epoch is gone for good: the Worker starts a newer one on a fresh snapshot.
    await expect(machine.startEpoch({ chat, epoch: 1, capsule: capsuleOf(1) })).rejects.toMatchObject({
      message: "ACP_STALE_EPOCH",
    });
    expect(await machine.startEpoch({ chat, epoch: 2, capsule: capsuleOf(2) })).toEqual({ accepted: true });
    expect(await append(chat, 2, [frame(0)], { worker: workspace.worker })).toMatchObject({ status: 200 });
    expect(await call("owner").acp.getSession({ chat })).toMatchObject({ warm: true, stream: epochStreamPath(chat, 2) });
  });

  it("a prompt warms a session that cooling judges by the prompt time without viewers", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const { chat } = await acpChat(test.runtime, users, workspace, "owner", { scope: "workspace" });
    const clientId = `prompt-${chat}`;
    const before = Date.now();
    await call("owner").acp.prompt({
      chat,
      clientId,
      signed: await signedCommand("owner", {
        workspace: workspace.workspace,
        worker: workspace.worker.workerId,
        chat,
        kind: "prompt",
        clientId,
      }),
    });
    await coolSessions(test.runtime, before + 4 * MINUTE);
    expect(await isWarm(kv(), workspace.worker.workerId, chat)).toBe(true);
    await coolSessions(test.runtime, Date.now() + 6 * MINUTE);
    expect(await isWarm(kv(), workspace.worker.workerId, chat)).toBe(false);
  });
});

describe("invariants", () => {
  it("capsule: of concurrent starts of one epoch with different capsules exactly one is stored", async () => {
    for (let round = 0; round < 3; round++) {
      const { chat } = await acpChat(test.runtime, users, fixture, "owner", { scope: "workspace" });
      await call("owner").acp.watch({ chat, tab: "tab" });
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          fixture.machine.worker.acp.startEpoch({ chat, epoch: 1, capsule: capsuleOf(10 + index) }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") expect(result.reason).toMatchObject({ message: "ACP_FRAME_CONFLICT" });
      }
      expect((await messagesOf("owner", chat, 1)).messages).toHaveLength(1);
    }
  });

  it("cooling vs. a starting epoch: an epoch that starts while the session cools is refused", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const { chat } = await acpChat(test.runtime, users, workspace, "owner", { scope: "workspace" });
    const start = Date.now();
    await watch(test.runtime, users.owner.id, { chat, tab: "tab" }, start);
    await workspace.machine.worker.acp.startEpoch({ chat, epoch: 1, capsule: capsuleOf(1) });
    // Cooling's two steps (leave the warm set, then cool the epoch under the session row lock),
    // taken by hand while a start of epoch 2 waits for that lock.
    const release = Promise.withResolvers<void>();
    const holding = Promise.withResolvers<void>();
    const cooling = db().transaction(async (tx) => {
      await tx.select().from(acpSessions).where(eq(acpSessions.chat, chat)).for("update");
      holding.resolve();
      await release.promise;
      await tx
        .update(acpSessions)
        .set({ cooledEpoch: sql`${acpSessions.epoch}` })
        .where(eq(acpSessions.chat, chat));
    });
    await holding.promise;
    const starting = workspace.machine.worker.acp.startEpoch({ chat, epoch: 2, capsule: capsuleOf(2) });
    // The start is queued behind the held row lock.
    await eventually(async () => {
      const [row] = await db()
        .select({ waiting: sql<number>`count(*)::int` })
        .from(sql`pg_stat_activity`)
        .where(sql`datname = current_database() and wait_event_type = 'Lock'`);
      return row!.waiting > 0;
    });
    expect(await coolWarm(kv(), workspace.worker.workerId, chat, start + 10 * MINUTE)).toBe(true);
    release.resolve();
    await cooling;
    expect(await starting).toEqual({ accepted: false });
    expect(await sessionOf(test.runtime, chat)).toMatchObject({ epoch: 1, cooledEpoch: 1 });
  });

  it("heartbeat or prompt vs. cooling: activity after the candidates were read keeps the session warm", async () => {
    const worker = `race-${crypto.randomUUID()}`;
    const start = Date.now();
    const cutoff = start + 5 * MINUTE;
    await watchWarm(kv(), { worker, chat: "viewed", tab: "tab", now: start });
    await watchWarm(kv(), { worker, chat: "prompted", tab: "tab", now: start });
    expect(await coolingCandidates(kv(), worker, cutoff)).toEqual(["prompted", "viewed"]);
    // Between reading the candidates and cooling one, a Tab heartbeats and a prompt arrives.
    await watchWarm(kv(), { worker, chat: "viewed", tab: "tab", now: cutoff + 1 });
    await admitWarm(kv(), worker, "prompted", cutoff + 1);
    expect(await coolWarm(kv(), worker, "viewed", cutoff)).toBe(false);
    expect(await coolWarm(kv(), worker, "prompted", cutoff)).toBe(false);
    expect((await warmChats(kv(), worker)).sort()).toEqual(["prompted", "viewed"]);
  });

  it("warm cap: concurrent heartbeats past the cap warm exactly the free slots", async () => {
    const worker = `cap-${crypto.randomUUID()}`;
    for (let index = 0; index < ACP_WARM_SESSIONS_MAX - 3; index++) {
      await watchWarm(kv(), { worker, chat: `warm-${index}`, tab: "tab", now: Date.now() });
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        watchWarm(kv(), { worker, chat: `new-${index}`, tab: "tab", now: Date.now() }),
      ),
    );
    expect(results.filter((result) => result === "warmed")).toHaveLength(3);
    expect(results.filter((result) => result === "full")).toHaveLength(7);
    expect(await warmChats(kv(), worker)).toHaveLength(ACP_WARM_SESSIONS_MAX);
  });
});
