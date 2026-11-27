import { and, eq } from "drizzle-orm";
import {
  acpAgentDefinitionStatement,
  acpAnswerStatement,
  CAPSULE_BYTES,
  chatKeyBindingStatement,
  chatKeyStatement,
  sign,
  toBase64Url,
} from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACP_AGENT_DEFINITIONS_MAX,
  ACP_WARM_SESSIONS_MAX,
  type AcpAgentDefinition,
} from "contracts/acp/contract";
import {
  acpChat,
  acpUsers,
  acpWorkspace,
  agentReport,
  bindingSignature,
  identityKey,
  keyId,
  sealed,
  seeds,
  sessionOf,
  signedCommand,
  userCaller,
  type Role,
  type Users,
} from "../../test/acp";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { claimedCommand } from "../../test/usage";
import { insertWorker, machineCaller, workerIssuerEnv } from "../../test/workers";
import { chats } from "../chatroom/schema";
import { notifications } from "../notifications/schema";
import { acpUsage } from "../usage/schema";
import { workers } from "../worker/schema";
import { projectFolders, projects } from "../workspaces/schema";
import { normalizeRegistryAgents, REGISTRY_URL } from "./agents";
import { insertSignedCommand, signedCommandInput } from "./policy";
import { pruneAcpCommands, pruneAcpInteractions, expireAcpCommands } from "./retention";
import { acpAgentSessions, acpAgents, acpCommands, acpInteractions, acpSessions } from "./schema";
import { admitWarm, isWarm, warmChats } from "./warm";

// The ACP slice through the real routers: the chat access rule on every chat procedure (owner,
// member, outsider, archived, personal-chat privacy), owner-only workspace procedures, the Worker
// machine boundary (revoked, another workspace's Worker), behavior ported from Convex
// `acp.test.ts` and `acp_e2ee.test.ts` (signed path only: every ACP workspace is keyed after the
// cutover), the slice 3 gaps (scope change with a re-signed binding, deletion with the signed
// close/delete command), retention, and the invariants that relied on Convex serializing mutations.

let test: TestRuntime;
let users: Users;
let fixture: Awaited<ReturnType<typeof acpWorkspace>>;

const db = () => test.runtime.drivers.db;
const kv = () => test.runtime.drivers.kv;
const call = (role: Role) => userCaller(test, users[role].headers);
const notFound = { code: "NOT_FOUND" };
const refused = (message: string) => expect.objectContaining({ message });

beforeAll(async () => {
  test = await createTestRuntime({ env: (await workerIssuerEnv()).env });
  users = await acpUsers(test.runtime, "acp");
  fixture = await acpWorkspace(test.runtime, users);
  await fixture.machine.worker.acp.reportAgents({ agents: [agentReport()] });
  await fixture.machine.worker.reportPresence({ tempDirectory: "/tmp/radium" });
});

afterAll(async () => {
  await test?.close();
});

const chat = (creator: Role, options: Parameters<typeof acpChat>[4] = {}) =>
  acpChat(test.runtime, users, fixture, creator, options);
const command = (role: Role, kind: string, chatId: string, clientId: string) =>
  signedCommand(role, {
    workspace: fixture.workspace,
    worker: fixture.worker.workerId,
    chat: chatId,
    kind,
    clientId,
  });
let clientIds = 0;
const nextClientId = () => `client-${++clientIds}`;

/** A chat key setup as a browser sends it at creation (unsigned epoch one, identity wraps). */
function keysSetup(e2eeId: string, recipients: Role[]) {
  return {
    e2eeId,
    epoch: { epoch: 1, keyId: keyId(201), suite: 1, publicKey: toBase64Url(new Uint8Array(1216).fill(9)) },
    wraps: recipients.map((role) => ({
      chatEpoch: 1,
      recipient: "identity" as const,
      userId: users[role].id,
      recipientKeyId: identityKey[role],
      sealed: toBase64Url(new Uint8Array(1200).fill(1)),
    })),
  };
}
let e2eeIds = 400;
const nextE2eeId = () => keyId(++e2eeIds % 250);

/** Puts a session in `status` directly (what the Worker's lifecycle patches would do). */
async function setStatus(chatId: string, status: "idle" | "running" | "awaiting" | "starting") {
  await db().update(acpSessions).set({ status }).where(eq(acpSessions.chat, chatId));
}

async function prompted(role: Role, chatId: string) {
  const clientId = nextClientId();
  return await call(role).acp.prompt({
    chat: chatId,
    clientId,
    signed: await command(role, "prompt", chatId, clientId),
  });
}

