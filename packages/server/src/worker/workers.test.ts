import { eq } from "drizzle-orm";
import { randomBytes } from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acpChat, claimedCommand } from "../../test/usage";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { insertWorker, machineCaller, workerIssuerEnv } from "../../test/workers";
import { acpCommands, acpSessions } from "../acp/schema";
import { admitWarm, warmChats } from "../acp/warm";
import { chats } from "../chatroom/schema";
import { e2eeWorkerKeys } from "../e2ee/schema";
import { resolveApiKey } from "../gateway/keys";
import { apiKeys } from "../gateway/schema";
import { appRouter } from "../trpc/router";
import { projectFolders, projects, workspaceMembers, workspaces } from "../workspaces/schema";
import { workerGatewayAccess } from "./gateway";
import { pruneWorkerEnrollments, pruneWorkerTasks, WORKER_ENROLLMENT_RETENTION_MS } from "./identity";
import { workerPresence, WORKER_PRESENCE_TTL_MS } from "./presence";
import { workerEnrollments, workerGateway, workerTasks, workers } from "./schema";
import type { WorkerIdentity } from "./signing";

// Owner `workers.*` and machine `worker.*` procedures: owner/member/outsider/archived boundaries,
// another workspace's Worker, revoked Workers, Gateway access (Convex `src/worker/gateway.ts`),
// presence and the chat temp-directory fallback, the revocation transaction, and retention.

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
const db = () => test.runtime.drivers.db;
const kv = () => test.runtime.drivers.kv;
const call = (role: Role) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });
const notFound = { code: "NOT_FOUND" };

beforeAll(async () => {
  test = await createTestRuntime({ env: (await workerIssuerEnv()).env });
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `workers-${role}@example.test`);
  }
});

afterAll(async () => {
  await test?.close();
});

async function newWorkspace(options: { archived?: boolean } = {}) {
  const [row] = await db()
    .insert(workspaces)
    .values({
      ownerId: users.owner.id,
      name: "Workers",
      archivedAt: options.archived ? new Date() : null,
    })
    .returning();
  await db()
    .insert(workspaceMembers)
    .values({ workspace: row!.id, userId: users.member.id, role: "member" });
  return row!.id;
}

async function fixture() {
  const workspace = await newWorkspace();
  const worker = await insertWorker(test.runtime, workspace);
  return { workspace, worker, machine: await machineCaller(test.runtime, worker) };
}

describe("owner boundaries", () => {
  it("every workers.* procedure is owner-only; members, outsiders and archived get NOT_FOUND", async () => {
    const { workspace, worker } = await fixture();
    const archived = await newWorkspace({ archived: true });
    const probes = (space: string, role: Role) => [
      () => call(role).workers.list({ workspace: space }),
      () => call(role).workers.createEnrollment({ workspace: space, name: "x" }),
      () => call(role).workers.revokeEnrollment({ workspace: space, enrollmentId: "x" }),
      () => call(role).workers.revoke({ workspace: space, workerId: worker.workerId }),
      () => call(role).workers.issueGatewayKey({ workspace: space, workerId: worker.workerId }),
      () =>
        call(role).workers.setGatewayAccess({
          workspace: space,
          workerId: worker.workerId,
          enabled: true,
        }),
      () =>
        call(role).workers.setGatewayTelemetry({
          workspace: space,
          workerId: worker.workerId,
          telemetry: "off",
        }),
    ];
    for (const [role, space] of [
      ["member", workspace],
      ["outsider", workspace],
      ["owner", archived],
    ] as const) {
      for (const probe of probes(space, role)) {
        await expect(probe()).rejects.toMatchObject(notFound);
      }
    }
    expect((await db().select().from(workers).where(eq(workers.id, worker.workerId)))[0]!.status).toBe(
      "active",
    );
  });

  it("another workspace's Worker is refused like an unknown one", async () => {
    const { worker } = await fixture();
    const other = await newWorkspace();
    await expect(
      call("owner").workers.revoke({ workspace: other, workerId: worker.workerId }),
    ).rejects.toMatchObject(notFound);
    await expect(
      call("owner").workers.setGatewayAccess({
        workspace: other,
        workerId: worker.workerId,
        enabled: true,
      }),
    ).rejects.toMatchObject(notFound);
    expect(await call("owner").workers.list({ workspace: other })).toEqual([]);
    expect(await workerGatewayAccess(db(), worker.workerId)).toBe("off");
  });

  it("list shows identity, last heartbeat, temp directory and Gateway access", async () => {
    const { workspace, worker, machine } = await fixture();
    const quiet = await insertWorker(test.runtime, workspace, { name: "Quiet" });
    await machine.worker.reportPresence({ tempDirectory: "/tmp/radium" });
    await call("owner").workers.setGatewayAccess({
      workspace,
      workerId: worker.workerId,
      enabled: true,
    });
    const list = await call("owner").workers.list({ workspace });
    expect(list).toEqual([
      {
        workerId: worker.workerId,
        workspaceId: workspace,
        name: "Box",
        capabilities: [],
        status: "active",
        identityEpoch: 1,
        lastSeenAt: expect.any(Number),
        tempDirectory: "/tmp/radium",
        gateway: { access: "pending", telemetry: "workspace" },
      },
      expect.objectContaining({
        workerId: quiet.workerId,
        lastSeenAt: null,
        tempDirectory: null,
        gateway: { access: "off", telemetry: "workspace" },
      }),
    ]);
    expect(Math.abs(list[0]!.lastSeenAt! - Date.now())).toBeLessThan(5_000);
  });
});

