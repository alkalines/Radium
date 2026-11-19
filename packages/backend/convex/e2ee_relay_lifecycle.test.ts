/// <reference types="vite/client" />

import { register as registerSecretStore } from "convex-secret-store/test";
import { convexTest, type TestConvex } from "convex-test";
import { exportJWK, generateKeyPair } from "jose";
import { register as registerWorkers } from "worker-component/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import {
  ACP_COLD_AFTER_MS,
  ACP_INTERACTION_RETENTION_MS,
  type AcpAgentReport,
  type AcpInteractionRequest,
} from "../src/acp/contract";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: async (ctx: QueryCtx) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity || identity.kind === "worker") throw new Error("Not logged in");
      return { _id: identity.subject };
    },
  },
  createAuth: vi.fn(),
}));

const modules = import.meta.glob("./**/*.ts");
const previousSecretStoreKeys = process.env.SECRET_STORE_KEYS;

beforeAll(() => {
  process.env.SECRET_STORE_KEYS = `1:${Buffer.alloc(32, 1).toString("base64")}`;
});

afterAll(() => {
  if (previousSecretStoreKeys === undefined) delete process.env.SECRET_STORE_KEYS;
  else process.env.SECRET_STORE_KEYS = previousSecretStoreKeys;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const agent: AcpAgentReport = {
  agentId: "test-agent",
  name: "Test agent",
  version: "1",
  source: "custom",
  status: "ready",
  capabilities: {
    loadSession: true,
    list: true,
    resume: true,
    close: true,
    delete: true,
    fork: true,
    logout: true,
    image: false,
    audio: false,
    embeddedContext: false,
    mcpHttp: false,
    mcpSse: false,
  },
  authMethods: [{ id: "login", name: "Sign in", type: "agent" }],
  defaults: {
    config: {
      options: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "a",
          choices: [
            { value: "a", name: "A" },
            { value: "b", name: "B" },
          ],
        },
      ],
    },
  },
};
const permission: AcpInteractionRequest = {
  kind: "permission",
  toolCallId: "read-1",
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
};

type Harness = TestConvex<typeof schema>;

async function drain(t: Harness) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function fixture() {
  vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.invalid");
  const t = convexTest(schema, modules);
  registerWorkers(t);
  registerSecretStore(t);
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Relay" }),
  );
  async function enroll(name: string) {
    const tokenHash = await tokenDigest(name.padEnd(43, "_"));
    const pair = await generateKeyPair("ES256", { extractable: true });
    const publicKey = await normalizeWorkerKey(await exportJWK(pair.publicKey));
    await t.run((ctx) =>
      ctx.runMutation(components.workerIdentity.enrollment.createEnrollment, {
        workspaceId: workspace,
        name,
        tokenHash,
        expiresAt: Date.now() + 60_000,
        capabilities: [],
      }),
    );
    const identity = await t.run((ctx) =>
      ctx.runMutation(components.workerIdentity.enrollment.completeEnrollment, {
        workspaceId: workspace,
        tokenHash,
        requestId: tokenHash,
        publicKey,
      }),
    );
    return {
      worker: identity.workerId,
      machine: t.withIdentity({
        ...identity,
        subject: identity.workerId,
        kind: "worker",
        issuer: workerIssuer("https://backend.example.invalid"),
      }),
    };
  }
  const owner = t.withIdentity({ subject: "owner" });
  return { t, workspace, owner, enroll };
}

/** An ACP chat owned by "owner" with its (idle by default) session row. */
async function insertChat(
  t: Harness,
  workspace: Id<"workspaces">,
  worker: string,
  session: Partial<Doc<"acp_sessions">> = {},
) {
  return await t.run(async (ctx) => {
    const chat = await ctx.db.insert("aisdk_chats", {
      workspace,
      userId: "owner",
      scope: "personal",
      lastInteractionAt: 1,
      activeStream: false,
      agent: {
        kind: "acp",
        profile: "native",
        worker,
        agentId: agent.agentId,
        agentVersion: "1",
        cwd: "/work",
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      },
    });
    const sessionId = await ctx.db.insert("acp_sessions", {
      chat,
      workspace,
      worker,
      agentId: agent.agentId,
      cwd: "/work",
      status: "idle",
      epoch: 0,
      warm: false,
      updatedAt: 1,
      ...session,
    });
    return { chat, session: sessionId };
  });
}

async function startCutover(t: Harness) {
  await t.action(internal.e2ee_migration_node.createCustody, {});
  await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
}