describe("boundaries", () => {
  it("owner-only procedures refuse members, outsiders and archived workspaces", async () => {
    const archived = await acpWorkspace(test.runtime, users, { archived: true });
    const signed = await command("owner", "logout", "", "boundary");
    const procedures = (role: Role, workspace: string) => [
      call(role).acp.listAgents({ workspace }),
      call(role).acp.listAgentDefinitions({ workspace }),
      call(role).acp.saveAgentDefinition({
        workspace,
        definition: { agentId: "x", name: "x", command: "x", args: [], env: [], enabled: true, source: "custom" },
      }),
      call(role).acp.deleteAgentDefinition({ workspace, id: "x" }),
      call(role).acp.registryAgents({ workspace }),
      call(role).acp.createSession({
        workspace,
        worker: fixture.worker.workerId,
        agentId: "test-agent",
        e2ee: { keys: keysSetup(nextE2eeId(), [role]) },
      }),
      call(role).acp.openAgentSession({
        workspace,
        worker: fixture.worker.workerId,
        agentId: "test-agent",
        sessionId: "s",
        e2ee: { keys: keysSetup(nextE2eeId(), [role]) },
      }),
      call(role).acp.listAgentSessionIndex({ workspace, agentId: "test-agent" }),
      call(role).acp.listUnopenedAgentSessions({ workspace }),
      call(role).acp.syncAgentSessions({ workspace, agentId: "test-agent", signed: [] }),
      call(role).acp.authenticate({
        workspace,
        worker: fixture.worker.workerId,
        agentId: "test-agent",
        methodId: "browser",
        clientId: signed.clientId,
        signed,
      }),
      call(role).acp.logout({
        workspace,
        worker: fixture.worker.workerId,
        agentId: "test-agent",
        clientId: signed.clientId,
        signed,
      }),
    ];
    let fetched = false;
    test.runtime.fetch = (async () => {
      fetched = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    for (const [role, workspace] of [
      ["member", fixture.workspace],
      ["outsider", fixture.workspace],
      ["owner", archived.workspace],
    ] as const) {
      for (const result of await Promise.allSettled(procedures(role, workspace))) {
        expect(result).toMatchObject({ status: "rejected", reason: notFound });
      }
    }
    expect(fetched).toBe(false);
  });

  it("chat procedures follow the access rule: personal ACP chats stay private, even from the owner", async () => {
    const personal = await chat("member", { status: "running" });
    const [interaction] = await db()
      .insert(acpInteractions)
      .values({
        workspace: fixture.workspace,
        chat: personal.chat,
        worker: fixture.worker.workerId,
        requestKey: "boundary",
        kind: "permission",
        sealedRequestEpoch: 1,
        sealedRequestBox: new Uint8Array(CAPSULE_BYTES + 64),
        sealedRequestSignature: new Uint8Array(64),
      })
      .returning();
    const answer = {
      answer: sealed(),
      signature: toBase64Url(new Uint8Array(64)),
      signerKeyId: identityKey.owner,
    };
    const signed = await command("owner", "prompt", personal.chat, "privacy");
    const procedures = (role: Role) => [
      call(role).acp.getSession({ chat: personal.chat }),
      call(role).acp.workerStatus({ chat: personal.chat }),
      call(role).acp.openInteractions({ chat: personal.chat }),
      call(role).acp.prompt({ chat: personal.chat, clientId: "privacy", signed }),
      call(role).acp.cancel({ chat: personal.chat, signed }),
      call(role).acp.setConfig({ chat: personal.chat, signed }),
      call(role).acp.setMode({ chat: personal.chat, signed }),
      call(role).acp.requestHistory({ chat: personal.chat, epoch: 0, before: 0, signed }),
      call(role).acp.fork({ chat: personal.chat, e2ee: { keys: keysSetup(nextE2eeId(), [role]) } }),
      call(role).acp.startFork({
        chat: personal.chat,
        target: personal.chat,
        binding: { version: 1, scope: "personal", members: [], signerKeyId: identityKey[role], signature: toBase64Url(new Uint8Array(64)) },
        signed,
      }),
      call(role).acp.setFallbackTitle({ chat: personal.chat, sealedTitle: { epoch: 1, box: sealed() } }),
      call(role).acp.generateTitle({ chat: personal.chat, text: "hello" }),
      call(role).acp.publishBinding({
        chat: personal.chat,
        binding: { version: 2, scope: "personal", members: [], signerKeyId: identityKey[role], signature: toBase64Url(new Uint8Array(64)) },
      }),
      call(role).acp.answer({ interaction: interaction!.id, sealed: answer }),
      call(role).chats.delete({ chatId: personal.chat }),
      call(role).chats.setScope({ chatId: personal.chat, scope: "workspace" }),
    ];
    for (const role of ["owner", "other", "outsider"] as const) {
      for (const result of await Promise.allSettled(procedures(role))) {
        expect(result).toMatchObject({ status: "rejected", reason: notFound });
      }
    }
    expect(await call("member").acp.getSession({ chat: personal.chat })).toMatchObject({
      status: "running",
      signed: true,
    });
    // A member of a shared chat and every user of a workspace chat may use it.
    const shared = await chat("owner", { scope: "shared", members: ["member"] });
    await call("member").acp.getSession({ chat: shared.chat });
    await expect(call("other").acp.getSession({ chat: shared.chat })).rejects.toMatchObject(notFound);
    const everyone = await chat("member", { scope: "workspace" });
    await call("other").acp.workerStatus({ chat: everyone.chat });

    // Archived workspaces hide their chats from their creators too.
    const archived = await acpWorkspace(test.runtime, users, { archived: true });
    const old = await acpChat(test.runtime, users, archived, "owner");
    await expect(call("owner").acp.getSession({ chat: old.chat })).rejects.toMatchObject(notFound);
  });

  it("machine procedures refuse a revoked Worker and fence another workspace's Worker", async () => {
    const own = await chat("owner", { status: "running" });
    const queued = await prompted("owner", (await chat("owner")).chat);
    const [interaction] = await db()
      .insert(acpInteractions)
      .values({
        workspace: fixture.workspace,
        chat: own.chat,
        worker: fixture.worker.workerId,
        requestKey: "fence",
        kind: "permission",
        sealedRequestEpoch: 1,
        sealedRequestBox: new Uint8Array(CAPSULE_BYTES + 64),
        sealedRequestSignature: new Uint8Array(64),
      })
      .returning();
    const foreign = await acpWorkspace(test.runtime, users);
    const denied = { code: "FORBIDDEN", message: "ACP_DENIED" };
    const machine = foreign.machine.worker.acp;
    for (const attempt of [
      () => machine.claimCommand({ command: queued }),
      () => machine.finishCommand({ command: queued, status: "done" }),
      () => machine.updateSession({ chat: own.chat, patch: { status: "idle" } }),
      () => machine.chatKey({ chat: own.chat }),
      () => machine.resolveInteraction({ interaction: interaction!.id, status: "resolved" }),
      () => machine.reopenInteraction({ interaction: interaction!.id }),
      () => machine.openInteraction({
        chat: own.chat,
        requestKey: "foreign",
        sealed: { kind: "permission", epoch: 1, box: sealed(), signature: toBase64Url(new Uint8Array(64)) },
      }),
      () => machine.startEpoch({
        chat: own.chat,
        epoch: 1,
        capsule: { chatEpoch: 1, capsule: sealed(CAPSULE_BYTES), signature: toBase64Url(new Uint8Array(64)) },
      }),
    ]) {
      await expect(attempt()).rejects.toMatchObject(denied);
    }
    expect(await machine.assignedCommands()).toEqual([]);
    expect(await machine.agentDefinitions()).toEqual([]);
    expect((await sessionOf(test.runtime, own.chat)).status).toBe("running");

    // Revocation applies to a token that is still within its lifetime.
    const revoked = await insertWorker(test.runtime, fixture.workspace);
    const caller = await machineCaller(test.runtime, revoked);
    await caller.worker.acp.assignedCommands();
    await db().update(workers).set({ status: "revoked" }).where(eq(workers.id, revoked.workerId));
    const attempts = await Promise.allSettled([
      caller.worker.acp.assignedCommands(),
      caller.worker.acp.agentDefinitions(),
      caller.worker.acp.recoverWorker(),
      caller.worker.acp.reportAgents({ agents: [] }),
    ]);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ status: "rejected", reason: { code: "UNAUTHORIZED" } });
    }
    // A browser session is not a Worker.
    await expect(
      userCaller(test, users.owner.headers).worker.acp.assignedCommands(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("agent definitions", () => {
  type Definition = Omit<AcpAgentDefinition, "authorization">;
  const definition: Definition = {
    agentId: "defined",
    name: "Zebra",
    command: "test-acp",
    args: ["serve"],
    env: [],
    enabled: true,
    source: "custom",
  };
  /** The owner's executable authorization over `value`, as the browser signs it. */
  async function authorized(value: Definition, issuedAt: number, workspace = fixture.workspace) {
    const signature = await sign(
      seeds.owner,
      acpAgentDefinitionStatement({ workspaceId: workspace, issuedAt, definition: value }),
    );
    return {
      ...value,
      authorization: { issuedAt, signerKeyId: identityKey.owner, signature: toBase64Url(signature) },
    };
  }

  it("keyed workspaces need fresh owner authorization over the executable", async () => {
    const workspace = fixture.workspace;
    await expect(
      call("owner").acp.saveAgentDefinition({ workspace, definition }),
    ).rejects.toMatchObject(refused("ACP_AGENT_AUTHORIZATION_REQUIRED"));
    const issuedAt = Date.now();
    const approved = await authorized(definition, issuedAt);
    const id = await call("owner").acp.saveAgentDefinition({ workspace, definition: approved });
    // The old signature does not cover a changed command; the same authorization cannot repeat.
    await expect(
      call("owner").acp.saveAgentDefinition({
        workspace,
        id,
        definition: { ...approved, command: "other", args: ["attack"] },
      }),
    ).rejects.toMatchObject(refused("ACP_AGENT_AUTHORIZATION_REQUIRED"));
    await expect(
      call("owner").acp.saveAgentDefinition({ workspace, id, definition: approved }),
    ).rejects.toMatchObject(refused("ACP_STALE_AGENT_AUTHORIZATION"));
    // A signature by the member's key is not the owner's.
    const forged = await authorized(definition, issuedAt + 5);
    await expect(
      call("owner").acp.saveAgentDefinition({
        workspace,
        id,
        definition: { ...forged, authorization: { ...forged.authorization, signerKeyId: identityKey.member } },
      }),
    ).rejects.toMatchObject(refused("ACP_AGENT_AUTHORIZATION_REQUIRED"));
    const disabled = await authorized({ ...definition, enabled: false }, issuedAt + 1);
    await call("owner").acp.saveAgentDefinition({ workspace, id, definition: disabled });
    expect(await fixture.machine.worker.acp.agentDefinitions()).toContainEqual(disabled);
  });

  it("owners create, sort, update and delete; ids are immutable, unsafe env refused", async () => {
    const workspace = fixture.workspace;
    const now = Date.now();
    const alpha = await call("owner").acp.saveAgentDefinition({
      workspace,
      definition: await authorized({ ...definition, agentId: "alpha", name: "Alpha" }, now),
    });
    await expect(
      call("owner").acp.saveAgentDefinition({
        workspace,
        definition: await authorized({ ...definition, agentId: "alpha", name: "Again" }, now + 1),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "This agent ID already exists." });
    await expect(
      call("owner").acp.saveAgentDefinition({
        workspace,
        id: alpha,
        definition: await authorized({ ...definition, agentId: "changed", name: "Alpha" }, now + 2),
      }),
    ).rejects.toMatchObject({ message: "Agent IDs cannot be changed." });
    for (const invalid of [
      { ...definition, agentId: "bad id" },
      { ...definition, agentId: "pathy", env: [{ name: "PATH", value: "/tmp/bin" }] },
    ]) {
      await expect(
        call("owner").acp.saveAgentDefinition({ workspace, definition: await authorized(invalid, now + 3) }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    const rows = await call("owner").acp.listAgentDefinitions({ workspace });
    expect(rows.map((row) => row.name)).toEqual(["Alpha", "Zebra"]);
    expect(rows[0]).not.toHaveProperty("workspace");
    await call("owner").acp.deleteAgentDefinition({ workspace, id: alpha });
    await expect(
      call("owner").acp.deleteAgentDefinition({ workspace, id: alpha }),
    ).rejects.toMatchObject(notFound);
    // Another workspace's definition id is unknown here.
    const other = await acpWorkspace(test.runtime, users);
    await expect(
      call("owner").acp.deleteAgentDefinition({ workspace: other.workspace, id: rows[1]!.id }),
    ).rejects.toMatchObject(notFound);
    expect(await other.machine.worker.acp.agentDefinitions()).toEqual([]);
  });

  it("capacity is per workspace and updates still work at capacity", async () => {
    const other = await acpWorkspace(test.runtime, users);
    const ids = [];
    for (let index = 0; index < ACP_AGENT_DEFINITIONS_MAX; index++) {
      const [row] = await db()
        .insert(acpAgents)
        .values({
          workspace: other.workspace,
          agentId: `agent-${index}`,
          name: "Agent",
          command: "agent",
          args: [],
          env: [],
          enabled: true,
          source: "custom",
          updatedAt: new Date(),
        })
        .returning();
      ids.push(row!.id);
    }
    const now = Date.now();
    await expect(
      call("owner").acp.saveAgentDefinition({
        workspace: other.workspace,
        definition: await authorized(definition, now, other.workspace),
      }),
    ).rejects.toMatchObject(refused(`A workspace supports at most ${ACP_AGENT_DEFINITIONS_MAX} agents.`));
    await call("owner").acp.saveAgentDefinition({
      workspace: other.workspace,
      id: ids[0],
      definition: await authorized({ ...definition, agentId: "agent-0", name: "Updated" }, now, other.workspace),
    });
    expect(await other.machine.worker.acp.agentDefinitions()).toHaveLength(ACP_AGENT_DEFINITIONS_MAX);
  });

  it("registry: normalizes npx, uvx and PATH hints, fetches on demand, refuses over 1 MiB", async () => {
    const registry = {
      version: "1",
      agents: [
        {
          id: "npm-agent",
          name: "Npm agent",
          version: "1.2.3",
          distribution: { npx: { package: "@example/agent@1.2.3", args: ["--acp"], env: { MODE: "code" } } },
        },
        { id: "python-agent", name: "Python agent", version: "2", distribution: { uvx: { package: "agent==2", args: ["acp"] } } },
        {
          id: "binary-agent",
          name: "Binary agent",
          version: "3",
          distribution: {
            binary: {
              "windows-x86_64": { cmd: "bin\\\\agent.exe", args: ["acp"] },
              "linux-x86_64": { cmd: "./bin/agent", args: ["acp"] },
            },
          },
        },
        { id: "bad id", name: "Invalid", version: "1", distribution: { npx: { package: "bad@1" } } },
        { id: "bad-env", name: "Invalid", version: "1", distribution: { npx: { package: "bad", env: { PATH: "/tmp" } } } },
        { id: "bad-package", name: "Invalid", version: "1", distribution: { npx: { package: "--eval=bad" } } },
        null,
      ],
    };
    const normalized = normalizeRegistryAgents(registry);
    expect(normalized).toEqual([
      {
        id: "npm-agent",
        name: "Npm agent",
        version: "1.2.3",
        launch: { command: "npx", args: ["-y", "@example/agent@1.2.3", "--acp"], env: [{ name: "MODE", value: "code" }] },
      },
      { id: "python-agent", name: "Python agent", version: "2", launch: { command: "uvx", args: ["agent==2", "acp"], env: [] } },
      { id: "binary-agent", name: "Binary agent", version: "3", pathCommand: { command: "agent", args: ["acp"] } },
    ]);
    expect(normalizeRegistryAgents(null)).toEqual([]);

    const requested: string[] = [];
    test.runtime.fetch = (async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify(registry));
    }) as unknown as typeof fetch;
    expect(await call("owner").acp.registryAgents({ workspace: fixture.workspace })).toEqual(normalized);
    expect(requested).toEqual([REGISTRY_URL]);

    let cancelled = false;
    test.runtime.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as unknown as typeof fetch;
    await expect(
      call("owner").acp.registryAgents({ workspace: fixture.workspace }),
    ).rejects.toMatchObject(refused("ACP registry exceeds the 1 MiB limit."));
    expect(cancelled).toBe(true);
  });
});

describe("sessions", () => {
  it("creation needs a certified Worker and a ready agent, and derives Project or temp directories", async () => {
    const workspace = fixture.workspace;
    const create = (extra: Record<string, unknown> = {}) =>
      call("owner").acp.createSession({
        workspace,
        worker: fixture.worker.workerId,
        agentId: "test-agent",
        e2ee: { keys: keysSetup(nextE2eeId(), ["owner"]) },
        ...extra,
      });
    const uncertified = await insertWorker(test.runtime, workspace);
    await expect(create({ worker: uncertified.workerId })).rejects.toMatchObject(refused("WORKER_NOT_PAIRED"));
    await expect(create({ agentId: "missing" })).rejects.toMatchObject(refused("ACP_AGENT_UNAVAILABLE"));
    await expect(create({ profile: "gateway" })).rejects.toMatchObject(
      refused("This agent does not offer a Gateway profile."),
    );

    // Without a Project folder the session runs in the Worker's reported temp directory.
    const temp = await create();
    expect(await sessionOf(test.runtime, temp)).toMatchObject({
      cwd: "/tmp/radium",
      status: "idle",
      binding: null,
    });
    const [row] = await db().select().from(chats).where(eq(chats.id, temp));
    expect(row).toMatchObject({ userId: users.owner.id, scope: "personal", keyEpoch: 1 });

    const [project] = await db().insert(projects).values({ workspace, userId: users.owner.id, name: "P" }).returning();
    await db().insert(projectFolders).values({
      project: project!.id,
      workspace,
      worker: fixture.worker.workerId,
      directory: "/srv/app",
      position: 0,
    });
    const filed = await create({ project: project!.id });
    expect((await sessionOf(test.runtime, filed)).cwd).toBe("/srv/app");
    await expect(create({ cwd: "relative/path" })).rejects.toMatchObject(refused("ACP_INVALID_CWD"));

    // The creator publishes the binding before any command; only the next version, signed.
    const [created] = await db().select().from(chats).where(eq(chats.id, temp));
    const binding = (version: number, signer: Role = "owner") =>
      bindingSignature(signer, users, {
        workspace,
        chat: temp,
        e2eeId: created!.e2eeId!,
        worker: fixture.worker.workerId,
        cwd: "/tmp/radium",
        scope: "personal",
        members: [],
        version,
      });
    await expect(
      call("owner").acp.publishBinding({ chat: temp, binding: await binding(2) }),
    ).rejects.toMatchObject(refused("ACP_INVALID_BINDING"));
    await expect(
      call("owner").acp.publishBinding({
        chat: temp,
        binding: { ...(await binding(1, "member")), signerKeyId: identityKey.owner },
      }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SIGNATURE"));
    await call("owner").acp.publishBinding({ chat: temp, binding: await binding(1) });
    expect((await sessionOf(test.runtime, temp)).binding?.version).toBe(1);
  });

  it("a workspace chat's binding is published by its creator only", async () => {
    const shared = await chat("owner", { scope: "workspace", bound: false });
    const binding = await bindingSignature("owner", users, {
      workspace: fixture.workspace,
      chat: shared.chat,
      e2eeId: shared.e2eeId,
      worker: fixture.worker.workerId,
      scope: "workspace",
      members: [],
      version: 1,
    });
    await expect(
      call("member").acp.publishBinding({ chat: shared.chat, binding }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "ACP_DENIED" });
  });

  it("prompts are sealed, signer-verified, busy-aware and retry-idempotent; claim erases them", async () => {
    const unbound = await chat("owner", { bound: false });
    await expect(prompted("owner", unbound.chat)).rejects.toMatchObject(refused("ACP_BINDING_REQUIRED"));

    const { chat: chatId } = await chat("owner", { scope: "shared", members: ["member"] });
    // Signed by the member's key but submitted by the owner: the issuer must be the signer.
    await expect(
      call("owner").acp.prompt({
        chat: chatId,
        clientId: "forged",
        signed: await command("member", "prompt", chatId, "forged"),
      }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SIGNATURE"));
    // A signature over another kind cannot be replayed as a prompt.
    await expect(
      call("owner").acp.prompt({
        chat: chatId,
        clientId: "replayed",
        signed: await command("owner", "cancel", chatId, "replayed"),
      }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SIGNATURE"));

    const signed = await command("member", "prompt", chatId, "prompt-1");
    const first = await call("member").acp.prompt({ chat: chatId, clientId: "prompt-1", signed });
    expect(await call("member").acp.prompt({ chat: chatId, clientId: "prompt-1", signed })).toBe(first);
    // The same client id belongs to the member: another user cannot reach that command.
    await expect(
      call("owner").acp.prompt({
        chat: chatId,
        clientId: "prompt-1",
        signed: await command("owner", "prompt", chatId, "prompt-1"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(prompted("owner", chatId)).rejects.toMatchObject(refused("ACP_SESSION_BUSY"));
    expect(await sessionOf(test.runtime, chatId)).toMatchObject({
      status: "starting",
      turnBy: users.member.id,
    });
    expect(await isWarm(kv(), fixture.worker.workerId, chatId)).toBe(true);

    const [row] = await db().select().from(acpCommands).where(eq(acpCommands.id, first));
    expect(row).toMatchObject({ kind: "prompt", payload: null, issuedBy: users.member.id });
    expect(row!.signedPayload).toBeInstanceOf(Uint8Array);

    const machine = fixture.machine.worker.acp;
    expect(await machine.assignedCommands()).toContainEqual(
      expect.objectContaining({ id: first, kind: "prompt", chat: chatId }),
    );
    const claim = await machine.claimCommand({ command: first });
    expect(claim).toMatchObject({
      payload: null,
      clientId: "prompt-1",
      by: users.member.id,
      signed: { payload: signed.payload, signerKeyId: identityKey.member },
      session: { warm: true, e2ee: { binding: { version: 1 } } },
    });
    expect(await machine.claimCommand({ command: first })).toBeNull();
    const [erased] = await db().select().from(acpCommands).where(eq(acpCommands.id, first));
    expect(erased).toMatchObject({ status: "claimed", signedPayload: null, signedSignature: null });

    // A paired Worker reports only fixed codes.
    await expect(
      machine.finishCommand({ command: first, status: "failed", error: "stack trace with secrets" }),
    ).rejects.toMatchObject(refused("ACP_PLAINTEXT_REFUSED"));
    await machine.finishCommand({ command: first, status: "failed", error: "ACP_FORBIDDEN" });
    await machine.finishCommand({ command: first, status: "failed", error: "ACP_FORBIDDEN" });
    await expect(machine.finishCommand({ command: first, status: "done" })).rejects.toMatchObject(
      refused("ACP_COMMAND_CLOSED"),
    );
    expect(await call("member").acp.getCommand({ command: first })).toMatchObject({
      status: "failed",
      error: "ACP_FORBIDDEN",
    });
    expect(await call("owner").acp.getCommand({ command: first })).toBeNull();
  });

  it("cancel fails an unclaimed prompt locally, else queues one signed cancel", async () => {
    const { chat: chatId } = await chat("owner");
    const queued = await prompted("owner", chatId);
    await call("owner").acp.cancel({ chat: chatId });
    expect((await db().select().from(acpCommands).where(eq(acpCommands.id, queued)))[0]).toMatchObject({
      status: "failed",
      error: "ACP_CANCELLED",
      signedPayload: null,
    });
    expect(await sessionOf(test.runtime, chatId)).toMatchObject({ status: "idle", stopReason: "cancelled" });
    expect((await db().select().from(chats).where(eq(chats.id, chatId)))[0]!.interruption).toEqual({
      kind: "interrupted",
    });

    const running = await prompted("owner", chatId);
    await fixture.machine.worker.acp.claimCommand({ command: running });
    await expect(call("owner").acp.cancel({ chat: chatId })).rejects.toMatchObject(
      refused("ACP_SIGNATURE_REQUIRED"),
    );
    const cancel = async () =>
      call("owner").acp.cancel({ chat: chatId, signed: await command("owner", "cancel", chatId, nextClientId()) });
    await cancel();
    await cancel();
    const cancels = await db()
      .select()
      .from(acpCommands)
      .where(and(eq(acpCommands.chat, chatId), eq(acpCommands.kind, "cancel")));
    expect(cancels).toHaveLength(1);
  });

  it("config, mode and history requests travel only as signed commands; history pages dedupe", async () => {
    const { chat: chatId } = await chat("owner", { sessionId: "agent-session" });
    await call("owner").acp.setConfig({
      chat: chatId,
      signed: await command("owner", "set_config", chatId, nextClientId()),
    });
    await call("owner").acp.setMode({
      chat: chatId,
      signed: await command("owner", "set_mode", chatId, nextClientId()),
    });
    await expect(
      call("owner").acp.setMode({ chat: chatId, signed: await command("owner", "set_config", chatId, nextClientId()) }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SIGNATURE"));

    // Pages are served only for the warm epoch, and a duplicate shares the unfinished command.
    const page = `history:${chatId}:0:10`;
    const history = async (suffix: string) =>
      call("owner").acp.requestHistory({
        chat: chatId,
        epoch: 0,
        before: 10,
        signed: await command("owner", "history", chatId, `${page}:${suffix}`),
      });
    await history("cold");
    const kinds = async () =>
      (await db().select({ kind: acpCommands.kind }).from(acpCommands).where(eq(acpCommands.chat, chatId))).map(
        (row) => row.kind,
      );
    expect(await kinds()).toEqual(["set_config", "set_mode"]);
    await admitWarm(kv(), fixture.worker.workerId, chatId);
    await history("a");
    await history("b");
    expect((await kinds()).filter((kind) => kind === "history")).toHaveLength(1);
    await expect(
      call("owner").acp.requestHistory({
        chat: chatId,
        epoch: 0,
        before: 10,
        signed: await command("owner", "history", chatId, "history:other:0:10:x"),
      }),
    ).rejects.toMatchObject(refused("ACP_INVALID_CLIENT_ID"));
  });

  it("interactions open sealed, the answer's signer must be its submitter, and reopen/resolve resume", async () => {
    const { chat: chatId } = await chat("owner", {
      scope: "shared",
      members: ["member"],
      status: "running",
      turnBy: "member",
    });
    const machine = fixture.machine.worker.acp;
    const request = {
      chat: chatId,
      requestKey: "request-1",
      sealed: { kind: "permission" as const, epoch: 1, box: sealed(), signature: toBase64Url(new Uint8Array(64)) },
    };
    const interaction = await machine.openInteraction(request);
    expect(await machine.openInteraction(request)).toBe(interaction);
    expect((await sessionOf(test.runtime, chatId)).status).toBe("awaiting");
    expect(
      await db()
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, users.member.id), eq(notifications.chat, chatId))),
    ).toMatchObject([{ kind: "session_approval" }]);
    await expect(
      machine.openInteraction({ ...request, requestKey: "stale", sealed: { ...request.sealed, epoch: 2 } }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SEALED"));

    const [open] = await call("member").acp.openInteractions({ chat: chatId });
    expect(open).toMatchObject({ id: interaction, request: null, sealed: { epoch: 1 }, status: "pending" });

    const answer = sealed();
    const statement = acpAnswerStatement({
      workspaceId: fixture.workspace,
      workerId: fixture.worker.workerId,
      chatId,
      requestKey: "request-1",
      answer: Buffer.from(answer, "base64url"),
    });
    const ownerSigned = {
      answer,
      signature: toBase64Url(await sign(seeds.owner, statement)),
      signerKeyId: identityKey.owner,
    };
    await expect(
      call("member").acp.answer({ interaction, sealed: ownerSigned }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SIGNATURE"));
    await call("owner").acp.answer({ interaction, sealed: ownerSigned });
    await expect(call("owner").acp.answer({ interaction, sealed: ownerSigned })).rejects.toMatchObject(
      refused("ACP_INTERACTION_CLOSED"),
    );
    expect(await machine.answeredInteractions()).toContainEqual(
      expect.objectContaining({ id: interaction, sealed: { ...ownerSigned } }),
    );

    // The Worker rejected the answer: open again, without it.
    await machine.reopenInteraction({ interaction });
    const [reopened] = await db().select().from(acpInteractions).where(eq(acpInteractions.id, interaction));
    expect(reopened).toMatchObject({ status: "pending", sealedAnswer: null, answeredBy: null });
    await machine.resolveInteraction({ interaction, status: "resolved" });
    await machine.resolveInteraction({ interaction, status: "resolved" });
    expect((await sessionOf(test.runtime, chatId)).status).toBe("running");
  });

  it("lifecycle writes the session id once with a proof, seals titles and errors, records the turn once", async () => {
    const other = await chat("owner");
    await fixture.machine.worker.acp.updateSession({
      chat: other.chat,
      patch: { sessionId: "taken", sessionProof: toBase64Url(new Uint8Array(64)) },
    });
    const { chat: chatId } = await chat("member", { status: "running", turnBy: "member" });
    const machine = fixture.machine.worker.acp;
    const proof = toBase64Url(new Uint8Array(64).fill(7));
    await expect(
      machine.updateSession({ chat: chatId, patch: { sessionId: "agent-1" } }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SESSION_ID"));
    await expect(
      machine.updateSession({ chat: chatId, patch: { sessionId: "taken", sessionProof: proof } }),
    ).rejects.toMatchObject(refused("ACP_SESSION_BOUND"));
    await machine.updateSession({
      chat: chatId,
      patch: {
        sessionId: "agent-1",
        sessionProof: proof,
        sealedTitle: { epoch: 1, box: sealed() },
        indexTitle: { epoch: 1, box: sealed(), tag: "tag-1" },
      },
    });
    await expect(
      machine.updateSession({ chat: chatId, patch: { sessionId: "agent-2", sessionProof: proof } }),
    ).rejects.toMatchObject(refused("ACP_SESSION_BOUND"));
    expect(await sessionOf(test.runtime, chatId)).toMatchObject({
      sessionId: "agent-1",
      sessionProof: { kind: "worker", signature: proof },
    });
    const [row] = await db().select().from(chats).where(eq(chats.id, chatId));
    expect(row!.sealedTitleEpoch).toBe(1);
    const [indexed] = await db()
      .select()
      .from(acpAgentSessions)
      .where(eq(acpAgentSessions.sessionId, "agent-1"));
    expect(indexed).toMatchObject({ chat: chatId, titleTag: "tag-1", title: null });

    // A user rename wins over later agent titles.
    await db().update(acpSessions).set({ userTitled: true }).where(eq(acpSessions.chat, chatId));
    const before = row!.sealedTitleBox;
    await machine.updateSession({ chat: chatId, patch: { sealedTitle: { epoch: 1, box: sealed() } } });
    expect((await db().select().from(chats).where(eq(chats.id, chatId)))[0]!.sealedTitleBox).toEqual(before);
    await expect(
      machine.updateSession({ chat: chatId, patch: { sealedError: { epoch: 2, box: sealed() } } }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SEALED"));

    const prompt = await claimedCommand(test.runtime, {
      workspace: fixture.workspace,
      worker: fixture.worker.workerId,
      chat: chatId,
      issuedBy: users.member.id,
    });
    const end = {
      chat: chatId,
      patch: {
        status: "failed" as const,
        sealedError: { epoch: 1, box: sealed() },
        turn: { command: prompt, startedAt: Date.now() - 1000 },
        turnUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    };
    await machine.updateSession(end);
    await machine.updateSession(end);
    expect(await sessionOf(test.runtime, chatId)).toMatchObject({
      status: "failed",
      error: "The agent reported an error",
      sealedErrorEpoch: 1,
    });
    expect(await db().select().from(acpUsage).where(eq(acpUsage.chat, chatId))).toHaveLength(1);
    expect(
      await db()
        .select({ kind: notifications.kind })
        .from(notifications)
        .where(and(eq(notifications.userId, users.member.id), eq(notifications.chat, chatId))),
    ).toEqual([{ kind: "session_failed" }]);
    expect((await db().select().from(chats).where(eq(chats.id, chatId)))[0]!.interruption).toEqual({
      kind: "failed",
    });
    expect(await call("member").acp.getSession({ chat: chatId })).toMatchObject({
      status: "failed",
      sealedError: { epoch: 1 },
      binding: { version: 1, scope: "personal", members: [] },
      turnUsage: { totalTokens: 3 },
    });
  });

  it("epochs only advance on warm sessions, past the cooled fence; retries of the current one pass", async () => {
    const { chat: chatId } = await chat("owner");
    const machine = fixture.machine.worker.acp;
    const capsule = { chatEpoch: 1, capsule: sealed(CAPSULE_BYTES), signature: toBase64Url(new Uint8Array(64)) };
    const start = (epoch: number) => machine.startEpoch({ chat: chatId, epoch, capsule });
    expect(await start(1)).toEqual({ accepted: false });
    await admitWarm(kv(), fixture.worker.workerId, chatId);
    expect(await start(1)).toEqual({ accepted: true });
    expect(await start(1)).toEqual({ accepted: true });
    await expect(start(0)).rejects.toMatchObject(refused("ACP_STALE_EPOCH"));
    expect(await start(3)).toEqual({ accepted: true });
    await expect(start(2)).rejects.toMatchObject(refused("ACP_STALE_EPOCH"));
    // Cooling cleared epoch 3: its retry must open a newer one.
    await db().update(acpSessions).set({ cooledEpoch: 3 }).where(eq(acpSessions.chat, chatId));
    await expect(start(3)).rejects.toMatchObject(refused("ACP_STALE_EPOCH"));
    expect(await start(4)).toEqual({ accepted: true });
    await expect(
      machine.startEpoch({ chat: chatId, epoch: 5, capsule: { ...capsule, chatEpoch: 2 } }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SEALED"));
    expect((await sessionOf(test.runtime, chatId)).epoch).toBe(4);
    expect(await machine.warmSessions()).toContainEqual(
      expect.objectContaining({ chat: chatId, epoch: 4, e2ee: expect.objectContaining({ keyEpoch: 1 }) }),
    );
    expect(await machine.chatKey({ chat: chatId })).toMatchObject({ epoch: 1, rekey: false });
  });

  it("recovery fails claimed turns and open interactions but keeps unclaimed prompts", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    await workspace.machine.worker.acp.reportAgents({ agents: [agentReport()] });
    const make = (options: Parameters<typeof acpChat>[4]) => acpChat(test.runtime, users, workspace, "owner", options);
    const starting = await make({ status: "starting" });
    const running = await make({ status: "running" });
    const waiting = await make({});
    const claimed = await claimedCommand(test.runtime, {
      workspace: workspace.workspace,
      worker: workspace.worker.workerId,
      chat: starting.chat,
      issuedBy: users.owner.id,
    });
    const clientId = nextClientId();
    const pending = await userCaller(test, users.owner.headers).acp.prompt({
      chat: waiting.chat,
      clientId,
      signed: await signedCommand("owner", {
        workspace: workspace.workspace,
        worker: workspace.worker.workerId,
        chat: waiting.chat,
        kind: "prompt",
        clientId,
      }),
    });
    const [interaction] = await db()
      .insert(acpInteractions)
      .values({
        workspace: workspace.workspace,
        chat: running.chat,
        worker: workspace.worker.workerId,
        requestKey: "recover",
        kind: "permission",
        sealedRequestEpoch: 1,
        sealedRequestBox: new Uint8Array(CAPSULE_BYTES + 64),
        sealedRequestSignature: new Uint8Array(64),
      })
      .returning();
    expect(await workspace.machine.worker.acp.recoverWorker()).toEqual({ more: false });
    const status = async (id: string) =>
      (await db().select().from(acpCommands).where(eq(acpCommands.id, id)))[0]!;
    expect(await status(claimed)).toMatchObject({ status: "failed", error: "ACP_FAILED" });
    expect(await status(pending)).toMatchObject({ status: "pending" });
    expect((await sessionOf(test.runtime, starting.chat)).status).toBe("failed");
    expect((await sessionOf(test.runtime, running.chat)).status).toBe("failed");
    expect((await sessionOf(test.runtime, waiting.chat)).status).toBe("starting");
    expect((await db().select().from(acpInteractions).where(eq(acpInteractions.id, interaction!.id)))[0]).toMatchObject({
      status: "cancelled",
    });
  });

  it("the warm cap refuses a prompt past 64 warm sessions per Worker", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    for (let index = 0; index < ACP_WARM_SESSIONS_MAX; index++) {
      await admitWarm(kv(), workspace.worker.workerId, `chat-${index}`);
    }
    const cold = await acpChat(test.runtime, users, workspace, "owner");
    const clientId = nextClientId();
    await expect(
      call("owner").acp.prompt({
        chat: cold.chat,
        clientId,
        signed: await signedCommand("owner", {
          workspace: workspace.workspace,
          worker: workspace.worker.workerId,
          chat: cold.chat,
          kind: "prompt",
          clientId,
        }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("64 open agent Sessions") });
    expect((await sessionOf(test.runtime, cold.chat)).status).toBe("idle");
  });
});

describe("agent session index", () => {
  it("machine sync applies diffs and finish state; owners page the index without other members' personal chats", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const machine = workspace.machine.worker.acp;
    await machine.reportAgents({ agents: [agentReport()] });
    await expect(
      machine.syncAgentSessions({ agentId: "missing", upserts: [], removals: [] }),
    ).rejects.toMatchObject(refused("ACP_AGENT_UNAVAILABLE"));
    await machine.syncAgentSessions({ agentId: "test-agent", upserts: [], removals: [], start: true });
    const entry = (sessionId: string, cwd: string, updatedAt: number) => ({
      sessionId,
      cwd,
      sealedTitle: { epoch: 1, box: sealed() },
      titleTag: `tag-${sessionId}`,
      updatedAt,
    });
    await machine.syncAgentSessions({
      agentId: "test-agent",
      upserts: [entry("s1", "/srv/app", 1000), entry("s2", "/srv/app/", 2000), entry("s3", "/elsewhere", 3000), entry("gone", "/x", 10)],
      removals: [],
    });
    await expect(
      machine.syncAgentSessions({ agentId: "test-agent", upserts: [], removals: [], finish: { error: "/home/user path" } }),
    ).rejects.toMatchObject(refused("ACP_INVALID_AGENT_SESSIONS"));
    await machine.syncAgentSessions({
      agentId: "test-agent",
      upserts: [],
      removals: ["gone"],
      finish: { count: 3, truncated: false },
    });
    expect((await machine.knownAgentSessions({ agentId: "test-agent" })).map((row) => row.sessionId).sort()).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    const [agent] = (await call("owner").acp.listAgents({ workspace: workspace.workspace })) ?? [];
    expect(agent?.sessionsSync).toMatchObject({ status: "done", count: 3 });

    // s3 is linked to the member's personal chat: hidden from the owner's index.
    const personal = await acpChat(test.runtime, users, workspace, "member");
    await db()
      .update(acpAgentSessions)
      .set({ chat: personal.chat })
      .where(eq(acpAgentSessions.sessionId, "s3"));
    const index = await call("owner").acp.listAgentSessionIndex({ workspace: workspace.workspace, agentId: "test-agent" });
    expect(index.page.map((row) => row.sessionId)).toEqual(["s2", "s1"]);
    const first = await call("owner").acp.listAgentSessionIndex({
      workspace: workspace.workspace,
      agentId: "test-agent",
      limit: 1,
    });
    expect(first.page.map((row) => row.sessionId)).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
  });

  it("Home lists unopened sessions by Project folder (either spelling) until opened; opening links once", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const machine = workspace.machine.worker.acp;
    await machine.reportAgents({ agents: [agentReport()] });
    const now = Date.now();
    await db().insert(acpAgents).values({
      workspace: workspace.workspace,
      agentId: "test-agent",
      name: "Test",
      command: "agent",
      args: [],
      env: [],
      enabled: true,
      source: "custom",
      updatedAt: new Date(),
    });
    await machine.syncAgentSessions({
      agentId: "test-agent",
      upserts: [
        { sessionId: "in-1", cwd: "/srv/app", updatedAt: now - 3000 },
        { sessionId: "in-2", cwd: "/srv/app/", updatedAt: now - 2000 },
        { sessionId: "out", cwd: "/tmp/other", updatedAt: now - 1000 },
      ],
      removals: [],
    });
    const [project] = await db()
      .insert(projects)
      .values({ workspace: workspace.workspace, userId: users.owner.id, name: "P" })
      .returning();
    await db().insert(projectFolders).values({
      project: project!.id,
      workspace: workspace.workspace,
      worker: workspace.worker.workerId,
      directory: "/srv/app",
      position: 0,
    });
    const list = async (filter: { project?: string | null }) =>
      (await call("owner").acp.listUnopenedAgentSessions({ workspace: workspace.workspace, ...filter })).page.map(
        (row) => row.sessionId,
      );
    expect(await list({})).toEqual(["out", "in-2", "in-1"]);
    expect(await list({ project: project!.id })).toEqual(["in-2", "in-1"]);
    expect(await list({ project: null })).toEqual(["out"]);

    const open = (sessionId: string) =>
      call("owner").acp.openAgentSession({
        workspace: workspace.workspace,
        worker: workspace.worker.workerId,
        agentId: "test-agent",
        sessionId,
        e2ee: { keys: keysSetup(nextE2eeId(), ["owner"]), sealedTitle: { epoch: 1, box: sealed() } },
      });
    const opened = await open("in-1");
    expect(await open("in-1")).toBe(opened);
    expect(await sessionOf(test.runtime, opened)).toMatchObject({ sessionId: "in-1", cwd: "/srv/app" });
    expect((await db().select().from(chats).where(eq(chats.id, opened)))[0]).toMatchObject({
      project: project!.id,
      sealedTitleEpoch: 1,
    });
    expect(await list({ project: project!.id })).toEqual(["in-2"]);
    await expect(open("unknown")).rejects.toMatchObject(refused("ACP_SESSION_NOT_FOUND"));
    // A session another chat already bound cannot be opened twice.
    await acpChat(test.runtime, users, workspace, "owner", { sessionId: "out" });
    await expect(open("out")).rejects.toMatchObject(refused("ACP_SESSION_BOUND"));
  });

  it("browser sync is online-only, certified-only and debounces queued syncs", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const machine = workspace.machine.worker;
    await machine.acp.reportAgents({ agents: [agentReport()] });
    const sync = async () =>
      call("owner").acp.syncAgentSessions({
        workspace: workspace.workspace,
        agentId: "test-agent",
        signed: [
          {
            worker: workspace.worker.workerId,
            ...(await signedCommand("owner", {
              workspace: workspace.workspace,
              worker: workspace.worker.workerId,
              chat: "",
              kind: "sync_sessions",
              clientId: nextClientId(),
            })),
          },
        ],
      });
    const queued = async () =>
      db()
        .select()
        .from(acpCommands)
        .where(and(eq(acpCommands.worker, workspace.worker.workerId), eq(acpCommands.kind, "sync_sessions")));
    await sync();
    expect(await queued()).toHaveLength(0);
    await machine.reportPresence({ tempDirectory: "/tmp/w" });
    await sync();
    await sync();
    expect(await queued()).toMatchObject([{ agentId: "test-agent", status: "pending", chat: null }]);
  });
});

describe("slice 3 gaps", () => {
  /** A creator-signed chat key epoch bound to the chat's next audience, in wire form. */
  async function boundEpoch(chatId: string, e2eeId: string, epoch: number, scope: "personal" | "shared" | "workspace", members: string[]) {
    const id = keyId(220 + epoch);
    const publicKey = new Uint8Array(1216).fill(epoch);
    const statement = { workspaceId: fixture.workspace, chatE2eeId: e2eeId, epoch, keyId: id, suite: 1, publicKey };
    return {
      epoch,
      keyId: id,
      suite: 1,
      publicKey: toBase64Url(publicKey),
      signerKeyId: identityKey.owner,
      signature: toBase64Url(await sign(seeds.owner, chatKeyStatement(statement))),
      bindingSignature: toBase64Url(
        await sign(
          seeds.owner,
          chatKeyBindingStatement({ ...statement, chatId, scope, creatorId: users.owner.id, members: [...members].sort() }),
        ),
      ),
      ...(scope === "shared" ? { bindingMembers: [...members].sort() } : {}),
    };
  }
  const identityWrap = (role: Role, chatEpoch: number) => ({
    chatEpoch,
    recipient: "identity" as const,
    userId: users[role].id,
    recipientKeyId: identityKey[role],
    sealed: toBase64Url(new Uint8Array(1200).fill(chatEpoch)),
  });

  it("a bound ACP chat changes scope only with the creator's next binding for the new audience", async () => {
    const { chat: chatId, e2eeId } = await chat("owner");
    // Its key epoch one predates binding: sign it so the rotation below is a valid successor.
    const members = [users.member.id];
    const setScope = async (acpBinding?: Awaited<ReturnType<typeof bindingSignature>>) =>
      call("owner").chats.setScope({
        chatId,
        scope: "shared",
        members,
        keys: {
          rotate: await boundEpoch(chatId, e2eeId, 2, "shared", members),
          wraps: [identityWrap("member", 1), identityWrap("owner", 2), identityWrap("member", 2)],
        },
        ...(acpBinding ? { acpBinding } : {}),
      });
    const next = (overrides: { version?: number; members?: string[]; scope?: "personal" | "shared" } = {}) =>
      bindingSignature("owner", users, {
        workspace: fixture.workspace,
        chat: chatId,
        e2eeId,
        worker: fixture.worker.workerId,
        scope: overrides.scope ?? "shared",
        members: overrides.members ?? members,
        version: overrides.version ?? 2,
      });
    await expect(setScope()).rejects.toMatchObject(refused("ACP_BINDING_REQUIRED"));
    for (const bad of [{ version: 3 }, { members: [] }, { scope: "personal" as const }]) {
      await expect(setScope(await next(bad))).rejects.toMatchObject(refused("ACP_INVALID_BINDING"));
    }
    expect((await sessionOf(test.runtime, chatId)).binding?.version).toBe(1);
    await setScope(await next());
    expect((await sessionOf(test.runtime, chatId)).binding).toMatchObject({
      version: 2,
      scope: "shared",
      members,
    });
    expect(await call("member").acp.getSession({ chat: chatId })).toMatchObject({
      binding: { version: 2, scope: "shared" },
    });
    // A chat without a published binding takes none.
    const unbound = await chat("owner", { bound: false });
    await expect(
      call("owner").chats.setScope({
        chatId: unbound.chat,
        scope: "personal",
        acpBinding: await next(),
      }),
    ).rejects.toMatchObject(refused("ACP_INVALID_BINDING"));
  });

  it("deleting an ACP chat queues the signed close/delete command with the binding snapshot", async () => {
    const workspaceChat = await chat("owner", { scope: "workspace", sessionId: "to-close" });
    await admitWarm(kv(), fixture.worker.workerId, workspaceChat.chat);
    // Everyone who can see an ACP chat may delete it.
    const closing = await command("member", "close", workspaceChat.chat, nextClientId());
    await expect(
      call("member").chats.delete({
        chatId: workspaceChat.chat,
        acpCommand: { ...closing, clientId: nextClientId() },
      }),
    ).rejects.toMatchObject(refused("ACP_INVALID_SIGNATURE"));
    await call("member").chats.delete({ chatId: workspaceChat.chat, acpCommand: closing });
    const [close] = await db().select().from(acpCommands).where(eq(acpCommands.clientId, closing.clientId));
    expect(close).toMatchObject({
      kind: "close",
      chat: null,
      issuedBy: users.member.id,
      agentId: "test-agent",
      target: {
        chat: workspaceChat.chat,
        e2eeId: workspaceChat.e2eeId,
        creatorUserId: users.owner.id,
        sessionId: "to-close",
        binding: { version: 1 },
        sessionProof: { kind: "worker" },
      },
    });
    expect(await db().select().from(chats).where(eq(chats.id, workspaceChat.chat))).toEqual([]);
    expect(await db().select().from(acpSessions).where(eq(acpSessions.chat, workspaceChat.chat))).toEqual([]);
    expect(await isWarm(kv(), fixture.worker.workerId, workspaceChat.chat)).toBe(false);
    // The Worker can still claim the close after the chat is gone.
    const claim = await fixture.machine.worker.acp.claimCommand({ command: close!.id });
    expect(claim).toMatchObject({ kind: "close", chat: null, session: null, target: { sessionId: "to-close" } });

    // `deleteInAgent` with an agent that supports it is a `delete`, and drops the index entry.
    const indexed = await chat("owner", { sessionId: "to-delete" });
    await db().insert(acpAgentSessions).values({
      workspace: fixture.workspace,
      worker: fixture.worker.workerId,
      agentId: "test-agent",
      sessionId: "to-delete",
      cwd: "/work",
      updatedAt: new Date(),
      chat: indexed.chat,
    });
    const deleting = await command("owner", "delete", indexed.chat, nextClientId());
    await call("owner").chats.delete({ chatId: indexed.chat, deleteInAgent: true, acpCommand: deleting });
    expect((await db().select().from(acpCommands).where(eq(acpCommands.clientId, deleting.clientId)))[0]?.kind).toBe(
      "delete",
    );
    expect(await db().select().from(acpAgentSessions).where(eq(acpAgentSessions.sessionId, "to-delete"))).toEqual([]);

    // Without a signed command (or a session id) the chat is deleted and nothing is queued.
    const quiet = await chat("owner");
    await call("owner").chats.delete({ chatId: quiet.chat });
    expect(await db().select().from(acpCommands).where(eq(acpCommands.workspace, fixture.workspace))).not.toContainEqual(
      expect.objectContaining({ target: expect.objectContaining({ chat: quiet.chat }) }),
    );
  });
});

describe("retention", () => {
  it("prunes finished receipts and resolved interactions, and expires abandoned intent", async () => {
    const workspace = await acpWorkspace(test.runtime, users);
    const starting = await acpChat(test.runtime, users, workspace, "owner", { status: "starting" });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const insert = (values: Partial<typeof acpCommands.$inferInsert>) =>
      db()
        .insert(acpCommands)
        .values({
          workspace: workspace.workspace,
          worker: workspace.worker.workerId,
          kind: "sync_sessions",
          agentId: "test-agent",
          clientId: crypto.randomUUID(),
          issuedBy: users.owner.id,
          payload: { kind: "sync_sessions", agentId: "test-agent" },
          ...values,
        })
        .returning({ id: acpCommands.id });
    const [finished] = await insert({ status: "done", payload: null, finishedAt: old });
    const [fresh] = await insert({ status: "done", payload: null, finishedAt: new Date() });
    const [abandoned] = await insert({ createdAt: old, kind: "prompt", chat: starting.chat, agentId: null, payload: { kind: "prompt", prompt: [] } });
    const [recent] = await insert({});
    const [resolved] = await db()
      .insert(acpInteractions)
      .values({
        workspace: workspace.workspace,
        chat: starting.chat,
        worker: workspace.worker.workerId,
        requestKey: "old",
        kind: "permission",
        status: "resolved",
        resolvedAt: old,
      })
      .returning();
    const now = Date.now();
    expect(await pruneAcpCommands(db(), now, 500)).toBeGreaterThanOrEqual(1);
    expect(await expireAcpCommands(db(), now, 500)).toBeGreaterThanOrEqual(1);
    expect(await pruneAcpInteractions(db(), now, 500)).toBeGreaterThanOrEqual(1);
    const left = new Set(
      (await db().select({ id: acpCommands.id }).from(acpCommands).where(eq(acpCommands.worker, workspace.worker.workerId))).map(
        (row) => row.id,
      ),
    );
    expect(left.has(finished!.id) || left.has(abandoned!.id)).toBe(false);
    expect(left.has(fresh!.id) && left.has(recent!.id)).toBe(true);
    expect(await db().select().from(acpInteractions).where(eq(acpInteractions.id, resolved!.id))).toEqual([]);
    expect((await sessionOf(test.runtime, starting.chat)).status).toBe("failed");
  });
});

describe("invariants", () => {
  it("command dedupe: concurrent inserts of one signed command make one row; another issuer is refused", async () => {
    const { chat: chatId } = await chat("owner");
    const signed = signedCommandInput.parse(await command("owner", "set_mode", chatId, "dedupe"));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        db().transaction((tx) =>
          insertSignedCommand(tx, {
            workspace: fixture.workspace,
            worker: fixture.worker.workerId,
            issuedBy: users.owner.id,
            kind: "set_mode",
            signed,
            chat: chatId,
          }),
        ),
      ),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const ids = new Set(results.map((result) => (result as PromiseFulfilledResult<string>).value));
    expect(ids.size).toBe(1);
    await expect(
      db().transaction((tx) =>
        insertSignedCommand(tx, {
          workspace: fixture.workspace,
          worker: fixture.worker.workerId,
          issuedBy: users.member.id,
          kind: "set_mode",
          signed,
          chat: chatId,
        }),
      ),
    ).rejects.toMatchObject({ message: "ACP_DENIED" });
  });

  it("claim once: of concurrent claims exactly one gets the payload", async () => {
    const { chat: chatId } = await chat("owner");
    const queued = await prompted("owner", chatId);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => fixture.machine.worker.acp.claimCommand({ command: queued })),
    );
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });

  it("one turn per chat: of concurrent prompts with distinct client ids exactly one is admitted", async () => {
    const { chat: chatId } = await chat("owner");
    const signed = await Promise.all(
      Array.from({ length: 8 }, (_, index) => command("owner", "prompt", chatId, `race-${chatId}-${index}`)),
    );
    const results = await Promise.allSettled(
      signed.map((value) => call("owner").acp.prompt({ chat: chatId, clientId: value.clientId, signed: value })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject(refused("ACP_SESSION_BUSY"));
    }
    expect(
      await db().select().from(acpCommands).where(and(eq(acpCommands.chat, chatId), eq(acpCommands.kind, "prompt"))),
    ).toHaveLength(1);
  });

  it("epoch fencing: concurrent starts never move the epoch backwards", async () => {
    const capsule = { chatEpoch: 1, capsule: sealed(CAPSULE_BYTES), signature: toBase64Url(new Uint8Array(64)) };
    for (let round = 0; round < 5; round++) {
      const { chat: chatId } = await chat("owner");
      await admitWarm(kv(), fixture.worker.workerId, chatId);
      await Promise.allSettled(
        Array.from({ length: 10 }, (_, index) =>
          fixture.machine.worker.acp.startEpoch({ chat: chatId, epoch: 10 - index, capsule }),
        ),
      );
      expect((await sessionOf(test.runtime, chatId)).epoch).toBe(10);
    }
  });

  it("warm cap: concurrent warmings past the cap admit exactly the free slots", async () => {
    const worker = `cap-${crypto.randomUUID()}`;
    for (let index = 0; index < ACP_WARM_SESSIONS_MAX - 3; index++) {
      await admitWarm(kv(), worker, `warm-${index}`);
    }
    const admitted = await Promise.all(
      Array.from({ length: 10 }, (_, index) => admitWarm(kv(), worker, `new-${index}`)),
    );
    expect(admitted.filter(Boolean)).toHaveLength(3);
    expect(await warmChats(kv(), worker)).toHaveLength(ACP_WARM_SESSIONS_MAX);
  });

  it("first answer wins: of concurrent answers exactly one is stored", async () => {
    const { chat: chatId } = await chat("owner", { scope: "workspace", status: "running" });
    const interaction = await fixture.machine.worker.acp.openInteraction({
      chat: chatId,
      requestKey: "race",
      sealed: { kind: "permission", epoch: 1, box: sealed(), signature: toBase64Url(new Uint8Array(64)) },
    });
    const answer = async (role: Role) => {
      const box = sealed();
      const signature = await sign(
        seeds[role],
        acpAnswerStatement({
          workspaceId: fixture.workspace,
          workerId: fixture.worker.workerId,
          chatId,
          requestKey: "race",
          answer: Buffer.from(box, "base64url"),
        }),
      );
      return call(role).acp.answer({
        interaction,
        sealed: { answer: box, signature: toBase64Url(signature), signerKeyId: identityKey[role] },
      });
    };
    const roles = ["owner", "member", "other", "owner", "member", "other"] as const;
    const results = await Promise.allSettled(roles.map((role) => answer(role)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [row] = await db().select().from(acpInteractions).where(eq(acpInteractions.id, interaction));
    const winner = roles[results.findIndex((result) => result.status === "fulfilled")]!;
    expect(row).toMatchObject({ status: "answered", answeredBy: users[winner].id });
  });
});