describe("machine boundaries", () => {
  it("worker.* needs a valid token; a revoked Worker's token stops at once", async () => {
    const { workspace, worker, machine } = await fixture();
    const anonymous = appRouter.createCaller({ runtime: test.runtime, headers: new Headers() });
    const human = call("owner");
    for (const caller of [anonymous, human]) {
      await expect(caller.worker.current()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        caller.worker.reportPresence({ tempDirectory: "/tmp" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(caller.worker.gateway.mintKey()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(await machine.worker.current()).toEqual({
      workerId: worker.workerId,
      workspaceId: workspace,
      name: "Box",
      capabilities: [],
      status: "active",
      identityEpoch: 1,
    });
    await call("owner").workers.revoke({ workspace, workerId: worker.workerId });
    for (const probe of [
      () => machine.worker.current(),
      () => machine.worker.trustState(),
      () => machine.worker.reportPresence({ tempDirectory: "/tmp" }),
      () => machine.worker.tasks.assigned({ status: "sent" }),
      () => machine.worker.gateway.state(),
      () => machine.worker.usage.cursor(),
    ]) {
      await expect(probe()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("a Worker of an archived workspace is refused", async () => {
    const { workspace, machine } = await fixture();
    await db().update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, workspace));
    await expect(machine.worker.current()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("E2EE and usage procedures act for the token's Worker only", async () => {
    const { worker, machine } = await fixture();
    expect(await machine.worker.trustState()).toEqual({ roster: null, epochs: [] });
    expect(await machine.worker.identities({ keyIds: [] })).toEqual([]);
    await expect(
      machine.worker.publishKeys({
        pairingId: "p",
        keyId: "k",
        suite: 1,
        encryptionPublicKey: "AA",
        signingPublicKey: "AA",
        selfSignature: "AA",
        pairingMac: "AA",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await machine.worker.usage.cursor()).toBeNull();
    await machine.worker.usage.finish({ syncedThrough: "2026-11-20" });
    expect(await machine.worker.usage.cursor()).toBe("2026-11-20");
    const other = await fixture();
    expect(await other.machine.worker.usage.cursor()).toBeNull();
    expect(worker.workerId).not.toBe(other.worker.workerId);
  });
});

describe("presence", () => {
  it("is a Valkey hash with server time and a week's TTL; directories must be absolute", async () => {
    const { worker, machine } = await fixture();
    await expect(
      machine.worker.reportPresence({ tempDirectory: "relative/path" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await workerPresence(kv(), [worker.workerId])).size).toBe(0);
    await machine.worker.reportPresence({ tempDirectory: "C:\\Temp" });
    const seen = (await workerPresence(kv(), [worker.workerId, "unknown"])).get(worker.workerId);
    expect(seen).toEqual({ lastSeenAt: expect.any(Number), tempDirectory: "C:\\Temp" });
    const ttl = Number(await kv().send("PTTL", [`presence:${worker.workerId}`]));
    expect(ttl).toBeGreaterThan(WORKER_PRESENCE_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(WORKER_PRESENCE_TTL_MS);
  });

  it("a chat without a Project folder gets the Worker's temp directory", async () => {
    const { workspace, worker, machine } = await fixture();
    const [project] = await db()
      .insert(projects)
      .values({ workspace, name: "P", userId: users.owner.id })
      .returning();
    const [chat] = await db()
      .insert(chats)
      .values({ workspace, userId: users.owner.id, scope: "personal" })
      .returning();
    const selection = { workerId: worker.workerId, tools: ["read" as const] };
    const stored = async () =>
      (await db().select().from(chats).where(eq(chats.id, chat!.id)))[0]!.workerSelection;

    // No folder and no presence: no directory.
    await call("owner").chats.setWorker({ chatId: chat!.id, selection });
    expect(await stored()).toEqual({ tools: ["read"] });

    await machine.worker.reportPresence({ tempDirectory: "/tmp/radium" });
    await call("owner").chats.setWorker({ chatId: chat!.id, selection: { ...selection, tools: [] } });
    await call("owner").chats.setWorker({ chatId: chat!.id, selection });
    expect(await stored()).toEqual({ tools: ["read"], directory: "/tmp/radium" });

    // A Project folder wins over the temp directory; leaving the Project falls back again.
    await db()
      .insert(projectFolders)
      .values({ project: project!.id, worker: worker.workerId, directory: "/srv/app", position: 0 });
    await call("owner").chats.setProject({ chatId: chat!.id, project: project!.id });
    expect(await stored()).toEqual({ tools: ["read"], directory: "/srv/app" });
    await call("owner").chats.setProject({ chatId: chat!.id, project: null });
    expect(await stored()).toEqual({ tools: ["read"], directory: "/tmp/radium" });
  });
});

describe("Gateway access", () => {
  it("owner turns access on, the Worker mints its own key, off revokes it", async () => {
    const { workspace, worker, machine } = await fixture();
    expect(await machine.worker.gateway.state()).toEqual({ access: "off", keyId: null });
    await expect(machine.worker.gateway.mintKey()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      call("owner").workers.issueGatewayKey({ workspace, workerId: worker.workerId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await call("owner").workers.setGatewayAccess({
      workspace,
      workerId: worker.workerId,
      enabled: true,
    });
    expect(await workerGatewayAccess(db(), worker.workerId)).toBe("pending");
    const first = await machine.worker.gateway.mintKey();
    expect(first.key).toMatch(/^rad-sk-/);
    expect(await machine.worker.gateway.state()).toEqual({ access: "active", keyId: first.keyId });
    const resolved = await resolveApiKey(db(), kv(), first.key);
    expect(resolved).toMatchObject({ worker: worker.workerId, name: "Box", telemetry: "workspace" });

    // Enabling again keeps the key; a new mint replaces it.
    await call("owner").workers.setGatewayAccess({
      workspace,
      workerId: worker.workerId,
      enabled: true,
    });
    expect(await workerGatewayAccess(db(), worker.workerId)).toBe("active");
    const second = await machine.worker.gateway.mintKey();
    await expect(resolveApiKey(db(), kv(), first.key)).rejects.toThrow(/was deleted/);
    await resolveApiKey(db(), kv(), second.key);

    // Telemetry applies to the live key at once.
    await call("owner").workers.setGatewayTelemetry({
      workspace,
      workerId: worker.workerId,
      telemetry: "off",
    });
    expect((await resolveApiKey(db(), kv(), second.key)).telemetry).toBe("off");
    expect((await call("owner").workers.list({ workspace }))[0]!.gateway).toEqual({
      access: "active",
      telemetry: "off",
    });

    // A new key requested by the owner: pending again, the old key stops.
    await call("owner").workers.issueGatewayKey({ workspace, workerId: worker.workerId });
    expect(await machine.worker.gateway.state()).toEqual({ access: "pending", keyId: null });
    await expect(resolveApiKey(db(), kv(), second.key)).rejects.toThrow(/was deleted/);
    const third = await machine.worker.gateway.mintKey();
    expect((await resolveApiKey(db(), kv(), third.key)).telemetry).toBe("off");

    await call("owner").workers.setGatewayAccess({
      workspace,
      workerId: worker.workerId,
      enabled: false,
    });
    expect(await machine.worker.gateway.state()).toEqual({ access: "off", keyId: null });
    await expect(resolveApiKey(db(), kv(), third.key)).rejects.toThrow(/was deleted/);
    expect(await machine.worker.gateway.models()).toEqual([]);
  });

  it("telemetry can be chosen before access is on; revoked Workers are refused", async () => {
    const { workspace, worker } = await fixture();
    await call("owner").workers.setGatewayTelemetry({
      workspace,
      workerId: worker.workerId,
      telemetry: "off",
    });
    const [row] = await db()
      .select()
      .from(workerGateway)
      .where(eq(workerGateway.worker, worker.workerId));
    expect(row).toMatchObject({ access: "off", telemetry: "off", apiKey: null });
    const revoked = await insertWorker(test.runtime, workspace, { status: "revoked" });
    await expect(
      call("owner").workers.setGatewayAccess({
        workspace,
        workerId: revoked.workerId,
        enabled: true,
      }),
    ).rejects.toMatchObject(notFound);
  });

  it("concurrent mints leave the Worker exactly one live key", async () => {
    const { workspace, worker, machine } = await fixture();
    await call("owner").workers.setGatewayAccess({
      workspace,
      workerId: worker.workerId,
      enabled: true,
    });
    const results = await Promise.allSettled([0, 1, 2, 3].map(() => machine.worker.gateway.mintKey()));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const live = await db()
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.worker, worker.workerId));
    expect(live.filter((key) => key.revokedAt === null)).toHaveLength(1);
    const state = await machine.worker.gateway.state();
    expect(state.keyId).toBe(live.find((key) => key.revokedAt === null)!.id);
  });
});

describe("revocation", () => {
  async function seedWork(workspace: string, worker: WorkerIdentity) {
    await call("owner").workers.setGatewayAccess({
      workspace,
      workerId: worker.workerId,
      enabled: true,
    });
    const machine = await machineCaller(test.runtime, worker);
    const { key } = await machine.worker.gateway.mintKey();
    await resolveApiKey(db(), kv(), key);
    await machine.worker.reportPresence({ tempDirectory: "/tmp/radium" });
    await db()
      .insert(e2eeWorkerKeys)
      .values({
        worker: worker.workerId,
        keyId: "worker-key",
        suite: 1,
        encryptionPublicKey: randomBytes(1216),
        signingPublicKey: randomBytes(32),
        selfSignature: randomBytes(64),
        pairingMac: randomBytes(32),
        pairingId: "pairing",
      });
    const now = new Date();
    const task = (status: "sent" | "processing" | "success", requestId: string) => ({
      worker: worker.workerId,
      requestId,
      operation: "bash",
      status,
      revision: status === "sent" ? 0 : 1,
      attempt: status === "sent" ? 0 : 1,
      updatedAt: now,
      terminalAt: status === "success" ? now : null,
    });
    await db()
      .insert(workerTasks)
      .values([task("sent", "a"), task("processing", "b"), task("success", "c")]);
    const { chat } = await acpChat(test.runtime, {
      workspace,
      worker: worker.workerId,
      userId: users.owner.id,
    });
    await claimedCommand(test.runtime, {
      workspace,
      worker: worker.workerId,
      chat,
      issuedBy: users.owner.id,
    });
    await admitWarm(kv(), worker.workerId, chat);
    return { key, chat };
  }

  it("revokes everything the Worker held in one transaction, once", async () => {
    const { workspace, worker, machine } = await fixture();
    const { key, chat } = await seedWork(workspace, worker);

    await call("owner").workers.revoke({ workspace, workerId: worker.workerId });
    const [row] = await db().select().from(workers).where(eq(workers.id, worker.workerId));
    expect(row).toMatchObject({ status: "revoked", identityEpoch: 2 });
    expect(await db().select().from(e2eeWorkerKeys).where(eq(e2eeWorkerKeys.worker, worker.workerId))).toEqual([]);
    expect(await db().select().from(workerGateway).where(eq(workerGateway.worker, worker.workerId))).toEqual([]);
    // The key cache was tombstoned: the cached resolution is gone at once.
    await expect(resolveApiKey(db(), kv(), key)).rejects.toThrow(/was deleted/);
    const tasks = await db().select().from(workerTasks).where(eq(workerTasks.worker, worker.workerId));
    expect(
      tasks.map((task) => [task.requestId, task.status, task.revision, task.terminalAt !== null]).sort(),
    ).toEqual([
      ["a", "failed", 1, true],
      ["b", "failed", 2, true],
      ["c", "success", 1, true],
    ]);
    expect((await db().select().from(acpSessions).where(eq(acpSessions.chat, chat)))[0]!.status).toBe(
      "failed",
    );
    const [command] = await db().select().from(acpCommands).where(eq(acpCommands.chat, chat));
    expect(command).toMatchObject({ status: "failed", error: "ACP_ABANDONED" });
    expect((await workerPresence(kv(), [worker.workerId])).size).toBe(0);
    expect(await warmChats(kv(), worker.workerId)).toEqual([]);
    await expect(machine.worker.current()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // A retry changes nothing more.
    await call("owner").workers.revoke({ workspace, workerId: worker.workerId });
    expect(
      (await db().select().from(workers).where(eq(workers.id, worker.workerId)))[0]!.identityEpoch,
    ).toBe(2);
  });

  it("concurrent revocations advance the epoch exactly once", async () => {
    const { workspace, worker } = await fixture();
    await Promise.all(
      [0, 1, 2, 3].map(() => call("owner").workers.revoke({ workspace, workerId: worker.workerId })),
    );
    expect(
      (await db().select().from(workers).where(eq(workers.id, worker.workerId)))[0]!.identityEpoch,
    ).toBe(2);
  });

  it("a mint racing revocation never leaves a live key", async () => {
    const { workspace, worker, machine } = await fixture();
    await call("owner").workers.setGatewayAccess({
      workspace,
      workerId: worker.workerId,
      enabled: true,
    });
    await Promise.allSettled([
      machine.worker.gateway.mintKey(),
      call("owner").workers.revoke({ workspace, workerId: worker.workerId }),
      machine.worker.gateway.mintKey(),
    ]);
    const keys = await db().select().from(apiKeys).where(eq(apiKeys.worker, worker.workerId));
    expect(keys.filter((key) => key.revokedAt === null)).toEqual([]);
    expect(await workerGatewayAccess(db(), worker.workerId)).toBe("off");
  });
});

describe("retention", () => {
  it("deletes finished tasks after five minutes and stale unused setup codes after a week", async () => {
    const { workspace, worker } = await fixture();
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms);
    await db()
      .insert(workerTasks)
      .values(
        (
          [
            ["old-done", "success", at(6 * 60_000)],
            ["old-failed", "failed", at(6 * 60_000)],
            ["recent", "success", at(60_000)],
            ["running", "processing", null],
          ] as const
        ).map(([requestId, status, terminalAt]) => ({
          worker: worker.workerId,
          requestId,
          operation: "bash",
          status,
          revision: 1,
          attempt: 1,
          updatedAt: new Date(now),
          terminalAt,
        })),
      );
    expect(await pruneWorkerTasks(db(), now, 1)).toBe(1);
    expect(await pruneWorkerTasks(db(), now, 100)).toBe(1);
    expect(
      (await db().select().from(workerTasks).where(eq(workerTasks.worker, worker.workerId)))
        .map((task) => task.requestId)
        .sort(),
    ).toEqual(["recent", "running"]);

    const old = at(WORKER_ENROLLMENT_RETENTION_MS + 60_000);
    const enrollment = (state: "pending" | "revoked", expiresAt: Date) => ({
      workspace,
      tokenHash: crypto.randomUUID(),
      name: state,
      capabilities: [],
      expiresAt,
      state,
    });
    await db()
      .insert(workerEnrollments)
      .values([
        enrollment("pending", old),
        enrollment("revoked", old),
        enrollment("pending", at(60_000)),
      ]);
    await db().insert(workerEnrollments).values({
      ...enrollment("pending", old),
      state: "completed",
      completionWorker: worker.workerId,
      completionKey: worker.keyId,
      completionRequestId: "request",
    });
    expect(await pruneWorkerEnrollments(db(), now, 100)).toBe(2);
    expect(
      (await db().select().from(workerEnrollments).where(eq(workerEnrollments.workspace, workspace)))
        .map((row) => row.state)
        .sort(),
    ).toEqual(["completed", "pending"]);
  });
});