async function runJobs(t: Harness, kind: "seal" | "verify", tables: string[]) {
  await t.mutation(internal.e2ee_migration.startJobs, {
    kind,
    tables,
    ...(kind === "seal" ? { dryRun: false } : {}),
  });
  await drain(t);
  const jobs = await t.run((ctx) => ctx.db.query("e2ee_migration_jobs").order("desc").take(tables.length));
  return Object.fromEntries(jobs.map((job) => [job.table, job]));
}

const RELAY_TABLES = ["chat_frames", "acp_sessions", "acp_commands", "acp_interactions", "worker_tasks"];

describe("stale relay rows of revoked or dead Workers", () => {
  test("only revoked or unknown Workers qualify, content survives, and sealing then completes", async () => {
    const f = await fixture();
    const { t, owner, workspace } = f;
    const dead = await f.enroll("dead");
    const live = await f.enroll("live");
    const { chat } = await insertChat(t, workspace, dead.worker, {
      status: "running",
      warm: true,
      warmSince: 1,
      error: "crashed in /home/secret",
    });
    const ids = await t.run(async (ctx) => ({
      command: await ctx.db.insert("acp_commands", {
        workspace,
        worker: dead.worker,
        chat,
        kind: "prompt",
        payload: { kind: "prompt", prompt: [{ type: "text", text: "secret prompt" }] },
        clientId: "c1",
        by: "owner",
        status: "pending",
      }),
      interaction: await ctx.db.insert("acp_interactions", {
        chat,
        workspace,
        worker: "ghost-worker",
        requestKey: "k1",
        kind: "permission",
        request: permission,
        status: "pending",
        createdAt: 1,
      }),
      task: await ctx.db.insert("worker_tasks", {
        workspace,
        workerId: dead.worker,
        requestId: "t1",
        operation: "edit",
        chatId: chat,
        status: "sent",
        revision: 0,
        attempt: 0,
        updatedAt: 1,
        editRequest: {
          sessionId: "s",
          directory: "/work",
          action: { kind: "read", path: "/work/secret.txt" },
        },
      }),
      liveTask: await ctx.db.insert("worker_tasks", {
        workspace,
        workerId: live.worker,
        requestId: "t2",
        operation: "edit",
        chatId: chat,
        status: "processing",
        revision: 1,
        attempt: 1,
        updatedAt: 1,
        claimId: "claim",
        editRequest: {
          sessionId: "s",
          directory: "/work",
          action: { kind: "read", path: "/work/other-secret.txt" },
        },
      }),
      frame: await ctx.db.insert("chat_frames", {
        chat,
        stream: "acp:0",
        seqFrom: 0,
        seqTo: 0,
        format: "acp",
        kind: "snapshot",
        payload: '["secret frame"]',
      }),
    }));
    const page = (table: "acp_commands" | "acp_interactions" | "worker_tasks" | "acp_sessions", status: string) =>
      t.query(internal.e2ee_legacy_relay.staleRelayBlockers, {
        table,
        status,
        paginationOpts: { numItems: 50, cursor: null },
      });

    // Discovery is read-only; an active Worker is never declared dead, whatever the row's age.
    const pending = await page("acp_commands", "pending");
    expect(pending.rows).toMatchObject([
      { record: ids.command, workerState: "active", remediation: "revoke_worker_first" },
    ]);
    expect((await page("acp_interactions", "pending")).rows).toMatchObject([
      { record: ids.interaction, workerState: "absent", remediation: "abandon" },
    ]);
    expect((await page("worker_tasks", "processing")).rows).toMatchObject([
      { record: ids.liveTask, workerState: "active", remediation: "revoke_worker_first" },
    ]);
    expect((await page("acp_sessions", "all")).rows).toMatchObject([
      { blocker: "busy_session", frames: true, workerState: "active" },
    ]);
    await owner.mutation(api.workers.revoke, { workspace, workerId: dead.worker });
    expect((await page("acp_commands", "pending")).rows).toMatchObject([
      { workerState: "revoked", remediation: "abandon" },
    ]);

    const selection = [
      { table: "acp_commands" as const, record: ids.command },
      { table: "acp_interactions" as const, record: ids.interaction },
      { table: "worker_tasks" as const, record: ids.task },
      { table: "worker_tasks" as const, record: ids.liveTask },
      { table: "acp_sessions" as const, record: (await page("acp_sessions", "all")).rows[0]!.record },
    ];
    const before = await t.run(async (ctx) => [
      await ctx.db.get("acp_commands", ids.command),
      await ctx.db.get("worker_tasks", ids.task),
    ]);

    // A dry run reports and writes nothing; a real run needs the freeze that stops Workers and pruning.
    const dry = await t.mutation(internal.e2ee_legacy_relay.abandonRelayRows, { rows: selection });
    expect(dry.results.map((row) => row.outcome)).toEqual([
      "would_abandon",
      "would_abandon",
      "would_abandon",
      "worker_active",
      "would_abandon",
    ]);
    await expect(
      t.mutation(internal.e2ee_legacy_relay.abandonRelayRows, { rows: selection, dryRun: false }),
    ).rejects.toThrow("LEGACY_RELAY_ABANDON_REQUIRES_FREEZE");
    expect(await t.run(async (ctx) => [
      await ctx.db.get("acp_commands", ids.command),
      await ctx.db.get("worker_tasks", ids.task),
    ])).toEqual(before);

    await startCutover(t);
    const real = await t.mutation(internal.e2ee_legacy_relay.abandonRelayRows, {
      rows: selection,
      dryRun: false,
    });
    expect(real.results.map((row) => row.outcome)).toEqual([
      "abandoned",
      "abandoned",
      "abandoned",
      "worker_active",
      "abandoned",
    ]);
    const closed = await t.run(async (ctx) => ({
      command: await ctx.db.get("acp_commands", ids.command),
      interaction: await ctx.db.get("acp_interactions", ids.interaction),
      task: await ctx.db.get("worker_tasks", ids.task),
      liveTask: await ctx.db.get("worker_tasks", ids.liveTask),
      session: await ctx.db.query("acp_sessions").first(),
      chat: await ctx.db.get("aisdk_chats", chat),
    }));
    // Fixed terminal status and code; every plaintext field is still there for the seal.
    expect(closed.command).toMatchObject({ status: "failed", error: "ACP_ABANDONED" });
    const originalCommand = before[0];
    expect(originalCommand && "payload" in originalCommand ? originalCommand.payload : undefined).toBeDefined();
    expect(closed.command?.payload).toEqual(originalCommand && "payload" in originalCommand ? originalCommand.payload : undefined);
    expect(closed.interaction).toMatchObject({ status: "cancelled", request: permission });
    expect(closed.task).toMatchObject({ status: "failed", revision: 1, editRequest: { sessionId: "s" } });
    expect(closed.task?.result).toBeUndefined();
    expect(closed.liveTask).toMatchObject({ status: "processing", revision: 1 });
    expect(closed.session).toMatchObject({ status: "failed", warm: false, error: "crashed in /home/secret" });
    expect(closed.chat?.activeStream).toBe(false);

    // Revoking the live Worker first is the only way its row qualifies.
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: false });
    await owner.mutation(api.workers.revoke, { workspace, workerId: live.worker });
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
    const second = await t.mutation(internal.e2ee_legacy_relay.abandonRelayRows, {
      rows: [selection[2]!, selection[3]!],
      dryRun: false,
    });
    expect(second.results.map((row) => row.outcome)).toEqual(["not_blocking", "abandoned"]);

    const sealed = await runJobs(t, "seal", RELAY_TABLES);
    for (const table of RELAY_TABLES)
      expect(sealed[table], table).toMatchObject({ status: "completed", blocked: 0, conflicts: 0 });
    const after = await t.run(async (ctx) => ({
      command: await ctx.db.get("acp_commands", ids.command),
      interaction: await ctx.db.get("acp_interactions", ids.interaction),
      task: await ctx.db.get("worker_tasks", ids.task),
      liveTask: await ctx.db.get("worker_tasks", ids.liveTask),
      session: await ctx.db.query("acp_sessions").first(),
      frame: await ctx.db.get("chat_frames", ids.frame),
    }));
    for (const [name, row] of Object.entries(after))
      expect(row?.legacyContent?.kind, name).toBe("custody");
    // The fixed abandonment code is metadata and stays; only the plaintext payload moved.
    expect(after.command).toMatchObject({ status: "failed", error: "ACP_ABANDONED" });
    expect(after.command?.payload).toBeUndefined();
    expect(after.interaction?.request).toBeUndefined();
    // Sealed history is never delivered as assignable work, and nothing was deleted or replayed.
    expect(after.task?.status).toBe("failed");
    expect(after.task?.editRequest).toBeUndefined();
    expect(after.liveTask?.status).toBe("failed");
    expect(after.liveTask?.editRequest).toBeUndefined();
    expect(after.session?.status).toBe("failed");
    expect(after.session?.error).toBeUndefined();
    expect(after.frame?.payload).toBe("");

    const verified = await runJobs(t, "verify", RELAY_TABLES);
    for (const table of RELAY_TABLES)
      expect(verified[table], table).toMatchObject({ status: "completed", plaintext: 0, blocked: 0 });
  });

  test("discovery scans only listed statuses and selections are validated, never guessed", async () => {
    const f = await fixture();
    await expect(
      f.t.query(internal.e2ee_legacy_relay.staleRelayBlockers, {
        table: "acp_commands",
        status: "done",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow("LEGACY_RELAY_ABANDON_UNKNOWN_SCAN");
    await expect(
      f.t.mutation(internal.e2ee_legacy_relay.abandonRelayRows, {
        rows: [
          { table: "acp_commands", record: "x" },
          { table: "acp_commands", record: "x" },
        ],
      }),
    ).rejects.toThrow("LEGACY_RELAY_ABANDON_DUPLICATE_ROW");
    // Unknown and foreign ids are reported, never guessed at.
    const result = await f.t.mutation(internal.e2ee_legacy_relay.abandonRelayRows, {
      rows: [{ table: "acp_commands", record: "not-an-id" }],
    });
    expect(result.results).toEqual([{ table: "acp_commands", record: "not-an-id", outcome: "missing" }]);
  });
});

describe("cancelling a queued prompt", () => {
  const signed = {
    clientId: "queued",
    payload: new Uint8Array([1, 2, 3]).buffer,
    signature: new ArrayBuffer(64),
    signerKeyId: "signer",
  };

  test("is frozen with every other writer and records only a fixed code after cutover", async () => {
    const f = await fixture();
    const { t, owner, workspace } = f;
    const worker = await f.enroll("worker");
    const { chat } = await insertChat(t, workspace, worker.worker, { status: "starting" });
    const command = await t.run((ctx) =>
      ctx.db.insert("acp_commands", {
        workspace,
        worker: worker.worker,
        chat,
        kind: "prompt",
        signed,
        clientId: "queued",
        by: "owner",
        status: "pending",
      }),
    );

    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
    await expect(owner.mutation(api.acp.Cancel, { chat })).rejects.toThrow("frozen");
    expect(await t.run((ctx) => ctx.db.get("acp_commands", command))).toMatchObject({ status: "pending" });

    await t.run(async (ctx) => {
      const state = await ctx.db.query("e2ee_migration_state").first();
      await ctx.db.patch("e2ee_migration_state", state!._id, {
        frozen: false,
        cutoverComplete: true,
        generation: state!.generation + 1,
        custodyState: "active",
      });
    });
    await owner.mutation(api.acp.Cancel, { chat });
    const cancelled = await t.run((ctx) => ctx.db.get("acp_commands", command));
    expect(cancelled).toMatchObject({ status: "failed", error: "ACP_CANCELLED" });
    expect(cancelled?.signed).toBeUndefined();
    expect(cancelled?.payload).toBeUndefined();

    // Verification reads the fixed code as metadata, so custody can still be proven plaintext-free.
    const verified = await runJobs(t, "verify", ["acp_commands"]);
    expect(verified.acp_commands).toMatchObject({ status: "completed", plaintext: 0, blocked: 0 });
  });
});

describe("aborting a cutover after relay rows were sealed", () => {
  test("no writer puts plaintext beside a sidecar and a re-freeze seals nothing new", async () => {
    const f = await fixture();
    const { t, owner, workspace } = f;
    const worker = await f.enroll("worker");
    await worker.machine.mutation(api.acp.reportAgents, {
      agents: [{ ...agent, error: "ENOENT /home/secret/agent" }],
    });
    await worker.machine.mutation(api.acp.syncAgentSessions, {
      agentId: agent.agentId,
      upserts: [{ sessionId: "indexed", cwd: "/work", title: "Secret title", updatedAt: 10 }],
      removals: [],
      finish: { error: "boom /home/secret" },
    });
    const bound = await insertChat(t, workspace, worker.worker, {
      sessionId: "indexed",
      error: "crashed in /home/secret",
    });
    const draft = await insertChat(t, workspace, worker.worker, {
      draft: { config: [{ configId: "model", value: "b" }] },
    });
    const tables = ["acp_sessions", "worker_agents", "acp_agent_sessions"];

    await startCutover(t);
    const sealed = await runJobs(t, "seal", tables);
    for (const table of tables)
      expect(sealed[table], table).toMatchObject({ status: "completed", blocked: 0, conflicts: 0 });
    const snapshot = () =>
      t.run(async (ctx) => ({
        session: await ctx.db.get("acp_sessions", bound.session),
        draft: await ctx.db.get("acp_sessions", draft.session),
        agent: await ctx.db.query("worker_agents").first(),
        indexed: await ctx.db.query("acp_agent_sessions").first(),
      }));
    const first = await snapshot();
    for (const [name, row] of Object.entries(first))
      expect(row?.legacyContent, name).toBeDefined();
    expect(first.session?.error).toBeUndefined();
    expect(first.agent?.error).toBeUndefined();
    expect(first.agent?.sessionsSync?.status).toBe("failed");
    expect(first.agent?.sessionsSync?.error).toBeUndefined();
    expect(first.indexed?.title).toBeUndefined();

    // Abort: the keyless writers are allowed again, but never beside a sidecar.
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: false });
    await drain(t);
    await worker.machine.mutation(api.acp.updateSession, {
      chat: bound.chat,
      patch: {
        status: "failed",
        error: "a brand new secret",
        config: agent.defaults!.config,
        title: "New secret title",
        history: "full",
      },
    });
    await worker.machine.mutation(api.acp.reportAgents, {
      agents: [{ ...agent, error: "another secret path" }],
    });
    await worker.machine.mutation(api.acp.syncAgentSessions, {
      agentId: agent.agentId,
      upserts: [{ sessionId: "indexed", cwd: "/work", title: "Another title", updatedAt: 20 }],
      removals: [],
      finish: { error: "fresh failure text" },
    });
    await expect(
      owner.mutation(api.acp.SetConfig, { chat: draft.chat, configId: "model", value: "a" }),
    ).rejects.toThrow("ACP_PLAINTEXT_REFUSED");
    await expect(
      owner.mutation(api.acp.SetMode, { chat: draft.chat, modeId: "code" }),
    ).rejects.toThrow("ACP_PLAINTEXT_REFUSED");

    const aborted = await snapshot();
    // Current state still moves forward, and the preserved sidecars stay byte-identical.
    expect(aborted.session).toMatchObject({ status: "failed", history: "full" });
    expect(aborted.session?.error).toBeUndefined();
    expect(aborted.session?.config).toBeUndefined();
    expect(aborted.agent?.error).toBeUndefined();
    expect(aborted.agent?.sessionsSync).toMatchObject({ status: "failed", error: "ACP_FAILED" });
    expect(aborted.indexed?.title).toBeUndefined();
    expect(aborted.indexed?.updatedAt).toBe(20);
    expect(aborted.draft?.draft).toBeUndefined();
    for (const name of ["session", "draft", "agent", "indexed"] as const)
      expect(new Uint8Array(aborted[name]!.legacyContent!.box)).toEqual(
        new Uint8Array(first[name]!.legacyContent!.box),
      );

    // The next freeze finds nothing to merge: no conflict, no block, nothing re-sealed.
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
    const again = await runJobs(t, "seal", tables);
    for (const table of tables)
      expect(again[table], table).toMatchObject({ status: "completed", blocked: 0, conflicts: 0, changed: 0 });
    const verified = await runJobs(t, "verify", tables);
    for (const table of tables)
      expect(verified[table], table).toMatchObject({ status: "completed", plaintext: 0, blocked: 0 });
  });
});

describe("relay writers and maintenance during the cutover freeze", () => {
  const signed = {
    clientId: "signed-1",
    payload: new Uint8Array([1, 2, 3]).buffer,
    signature: new ArrayBuffer(64),
    signerKeyId: "signer",
  };
  const binding = {
    version: 1,
    scope: "personal" as const,
    members: [],
    signerKeyId: "signer",
    signature: new ArrayBuffer(64),
  };

  async function pendingCleanups(t: Harness, name: string) {
    return await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.state.kind === "pending" && job.name.includes(name),
      ),
    );
  }

  test("every signed and plaintext browser writer is refused, Watch is a no-op, and all resume after the freeze", async () => {
    const f = await fixture();
    const { t, owner, workspace } = f;
    const worker = await f.enroll("worker");
    const { chat, session } = await insertChat(t, workspace, worker.worker);
    const target = await insertChat(t, workspace, worker.worker);
    const interaction = await t.run((ctx) =>
      ctx.db.insert("acp_interactions", {
        chat,
        workspace,
        worker: worker.worker,
        requestKey: "k1",
        kind: "permission",
        request: permission,
        status: "pending",
        createdAt: 1,
      }),
    );
    const snapshot = () =>
      t.run(async (ctx) => ({
        session: await ctx.db.get("acp_sessions", session),
        chat: await ctx.db.get("aisdk_chats", chat),
        target: await ctx.db.get("acp_sessions", target.session),
        interaction: await ctx.db.get("acp_interactions", interaction),
        commands: await ctx.db.query("acp_commands").collect(),
        viewers: await ctx.db.query("chat_viewers").collect(),
      }));
    const before = await snapshot();

    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
    const writers = {
      "Prompt (plaintext)": () =>
        owner.mutation(api.acp.Prompt, { chat, clientId: "p1", prompt: [{ type: "text", text: "hi" }] }),
      "Prompt (signed)": () => owner.mutation(api.acp.Prompt, { chat, clientId: signed.clientId, signed }),
      "SetConfig (plaintext)": () =>
        owner.mutation(api.acp.SetConfig, { chat, configId: "model", value: "b" }),
      "SetConfig (signed)": () => owner.mutation(api.acp.SetConfig, { chat, signed }),
      "SetMode (plaintext)": () => owner.mutation(api.acp.SetMode, { chat, modeId: "code" }),
      "SetMode (signed)": () => owner.mutation(api.acp.SetMode, { chat, signed }),
      "Answer (plaintext)": () =>
        owner.mutation(api.acp.Answer, {
          interaction,
          answer: { kind: "permission", optionId: "allow" },
        }),
      "Answer (signed)": () =>
        owner.mutation(api.acp.Answer, {
          interaction,
          sealed: { answer: new ArrayBuffer(8), signature: new ArrayBuffer(64), signerKeyId: "signer" },
        }),
      "RequestHistory (plaintext)": () =>
        owner.mutation(api.acp.RequestHistory, { chat, epoch: 0, before: 0, limit: 10 }),
      "RequestHistory (signed)": () =>
        owner.mutation(api.acp.RequestHistory, { chat, epoch: 0, before: 0, limit: 10, signed }),
      "Fork": () => owner.mutation(api.acp.Fork, { chat, clientId: "fork-1" }),
      "StartFork": () =>
        owner.mutation(api.acp.StartFork, { chat, target: target.chat, binding, signed }),
      "PublishBinding": () => owner.mutation(api.acp.PublishBinding, { chat, binding }),
      "SetFallbackTitle": () =>
        owner.mutation(api.acp.SetFallbackTitle, {
          chat,
          sealedTitle: { epoch: 1, box: new ArrayBuffer(64) },
        }),
    };
    for (const [name, write] of Object.entries(writers))
      await expect(write(), name).rejects.toThrow("Writes are frozen");
    // A session that is never made busy or warm stays sealable; nothing was queued or written.
    expect(await snapshot()).toEqual(before);

    // Watch neither heartbeats nor warms while frozen, and still reports the stored state.
    expect(await owner.mutation(api.chatroom.Watch, { chat, tab: "tab" })).toEqual({ warm: false });
    expect(await snapshot()).toEqual(before);

    // Aborting the freeze restores normal behaviour, signed and plaintext paths alike.
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: false });
    expect(await owner.mutation(api.chatroom.Watch, { chat, tab: "tab" })).toEqual({ warm: true });
    await owner.mutation(api.acp.Prompt, {
      chat,
      clientId: "p2",
      prompt: [{ type: "text", text: "hi again" }],
    });
    expect(await t.run((ctx) => ctx.db.get("acp_sessions", session))).toMatchObject({
      status: "starting",
      warm: true,
    });
  });

  test("queued cleanup waits for the freeze without being lost, then runs normally", async () => {
    const f = await fixture();
    const { t, owner, workspace } = f;
    const worker = await f.enroll("worker");
    const cooled = await insertChat(t, workspace, worker.worker, { warm: true, warmSince: 1, updatedAt: 1 });
    const ids = await t.run(async (ctx) => ({
      stream: await ctx.db.insert("acp_streams", { chat: cooled.chat, epoch: 0, nextSeq: 1, bytes: 14 }),
      frame: await ctx.db.insert("chat_frames", {
        chat: cooled.chat,
        stream: "acp:0",
        seqFrom: 0,
        seqTo: 0,
        format: "acp",
        kind: "snapshot",
        payload: '["secret frame"]',
      }),
      command: await ctx.db.insert("acp_commands", {
        workspace,
        worker: worker.worker,
        chat: cooled.chat,
        kind: "prompt",
        payload: { kind: "prompt", prompt: [{ type: "text", text: "secret prompt" }] },
        clientId: "old",
        by: "owner",
        status: "failed",
        error: "ACP_ABANDONED",
        finishedAt: 1,
      }),
      interaction: await ctx.db.insert("acp_interactions", {
        chat: cooled.chat,
        workspace,
        worker: worker.worker,
        requestKey: "k1",
        kind: "permission",
        request: permission,
        status: "cancelled",
        createdAt: 1,
        resolvedAt: 1,
      }),
    }));
    const rows = () =>
      t.run(async (ctx) => ({
        stream: await ctx.db.get("acp_streams", ids.stream),
        frame: await ctx.db.get("chat_frames", ids.frame),
        command: await ctx.db.get("acp_commands", ids.command),
        interaction: await ctx.db.get("acp_interactions", ids.interaction),
      }));
    const parked = () => t.run((ctx) => ctx.db.query("acp_deferred_cleanups").collect());

    // Cooling ran before the freeze, so its one-shot frame cleanup is already queued.
    await t.mutation(internal.acp.coolSessions, {});
    expect(await t.run((ctx) => ctx.db.get("acp_sessions", cooled.session))).toMatchObject({
      warm: false,
      cooledEpoch: 0,
    });
    expect(await pendingCleanups(t, "clearColdChat")).toHaveLength(1);
    const stale = await insertChat(t, workspace, worker.worker, { warm: true, warmSince: 1, updatedAt: 1 });
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });

    // The queued job fires during the freeze, as does a superseded-stream cleanup: they delete
    // nothing and park in the journal instead of looping or being lost, so draining terminates.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.mutation(internal.acp.deleteStream, { chat: cooled.chat, epoch: 0 });
    await t.mutation(internal.acp.clearColdChat, { chat: cooled.chat, epoch: 0, cutoff: Date.now() });
    await drain(t);
    expect(await parked()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "clearColdChat", chat: cooled.chat, epoch: 0 }),
      expect.objectContaining({ kind: "deleteStream", chat: cooled.chat, epoch: 0 }),
    ]));
    // Resuming while still frozen changes nothing.
    await t.mutation(internal.acp.resumeDeferredCleanup, {});
    expect(await parked()).toHaveLength(2);

    // Sweeps skip entirely: the abandoned rows are old enough to prune, the second session cold enough to cool.
    vi.setSystemTime(Date.now() + ACP_INTERACTION_RETENTION_MS + ACP_COLD_AFTER_MS);
    await t.mutation(internal.acp.prune, {});
    await t.mutation(internal.acp.coolSessions, {});
    expect(await owner.mutation(api.chatroom.Watch, { chat: cooled.chat, tab: "tab" })).toEqual({
      warm: false,
    });
    const frozen = await rows();
    expect(frozen.stream).not.toBeNull();
    expect(frozen.frame?.payload).toBe('["secret frame"]');
    expect(frozen.command?.payload).toBeDefined();
    expect(frozen.interaction?.request).toEqual(permission);
    expect(await t.run((ctx) => ctx.db.get("acp_sessions", cooled.session))).toMatchObject({ warm: false });
    expect(await t.run((ctx) => ctx.db.get("acp_sessions", stale.session))).toMatchObject({ warm: true });
    expect(await t.run((ctx) => ctx.db.query("chat_viewers").collect())).toEqual([]);

    // Unfreeze, resume, and freeze again before the resumed jobs run: they park again, deleting nothing.
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: false });
    await t.mutation(internal.acp.resumeDeferredCleanup, {});
    expect(await parked()).toHaveLength(0);
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
    await drain(t);
    expect(await parked()).toHaveLength(2);
    expect((await rows()).frame?.payload).toBe('["secret frame"]');

    // Once the freeze lifts for good, the unfreeze hook alone resumes them and sweeps behave as before.
    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: false });
    await t.mutation(internal.acp.prune, {});
    await t.mutation(internal.acp.coolSessions, {});
    await drain(t);
    expect(await parked()).toEqual([]);
    const resumed = await rows();
    expect(resumed.stream).toBeNull();
    expect(resumed.frame).toBeNull();
    expect(resumed.command).toBeNull();
    expect(resumed.interaction).toBeNull();
    expect(await t.run((ctx) => ctx.db.get("acp_sessions", stale.session))).toMatchObject({ warm: false });
  });

  test("abandoned rows and frames survive pruning, cooling and re-warming until they are sealed", async () => {
    const f = await fixture();
    const { t, owner, workspace } = f;
    const dead = await f.enroll("dead");
    const { chat } = await insertChat(t, workspace, dead.worker, {
      status: "running",
      warm: true,
      warmSince: 1,
    });
    const ids = await t.run(async (ctx) => ({
      stream: await ctx.db.insert("acp_streams", { chat, epoch: 0, nextSeq: 1, bytes: 14 }),
      frame: await ctx.db.insert("chat_frames", {
        chat,
        stream: "acp:0",
        seqFrom: 0,
        seqTo: 0,
        format: "acp",
        kind: "snapshot",
        payload: '["secret frame"]',
      }),
      command: await ctx.db.insert("acp_commands", {
        workspace,
        worker: dead.worker,
        chat,
        kind: "prompt",
        payload: { kind: "prompt", prompt: [{ type: "text", text: "secret prompt" }] },
        clientId: "c1",
        by: "owner",
        status: "pending",
      }),
      interaction: await ctx.db.insert("acp_interactions", {
        chat,
        workspace,
        worker: dead.worker,
        requestKey: "k1",
        kind: "permission",
        request: permission,
        status: "pending",
        createdAt: 1,
      }),
    }));
    await owner.mutation(api.workers.revoke, { workspace, workerId: dead.worker });
    const sessionRecord = (
      await t.query(internal.e2ee_legacy_relay.staleRelayBlockers, {
        table: "acp_sessions",
        status: "all",
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rows[0]!.record;

    await startCutover(t);
    const abandoned = await t.mutation(internal.e2ee_legacy_relay.abandonRelayRows, {
      rows: [
        { table: "acp_commands", record: ids.command },
        { table: "acp_interactions", record: ids.interaction },
        { table: "acp_sessions", record: sessionRecord },
      ],
      dryRun: false,
    });
    expect(abandoned.results.map((row) => row.outcome)).toEqual(["abandoned", "abandoned", "abandoned"]);

    // Far past every retention window, a viewer opens the chat, and the sweeps run: still frozen.
    vi.setSystemTime(Date.now() + ACP_COLD_AFTER_MS + ACP_INTERACTION_RETENTION_MS);
    await t.mutation(internal.acp.prune, {});
    await t.mutation(internal.acp.coolSessions, {});
    expect(await owner.mutation(api.chatroom.Watch, { chat, tab: "tab" })).toEqual({ warm: false });
    const rows = await t.run(async (ctx) => ({
      session: await ctx.db.query("acp_sessions").first(),
      stream: await ctx.db.get("acp_streams", ids.stream),
      frame: await ctx.db.get("chat_frames", ids.frame),
      command: await ctx.db.get("acp_commands", ids.command),
      interaction: await ctx.db.get("acp_interactions", ids.interaction),
      viewers: await ctx.db.query("chat_viewers").collect(),
    }));
    expect(rows.session).toMatchObject({ status: "failed", warm: false, cooledEpoch: 0 });
    expect(rows.stream).not.toBeNull();
    expect(rows.frame?.payload).toBe('["secret frame"]');
    expect(rows.command).toMatchObject({ status: "failed", error: "ACP_ABANDONED" });
    expect(rows.command?.payload).toBeDefined();
    expect(rows.interaction).toMatchObject({ status: "cancelled", request: permission });
    expect(rows.viewers).toEqual([]);

    // Nothing blocks and every abandoned byte is still there for the seal.
    const sealed = await runJobs(t, "seal", RELAY_TABLES);
    for (const table of RELAY_TABLES)
      expect(sealed[table], table).toMatchObject({ status: "completed", blocked: 0, conflicts: 0 });
    const after = await t.run(async (ctx) => ({
      frame: await ctx.db.get("chat_frames", ids.frame),
      command: await ctx.db.get("acp_commands", ids.command),
      interaction: await ctx.db.get("acp_interactions", ids.interaction),
    }));
    for (const [name, row] of Object.entries(after))
      expect(row?.legacyContent?.kind, name).toBe("custody");
    expect(after.frame?.payload).toBe("");
    expect(after.command).toMatchObject({ status: "failed", error: "ACP_ABANDONED" });
  });

  test("a Worker reports only fixed worker codes; backend-only codes are refused as free text after cutover", async () => {
    const f = await fixture();
    const { t, workspace } = f;
    const worker = await f.enroll("worker");
    const { chat } = await insertChat(t, workspace, worker.worker);
    const claimed = async (clientId: string) =>
      await t.run((ctx) =>
        ctx.db.insert("acp_commands", {
          workspace,
          worker: worker.worker,
          chat,
          kind: "prompt",
          clientId,
          by: "owner",
          status: "claimed",
          claimedAt: 1,
        }),
      );
    const failed = await claimed("failed");
    const cancelled = await claimed("cancelled");
    const abandoned = await claimed("abandoned");

    await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
    await t.run(async (ctx) => {
      const state = await ctx.db.query("e2ee_migration_state").first();
      await ctx.db.patch("e2ee_migration_state", state!._id, {
        frozen: false,
        cutoverComplete: true,
        generation: state!.generation + 1,
      });
    });
    await worker.machine.mutation(api.acp.finishCommand, {
      command: failed,
      status: "failed",
      error: "ACP_FAILED",
    });
    for (const [command, error] of [
      [cancelled, "ACP_CANCELLED"],
      [abandoned, "ACP_ABANDONED"],
    ] as const)
      await expect(
        worker.machine.mutation(api.acp.finishCommand, { command, status: "failed", error }),
        error,
      ).rejects.toThrow("ACP_PLAINTEXT_REFUSED");
    expect(await t.run((ctx) => ctx.db.get("acp_commands", failed))).toMatchObject({
      status: "failed",
      error: "ACP_FAILED",
    });
    expect(await t.run((ctx) => ctx.db.get("acp_commands", cancelled))).toMatchObject({ status: "claimed" });
  });
});
