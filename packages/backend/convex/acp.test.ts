/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { register } from "worker-component/test";
import { api, components, internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";
import {
  ACP_COLD_AFTER_MS,
  ACP_COMMAND_RETENTION_MS,
  ACP_COMMAND_EXPIRY_MS,
  ACP_INTERACTION_RETENTION_MS,
  acpAnswerError,
  type AcpAgentReport,
  type AcpInteractionRequest,
} from "../src/acp/contract";
import { normalizeRegistryAgents } from "../src/acp/agents";
import { ACP_AGENT_DEFINITIONS_MAX, type AcpAgentDefinition } from "../src/acp/contract";

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
      modes: { currentModeId: "code", available: [{ id: "code", name: "Code" }] },
    },
  },
};
const permission: AcpInteractionRequest = {
  kind: "permission",
  toolCallId: "read-1",
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};
const prompt = [{ type: "text" as const, text: "Hello" }];
const frame = { seqFrom: 0, seqTo: 1, kind: "snapshot" as const, payload: "[]" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.invalid");
  const t = convexTest(schema, modules);
  register(t);
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "ACP" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" }),
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
    const machine = t.withIdentity({
      ...identity,
      subject: identity.workerId,
      kind: "worker",
      issuer: workerIssuer("https://backend.example.invalid"),
    });
    await machine.mutation(api.acp.reportAgents, { agents: [agent] });
    return { identity, machine };
  }
  const first = await enroll("first");
  const second = await enroll("second");
  const owner = t.withIdentity({ subject: "owner" });
  const member = t.withIdentity({ subject: "member" });
  const chat = await owner.mutation(api.acp.CreateSession, {
    workspace,
    worker: first.identity.workerId,
    agentId: agent.agentId,
    cwd: "/work",
  });
  return { t, workspace, first, second, owner, member, chat };
}

test("visible ACP Worker status includes identity and the latest machine heartbeat", async () => {
  const f = await fixture();
  expect(await f.owner.query(api.acp.WorkerStatus, { chat: f.chat })).toEqual({
    name: "first",
    lastSeenAt: null,
  });
  const before = Date.now();
  await f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/acp" });
  const status = await f.owner.query(api.acp.WorkerStatus, { chat: f.chat });
  expect(status.name).toBe("first");
  expect(status.lastSeenAt).toBeGreaterThanOrEqual(before);
  expect(status.lastSeenAt).toBeLessThanOrEqual(Date.now());

  await expect(f.member.query(api.acp.WorkerStatus, { chat: f.chat })).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.patch(f.chat, { scope: "workspace" }));
  expect(await f.member.query(api.acp.WorkerStatus, { chat: f.chat })).toEqual(status);
});

test("revoked or unknown ACP Workers have no display name", async () => {
  const f = await fixture();
  await f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/acp" });
  await f.owner.mutation(api.workers.revoke, {
    workspace: f.workspace,
    workerId: f.first.identity.workerId,
  });
  expect(await f.owner.query(api.acp.WorkerStatus, { chat: f.chat })).toEqual({
    name: null,
    lastSeenAt: null,
  });
  await f.t.run(async (ctx) => {
    const session = await ctx.db
      .query("acp_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", f.chat))
      .unique();
    await ctx.db.patch(session!._id, { worker: "unknown-worker" });
  });
  expect(await f.owner.query(api.acp.WorkerStatus, { chat: f.chat })).toEqual({
    name: null,
    lastSeenAt: null,
  });
});

test("chat listings use agent definition names, fall back to IDs and mark built-in chats null", async () => {
  const f = await fixture();
  const builtin = await f.owner.mutation(api.aisdk.CreateChat, {
    workspace: f.workspace,
    messages_queue: { text: "", files: [], model: "test-model", webSearch: false },
  });
  const chats = await f.owner.query(api.aisdk.ListChats, { workspace: f.workspace });
  expect(chats.find((chat) => chat.id === f.chat)?.agent).toEqual({
    agentId: agent.agentId,
    name: agent.agentId,
    worker: f.first.identity.workerId,
  });
  expect(chats.find((chat) => chat.id === builtin)?.agent).toBeNull();
  const id = await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace,
    definition: { ...definition, agentId: agent.agentId, name: "Workspace agent name" },
  });
  const renamed = await f.owner.query(api.aisdk.ListChats, { workspace: f.workspace });
  expect(renamed.find((chat) => chat.id === f.chat)?.agent).toEqual({
    agentId: agent.agentId,
    name: "Workspace agent name",
    worker: f.first.identity.workerId,
  });
  await f.owner.mutation(api.acp.DeleteAgentDefinition, { workspace: f.workspace, id });
  const removed = await f.owner.query(api.aisdk.ListChats, { workspace: f.workspace });
  expect(removed.find((chat) => chat.id === f.chat)?.agent?.name).toBe(agent.agentId);
  expect((await f.owner.query(api.acp.GetSession, { chat: f.chat })).agent.agentId).toBe(
    agent.agentId,
  );
});

test("ACP title generation authorizes viewers and skips titled or user-titled chats", async () => {
  const f = await fixture();
  await f.t.run((ctx) => ctx.db.patch(f.chat, { title: "Agent title", emoji: "💡" }));
  await expect(
    f.owner.action(api.acp.GenerateTitle, { chat: f.chat, text: "  A first prompt  " }),
  ).resolves.toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get(f.chat))).toMatchObject({
    title: "Agent title",
    emoji: "💡",
  });
  await expect(
    f.member.action(api.acp.GenerateTitle, { chat: f.chat, text: "Private prompt" }),
  ).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.patch(f.chat, { scope: "workspace" }));
  await expect(
    f.member.action(api.acp.GenerateTitle, { chat: f.chat, text: "Shared prompt" }),
  ).resolves.toBeNull();

  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.chat, { title: undefined });
    const session = await ctx.db
      .query("acp_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", f.chat))
      .unique();
    await ctx.db.patch(session!._id, { userTitled: true });
  });
  expect(
    await f.owner.query(internal.chatroom.acpTitleGenerationInfo, { chatId: f.chat }),
  ).toBeNull();
  await expect(
    f.owner.action(api.acp.GenerateTitle, { chat: f.chat, text: "Do not retitle" }),
  ).resolves.toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get(f.chat))).not.toHaveProperty("title");

  const builtin = await f.owner.mutation(api.aisdk.CreateChat, {
    workspace: f.workspace,
    messages_queue: { text: "", files: [], model: "test-model", webSearch: false },
  });
  await expect(
    f.owner.action(api.acp.GenerateTitle, { chat: builtin, text: "Not an ACP chat" }),
  ).rejects.toThrow(/ACP_NOT_ACP/);
});

test("opening an indexed agent session creates and links a personal chat while offline", async () => {
  const f = await fixture();
  const worker = f.first.identity.workerId;
  const project = await f.owner.mutation(api.projects.create, {
    workspace: f.workspace,
    name: "Code",
    folders: [{ workerId: worker, directory: "/work" }],
  });
  await f.first.machine.mutation(api.acp.syncAgentSessions, {
    agentId: agent.agentId,
    upserts: [
      { sessionId: "outside-session", cwd: "/work", title: "Earlier work", updatedAt: 1234 },
    ],
    removals: [],
    finish: { count: 1, truncated: false },
  });
  const binding = {
    workspace: f.workspace,
    worker,
    agentId: agent.agentId,
    sessionId: "outside-session",
  };
  const chat = await f.owner.mutation(api.acp.OpenAgentSession, binding);
  expect(await f.t.run((ctx) => ctx.db.get(chat))).toMatchObject({
    title: "Earlier work",
    lastInteractionAt: 1234,
    project,
    scope: "personal",
    agent: { sessionId: "outside-session", cwd: "/work" },
  });
  const rows = await f.owner.query(api.acp.ListAgentSessionIndex, {
    workspace: f.workspace,
    agentId: agent.agentId,
    paginationOpts: { cursor: null, numItems: 30 },
  });
  expect(rows.page).toMatchObject([{ chat, project, sessionId: "outside-session" }]);
  expect(
    await f.owner.query(api.acp.SearchAgentSessionIndex, {
      workspace: f.workspace,
      agentId: agent.agentId,
      query: "Earlier",
    }),
  ).toMatchObject([{ chat, project, sessionId: "outside-session" }]);
  expect(await f.owner.mutation(api.acp.OpenAgentSession, binding)).toBe(chat);
  await f.first.machine.mutation(api.acp.updateSession, {
    chat,
    patch: { sessionId: "outside-session", history: "full" },
  });
  await expect(
    f.first.machine.mutation(api.acp.updateSession, {
      chat,
      patch: { sessionId: "other" },
    }),
  ).rejects.toThrow(/ACP_SESSION_BOUND/);
  await expect(f.member.mutation(api.acp.OpenAgentSession, binding)).rejects.toThrow();
  await expect(
    f.member.query(api.acp.ListAgentSessionIndex, {
      workspace: f.workspace,
      agentId: agent.agentId,
      paginationOpts: { cursor: null, numItems: 30 },
    }),
  ).rejects.toThrow();
});

test("opening a stale linked index recreates its chat, but never duplicates an existing binding", async () => {
  const f = await fixture();
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { sessionId: "bound" },
  });
  const binding = {
    workspace: f.workspace,
    worker: f.first.identity.workerId,
    agentId: agent.agentId,
    sessionId: "bound",
  };
  expect(await f.owner.mutation(api.acp.OpenAgentSession, binding)).toBe(f.chat);
  const indexed = await f.t.run((ctx) => ctx.db.query("acp_agent_sessions").first());
  await f.t.run((ctx) => ctx.db.patch(indexed!._id, { chat: undefined }));
  await expect(f.owner.mutation(api.acp.OpenAgentSession, binding)).rejects.toThrow(
    /ACP_SESSION_BOUND/,
  );
  await f.t.run(async (ctx) => {
    await ctx.db.patch(indexed!._id, { chat: f.chat });
    await ctx.db.delete(f.chat);
    const session = await ctx.db
      .query("acp_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", f.chat))
      .first();
    await ctx.db.delete(session!._id);
  });
  expect(await f.owner.mutation(api.acp.OpenAgentSession, binding)).not.toBe(f.chat);
});

test("new sessions always create fresh bindings and derive Project or temporary directories", async () => {
  const f = await fixture();
  const worker = f.first.identity.workerId;
  await f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/agent" });
  const project = await f.owner.mutation(api.projects.create, {
    workspace: f.workspace,
    name: "Code",
    folders: [{ workerId: worker, directory: "/projects/code" }],
  });
  const noFolder = await f.owner.mutation(api.projects.create, {
    workspace: f.workspace,
    name: "No folder",
  });
  for (const target of [
    { project: undefined, cwd: undefined, expected: "/tmp/agent" },
    { project, cwd: undefined, expected: "/projects/code" },
    { project: noFolder, cwd: undefined, expected: "/tmp/agent" },
    { project, cwd: "/explicit", expected: "/explicit" },
  ]) {
    const args = {
      workspace: f.workspace,
      worker,
      agentId: agent.agentId,
      project: target.project,
      cwd: target.cwd,
    };
    const first = await f.owner.mutation(api.acp.CreateSession, args);
    const second = await f.owner.mutation(api.acp.CreateSession, args);
    expect(second).not.toBe(first);
    const chat = await f.t.run((ctx) => ctx.db.get(first));
    expect(chat?.agent?.cwd).toBe(target.expected);
    expect(chat?.agent).not.toHaveProperty("sessionId");
  }
  await expect(
    f.owner.mutation(api.acp.CreateSession, {
      workspace: f.workspace,
      worker,
      agentId: agent.agentId,
      cwd: "relative",
    }),
  ).rejects.toThrow("ACP_INVALID_CWD");
});

test("prompt admission is busy-aware, ended-aware and retry-idempotent; claim erases content", async () => {
  const f = await fixture();
  const command = await f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "one" });
  expect(await f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "one" })).toBe(
    command,
  );
  await expect(
    f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "two" }),
  ).rejects.toThrow("ACP_SESSION_BUSY");
  expect(await f.first.machine.query(api.acp.assignedCommands, {})).toMatchObject([
    { _id: command, kind: "prompt", chat: f.chat },
  ]);
  const claimed = await f.first.machine.mutation(api.acp.claimCommand, { command });
  expect(claimed?.payload).toEqual({ kind: "prompt", prompt });
  expect(await f.t.run((ctx) => ctx.db.get(command))).not.toHaveProperty("payload");
  expect(await f.first.machine.mutation(api.acp.claimCommand, { command })).toBeNull();
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { status: "ended" },
  });
  await expect(
    f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "three" }),
  ).rejects.toThrow("ACP_SESSION_ENDED");
});

test("personal chats stay private from workspace owners for prompt, watch, frames and answers", async () => {
  const f = await fixture();
  await f.t.run((ctx) => ctx.db.patch(f.chat, { userId: "member" }));
  await f.member.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "member" });
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { status: "running" },
  });
  const interaction = await f.first.machine.mutation(api.acp.openInteraction, {
    chat: f.chat,
    requestKey: "permission",
    request: permission,
  });
  await expect(
    f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "owner" }),
  ).rejects.toThrow();
  await expect(
    f.owner.mutation(api.chatroom.Watch, { chat: f.chat, tab: "owner" }),
  ).rejects.toThrow();
  await expect(
    f.owner.query(api.chatroom.LiveFrames, { chat: f.chat, stream: "acp:1", fromSeq: 0 }),
  ).rejects.toThrow();
  await expect(
    f.owner.mutation(api.acp.Answer, {
      interaction,
      answer: { kind: "permission", optionId: "allow" },
    }),
  ).rejects.toThrow();
  expect(await f.member.mutation(api.chatroom.Watch, { chat: f.chat, tab: "member" })).toEqual({
    warm: true,
  });
});

test("machine-selected writes deny a different enrolled Worker", async () => {
  const f = await fixture();
  const command = await f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "one" });
  await expect(f.second.machine.mutation(api.acp.claimCommand, { command })).rejects.toThrow(
    "ACP_DENIED",
  );
  await expect(
    f.second.machine.mutation(api.acp.appendFrames, { chat: f.chat, epoch: 1, frames: [frame] }),
  ).rejects.toThrow("ACP_DENIED");
  await expect(
    f.second.machine.mutation(api.acp.updateSession, {
      chat: f.chat,
      patch: { status: "running" },
    }),
  ).rejects.toThrow("ACP_DENIED");
  await expect(f.owner.query(api.acp.assignedCommands, {})).rejects.toThrow();
});

test("frames enforce exact retries, conflicts, continuity, stale epochs and cold rejection", async () => {
  const f = await fixture();
  expect(await f.first.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 1 })).toEqual({
    accepted: false,
  });
  await f.owner.mutation(api.chatroom.Watch, { chat: f.chat, tab: "tab" });
  expect(await f.first.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 1 })).toEqual({
    accepted: true,
  });
  expect(await f.first.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 1 })).toEqual({
    accepted: true,
  });
  const args = { chat: f.chat, epoch: 1, frames: [frame] };
  expect(await f.first.machine.mutation(api.acp.appendFrames, args)).toEqual({
    accepted: true,
    bytes: 2,
  });
  expect(await f.first.machine.mutation(api.acp.appendFrames, args)).toEqual({
    accepted: true,
    bytes: 2,
  });
  await expect(
    f.first.machine.mutation(api.acp.appendFrames, {
      ...args,
      frames: [{ ...frame, payload: "[1]" }],
    }),
  ).rejects.toThrow("ACP_FRAME_CONFLICT");
  await expect(
    f.first.machine.mutation(api.acp.appendFrames, {
      ...args,
      frames: [{ ...frame, seqFrom: 3, seqTo: 3 }],
    }),
  ).rejects.toThrow("ACP_FRAME_GAP");
  expect(
    await f.owner.query(api.chatroom.LiveFrames, { chat: f.chat, stream: "acp:1", fromSeq: 0 }),
  ).toEqual([frame]);
  await f.first.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 2 });
  expect(await f.first.machine.mutation(api.acp.appendFrames, args)).toEqual({
    accepted: false,
    bytes: 0,
  });
  await expect(
    f.first.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 1 }),
  ).rejects.toThrow("ACP_STALE_EPOCH");
});

test("watch warms; cooling removes transient content after five minutes but retains metadata", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  expect(await f.owner.mutation(api.chatroom.Watch, { chat: f.chat, tab: "tab" })).toEqual({
    warm: true,
  });
  await f.first.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 1 });
  await f.first.machine.mutation(api.acp.appendFrames, { chat: f.chat, epoch: 1, frames: [frame] });
  vi.setSystemTime(Date.now() + ACP_COLD_AFTER_MS + 1);
  await f.t.mutation(internal.acp.coolSessions, {});
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(await f.owner.query(api.acp.GetSession, { chat: f.chat })).toMatchObject({
    warm: false,
    epoch: 1,
  });
  expect(
    await f.owner.query(api.chatroom.LiveFrames, { chat: f.chat, stream: "acp:1", fromSeq: 0 }),
  ).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("chat_viewers").take(1))).toEqual([]);
  expect(
    await f.first.machine.mutation(api.acp.appendFrames, {
      chat: f.chat,
      epoch: 1,
      frames: [frame],
    }),
  ).toEqual({ accepted: false, bytes: 0 });
});

test("answers validate offered choices and first answer wins; resolving resumes the turn", async () => {
  const f = await fixture();
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { status: "running" },
  });
  const args = { chat: f.chat, requestKey: "permission", request: permission };
  const interaction = await f.first.machine.mutation(api.acp.openInteraction, args);
  expect(await f.first.machine.mutation(api.acp.openInteraction, args)).toBe(interaction);
  await expect(
    f.owner.mutation(api.acp.Answer, {
      interaction,
      answer: { kind: "permission", optionId: "invented" },
    }),
  ).rejects.toThrow("ACP_INVALID_ANSWER");
  await f.owner.mutation(api.acp.Answer, {
    interaction,
    answer: { kind: "permission", optionId: "allow" },
  });
  await expect(
    f.owner.mutation(api.acp.Answer, {
      interaction,
      answer: { kind: "permission", optionId: "reject" },
    }),
  ).rejects.toThrow("ACP_INTERACTION_CLOSED");
  expect(await f.first.machine.query(api.acp.answeredInteractions, {})).toMatchObject([
    { _id: interaction, answer: { kind: "permission", optionId: "allow" } },
  ]);
  await f.first.machine.mutation(api.acp.resolveInteraction, { interaction, status: "resolved" });
  expect(await f.owner.query(api.acp.GetSession, { chat: f.chat })).toMatchObject({
    status: "running",
  });
});

test("lifecycle mirrors boundaries, preserves user titles and writes the ACP session id once", async () => {
  const f = await fixture();
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { status: "running", sessionId: "bound", title: "  Agent\n title " },
  });
  expect(await f.owner.query(api.aisdk.GetChat, { chatId: f.chat })).toMatchObject({
    activeStream: true,
    title: "Agent title",
    agent: { sessionId: "bound" },
  });
  expect(await f.t.run((ctx) => ctx.db.query("acp_agent_sessions").first())).toMatchObject({
    chat: f.chat,
    sessionId: "bound",
    cwd: "/work",
    title: "Agent title",
  });
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { title: "Changed title" },
  });
  expect(await f.t.run((ctx) => ctx.db.query("acp_agent_sessions").first())).toMatchObject({
    chat: f.chat,
    title: "Changed title",
  });
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { sessionId: "bound" },
  });
  await expect(
    f.first.machine.mutation(api.acp.updateSession, {
      chat: f.chat,
      patch: { sessionId: "different" },
    }),
  ).rejects.toThrow("ACP_SESSION_BOUND");
  await f.owner.mutation(api.aisdk.RenameChat, { chatId: f.chat, title: "My title" });
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { status: "idle", stopReason: "cancelled", title: "Agent override" },
  });
  expect(await f.owner.query(api.aisdk.GetChat, { chatId: f.chat })).toMatchObject({
    activeStream: false,
    title: "My title",
    interruption: { kind: "interrupted" },
  });
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { status: "failed", stopReason: "max_tokens", error: null },
  });
  expect(await f.owner.query(api.aisdk.GetChat, { chatId: f.chat })).toMatchObject({
    interruption: { kind: "failed", message: "Output limit reached" },
  });
  await expect(
    f.owner.mutation(api.aisdk.SetChatWorker, { chatId: f.chat, selection: null }),
  ).rejects.toThrow("ACP_IMMUTABLE_BINDING");
});

test("recovery fails unknown claimed turns and interactions but preserves unclaimed prompts", async () => {
  const f = await fixture();
  const pendingChat = await f.owner.mutation(api.acp.CreateSession, {
    workspace: f.workspace,
    worker: f.first.identity.workerId,
    agentId: agent.agentId,
    cwd: "/work",
  });
  await f.owner.mutation(api.acp.Prompt, { chat: pendingChat, prompt, clientId: "pending" });
  const command = await f.owner.mutation(api.acp.Prompt, {
    chat: f.chat,
    prompt,
    clientId: "claimed",
  });
  await f.first.machine.mutation(api.acp.claimCommand, { command });
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { status: "running" },
  });
  const interaction = await f.first.machine.mutation(api.acp.openInteraction, {
    chat: f.chat,
    requestKey: "p",
    request: permission,
  });
  expect(await f.first.machine.mutation(api.acp.recoverWorker, {})).toEqual({ more: false });
  expect(await f.owner.query(api.acp.GetCommand, { command })).toMatchObject({
    status: "failed",
    error: "Worker restarted",
  });
  expect(await f.owner.query(api.acp.GetSession, { chat: f.chat })).toMatchObject({
    status: "failed",
    error: "Worker restarted",
  });
  expect(await f.owner.query(api.acp.GetSession, { chat: pendingChat })).toMatchObject({
    status: "starting",
  });
  expect(await f.t.run((ctx) => ctx.db.get(interaction))).toMatchObject({ status: "cancelled" });
});

test.each([false, true])(
  "deleting a bound chat queues a surviving close/delete command (%s)",
  async (deleteInAgent) => {
    const f = await fixture();
    vi.useFakeTimers();
    await f.first.machine.mutation(api.acp.updateSession, {
      chat: f.chat,
      patch: { sessionId: "bound" },
    });
    await f.owner.mutation(api.aisdk.DeleteChat, { chatId: f.chat, deleteInAgent });
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const rows = await f.first.machine.query(api.acp.assignedCommands, {});
    expect(rows).toMatchObject([{ kind: deleteInAgent ? "delete" : "close", chat: null }]);
    const claimed = await f.first.machine.mutation(api.acp.claimCommand, { command: rows[0]!._id });
    expect(claimed?.payload).toMatchObject({
      sessionId: "bound",
      agentId: "test-agent",
      cwd: "/work",
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.chat))).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("acp_sessions").take(1))).toEqual([]);
    const indexed = await f.t.run((ctx) => ctx.db.query("acp_agent_sessions").first());
    if (deleteInAgent) expect(indexed).toBeNull();
    else {
      expect(indexed).toMatchObject({ sessionId: "bound" });
      expect(indexed).not.toHaveProperty("chat");
    }
  },
);

test("pruning keeps fresh receipts and removes expired terminal content", async () => {
  const f = await fixture();
  const now = Date.now();
  const rows = await f.t.run(async (ctx) => {
    const binding = {
      workspace: f.workspace,
      worker: f.first.identity.workerId,
      by: "owner",
      kind: "cancel" as const,
      status: "done" as const,
    };
    const expired = await ctx.db.insert("acp_commands", {
      ...binding,
      clientId: "expired",
      finishedAt: now - ACP_COMMAND_RETENTION_MS - 1,
    });
    const fresh = await ctx.db.insert("acp_commands", {
      ...binding,
      clientId: "fresh",
      finishedAt: now,
    });
    const interaction = await ctx.db.insert("acp_interactions", {
      chat: f.chat,
      workspace: f.workspace,
      worker: f.first.identity.workerId,
      requestKey: "old",
      kind: "permission",
      request: permission,
      status: "resolved",
      resolvedAt: now - ACP_INTERACTION_RETENTION_MS - 1,
      createdAt: now - ACP_INTERACTION_RETENTION_MS - 2,
    });
    return { expired, fresh, interaction };
  });
  await f.t.mutation(internal.acp.prune, {});
  expect(await f.t.run((ctx) => ctx.db.get(rows.expired))).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get(rows.interaction))).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get(rows.fresh))).not.toBeNull();
});

test("pruning expires stale agent-level sync commands without needing a chat", async () => {
  const f = await fixture();
  const command = await f.t.run((ctx) =>
    ctx.db.insert("acp_commands", {
      workspace: f.workspace,
      worker: f.first.identity.workerId,
      agentId: agent.agentId,
      kind: "sync_sessions",
      payload: { kind: "sync_sessions", agentId: agent.agentId },
      clientId: "stale-sync",
      by: "owner",
      status: "pending",
    }),
  );
  vi.useFakeTimers();
  // A full second past expiry: convex-test creation times can lead the faked clock by a tick.
  vi.setSystemTime(Date.now() + ACP_COMMAND_EXPIRY_MS + 1_000);
  await f.t.mutation(internal.acp.prune, {});
  expect(await f.t.run((ctx) => ctx.db.get(command))).toBeNull();
});

test("draft config validates advertised choices; live commands and results remain issuer-only", async () => {
  const f = await fixture();
  await expect(
    f.owner.mutation(api.acp.SetConfig, { chat: f.chat, configId: "model", value: "wrong" }),
  ).rejects.toThrow("ACP_INVALID_CONFIG");
  await f.owner.mutation(api.acp.SetConfig, { chat: f.chat, configId: "model", value: "b" });
  await f.owner.mutation(api.acp.SetMode, { chat: f.chat, modeId: "code" });
  expect(await f.owner.query(api.acp.GetSession, { chat: f.chat })).toMatchObject({
    draft: { config: [{ configId: "model", value: "b" }], modeId: "code" },
  });
  const command = await f.owner.mutation(api.acp.Authenticate, {
    workspace: f.workspace,
    worker: f.first.identity.workerId,
    agentId: agent.agentId,
    methodId: "login",
    clientId: "login",
  });
  expect(await f.member.query(api.acp.GetCommand, { command })).toBeNull();
  await expect(f.member.query(api.acp.ListAgents, { workspace: f.workspace })).rejects.toThrow();
});

test("agent session sync is online-only and debounces pending, claimed and fresh syncs", async () => {
  const f = await fixture();
  const args = { workspace: f.workspace, agentId: agent.agentId };
  await f.owner.mutation(api.acp.SyncAgentSessions, args);
  expect(await f.first.machine.query(api.acp.assignedCommands, {})).toEqual([]);
  await f.first.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/agent" });
  await f.owner.mutation(api.acp.SyncAgentSessions, args);
  await f.owner.mutation(api.acp.SyncAgentSessions, args);
  let commands = await f.first.machine.query(api.acp.assignedCommands, {});
  expect(commands).toHaveLength(1);
  expect(commands[0]?.kind).toBe("sync_sessions");
  const command = commands[0]!._id;
  expect((await f.first.machine.mutation(api.acp.claimCommand, { command }))?.payload).toEqual({
    kind: "sync_sessions",
    agentId: agent.agentId,
  });
  await f.owner.mutation(api.acp.SyncAgentSessions, args);
  expect(await f.first.machine.query(api.acp.assignedCommands, {})).toEqual([]);
  await f.first.machine.mutation(api.acp.finishCommand, { command, status: "done" });
  await f.first.machine.mutation(api.acp.syncAgentSessions, {
    agentId: agent.agentId,
    upserts: [],
    removals: [],
    finish: { count: 0, truncated: false },
  });
  await f.owner.mutation(api.acp.SyncAgentSessions, args);
  expect(await f.first.machine.query(api.acp.assignedCommands, {})).toEqual([]);
  await f.first.machine.mutation(api.acp.syncAgentSessions, {
    agentId: agent.agentId,
    upserts: [],
    removals: [],
    start: true,
  });
  await f.owner.mutation(api.acp.SyncAgentSessions, args);
  expect(await f.first.machine.query(api.acp.assignedCommands, {})).toEqual([]);
  await f.t.run(async (ctx) => {
    const row = await ctx.db
      .query("worker_agents")
      .withIndex("by_worker_and_agentId", (q) =>
        q
          .eq("workspace", f.workspace)
          .eq("worker", f.first.identity.workerId)
          .eq("agentId", agent.agentId),
      )
      .first();
    await ctx.db.patch(row!._id, {
      sessionsSync: { status: "done", at: Date.now() - 60_001, count: 0, truncated: false },
    });
  });
  await f.owner.mutation(api.acp.SyncAgentSessions, args);
  commands = await f.first.machine.query(api.acp.assignedCommands, {});
  expect(commands).toHaveLength(1);
  expect(await f.second.machine.query(api.acp.assignedCommands, {})).toEqual([]);
  await expect(f.member.mutation(api.acp.SyncAgentSessions, args)).rejects.toThrow();
});

test("machine sync applies metadata diffs, keeps links and finishes state across agent reports", async () => {
  const f = await fixture();
  const agentId = agent.agentId;
  const before = { sessionId: "one", cwd: "/one", title: "Original", updatedAt: 10 };
  await f.first.machine.mutation(api.acp.syncAgentSessions, {
    agentId,
    upserts: [before, { sessionId: "gone", cwd: "/gone", updatedAt: 1 }],
    removals: [],
    start: true,
  });
  expect(
    (await f.owner.query(api.acp.ListAgents, { workspace: f.workspace })).find(
      (row) => row.worker === f.first.identity.workerId,
    )?.sessionsSync?.status,
  ).toBe("running");
  await f.first.machine.mutation(api.acp.updateSession, {
    chat: f.chat,
    patch: { sessionId: "one", title: "Bound title" },
  });
  await f.first.machine.mutation(api.acp.syncAgentSessions, {
    agentId,
    upserts: [
      { sessionId: "one", cwd: "/changed", updatedAt: 20 },
      { sessionId: "two", cwd: "/two", title: "Second", updatedAt: 30 },
    ],
    removals: ["gone"],
    finish: { count: 2, truncated: false },
  });
  expect(await f.first.machine.query(api.acp.knownAgentSessions, { agentId })).toEqual([
    { sessionId: "one", cwd: "/changed", updatedAt: 20 },
    { sessionId: "two", cwd: "/two", title: "Second", updatedAt: 30 },
  ]);
  const linked = await f.t.run((ctx) =>
    ctx.db
      .query("acp_agent_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", f.chat))
      .first(),
  );
  expect(linked).toMatchObject({ sessionId: "one", chat: f.chat });
  expect(linked).not.toHaveProperty("title");
  const { defaults: _defaults, ...probe } = agent;
  expect(await f.first.machine.mutation(api.acp.reportAgents, { agents: [probe] })).toEqual({
    [agentId]: agent.defaults,
  });
  expect(
    (await f.owner.query(api.acp.ListAgents, { workspace: f.workspace })).find(
      (row) => row.worker === f.first.identity.workerId,
    ),
  ).toMatchObject({
    defaults: agent.defaults,
    sessionsSync: { status: "done", count: 2, truncated: false },
  });
  await f.second.machine.mutation(api.acp.syncAgentSessions, {
    agentId,
    upserts: [{ sessionId: "one", cwd: "/other-worker", updatedAt: 40 }],
    removals: [],
    finish: { error: "Cannot list" },
  });
  expect(await f.first.machine.query(api.acp.knownAgentSessions, { agentId })).toHaveLength(2);
  expect(await f.second.machine.query(api.acp.knownAgentSessions, { agentId })).toEqual([
    { sessionId: "one", cwd: "/other-worker", updatedAt: 40 },
  ]);
});

test("contract answers reject wrong kinds, undeclared or duplicate fields, and form bounds", () => {
  expect(acpAnswerError(permission, { kind: "permission", optionId: "allow" })).toBeNull();
  expect(acpAnswerError(permission, { kind: "elicitation", action: "cancel" })).not.toBeNull();
  const form: AcpInteractionRequest = {
    kind: "elicitation",
    mode: "form",
    message: "Pick",
    required: ["choice"],
    fields: [
      { name: "choice", type: "string", choices: [{ value: "a" }] },
      { name: "confirm", type: "boolean" },
    ],
  };
  const accept = (content: { name: string; value: string | boolean }[]) =>
    acpAnswerError(form, { kind: "elicitation", action: "accept", content });
  expect(
    accept([
      { name: "choice", value: "a" },
      { name: "confirm", value: true },
    ]),
  ).toBeNull();
  expect(accept([])).not.toBeNull();
  expect(accept([{ name: "choice", value: "b" }])).not.toBeNull();
  expect(
    accept([
      { name: "choice", value: "a" },
      { name: "choice", value: "a" },
    ]),
  ).not.toBeNull();
  expect(
    accept([
      { name: "choice", value: "a" },
      { name: "extra", value: true },
    ]),
  ).not.toBeNull();
});

const definition: AcpAgentDefinition = {
  agentId: "configured-agent",
  name: "Configured agent",
  command: "test-acp",
  args: ["--acp"],
  env: [{ name: "AGENT_MODE", value: "code" }],
  enabled: true,
  source: "custom",
};

test("workspace owners create, sort, update and delete launch definitions", async () => {
  const f = await fixture();
  const id = await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace,
    definition: { ...definition, name: "  Zebra  ", command: "  test-acp  " },
  });
  const alpha = await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace,
    definition: { ...definition, agentId: "alpha", name: "Alpha" },
  });
  const rows = await f.owner.query(api.acp.ListAgentDefinitions, { workspace: f.workspace });
  expect(rows.map((row) => row._id)).toEqual([alpha, id]);
  expect(rows[1]).toMatchObject({ name: "Zebra", command: "test-acp" });
  expect(rows[1]).not.toHaveProperty("workspace");
  expect(rows[1]).not.toHaveProperty("_creationTime");
  expect(rows[1]?.updatedAt).toBeTypeOf("number");
  expect(
    await f.owner.mutation(api.acp.SaveAgentDefinition, {
      workspace: f.workspace,
      id,
      definition: { ...definition, name: "New name", enabled: false, args: ["changed"] },
    }),
  ).toBe(id);
  expect(await f.owner.query(api.acp.ListAgentDefinitions, { workspace: f.workspace })).toEqual([
    expect.objectContaining({ _id: alpha, name: "Alpha" }),
    expect.objectContaining({ _id: id, name: "New name", enabled: false, args: ["changed"] }),
  ]);
  expect(
    await f.owner.mutation(api.acp.DeleteAgentDefinition, { workspace: f.workspace, id }),
  ).toBeNull();
  expect(
    await f.owner.query(api.acp.ListAgentDefinitions, { workspace: f.workspace }),
  ).toHaveLength(1);
});

test("agent definitions reject members, foreign owners and foreign document IDs", async () => {
  const f = await fixture();
  const otherWorkspace = await f.t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "other", name: "Other" }),
  );
  const other = f.t.withIdentity({ subject: "other" });
  const id = await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace,
    definition,
  });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  for (const unauthorized of [f.member, other]) {
    await expect(
      unauthorized.query(api.acp.ListAgentDefinitions, { workspace: f.workspace }),
    ).rejects.toThrow();
    await expect(
      unauthorized.mutation(api.acp.SaveAgentDefinition, { workspace: f.workspace, definition }),
    ).rejects.toThrow();
    await expect(
      unauthorized.mutation(api.acp.SaveAgentDefinition, {
        workspace: f.workspace,
        id,
        definition,
      }),
    ).rejects.toThrow();
    await expect(
      unauthorized.mutation(api.acp.DeleteAgentDefinition, { workspace: f.workspace, id }),
    ).rejects.toThrow();
    await expect(
      unauthorized.action(api.acp.RegistryAgents, { workspace: f.workspace }),
    ).rejects.toThrow();
  }
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(
    other.mutation(api.acp.SaveAgentDefinition, { workspace: otherWorkspace, id, definition }),
  ).rejects.toThrow(/ACP_AGENT_NOT_FOUND/);
  await expect(
    other.mutation(api.acp.DeleteAgentDefinition, { workspace: otherWorkspace, id }),
  ).rejects.toThrow(/ACP_AGENT_NOT_FOUND/);
});

test("agent definitions reject duplicate and changed IDs, unsafe env and malformed IDs", async () => {
  const f = await fixture();
  const id = await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace,
    definition,
  });
  await expect(
    f.owner.mutation(api.acp.SaveAgentDefinition, { workspace: f.workspace, definition }),
  ).rejects.toThrow(/ACP_AGENT_EXISTS/);
  await expect(
    f.owner.mutation(api.acp.SaveAgentDefinition, {
      workspace: f.workspace,
      id,
      definition: { ...definition, agentId: "changed" },
    }),
  ).rejects.toThrow(/ACP_INVALID_AGENT/);
  for (const invalid of [
    { ...definition, agentId: "bad id" },
    { ...definition, env: [{ name: "PATH", value: "/tmp/bin" }] },
  ]) {
    await expect(
      f.owner.mutation(api.acp.SaveAgentDefinition, {
        workspace: f.workspace,
        definition: invalid,
      }),
    ).rejects.toThrow(/ACP_INVALID_AGENT/);
    await expect(
      f.owner.mutation(api.acp.SaveAgentDefinition, {
        workspace: f.workspace,
        id,
        definition: invalid,
      }),
    ).rejects.toThrow(/ACP_INVALID_AGENT/);
  }
  expect(
    await f.owner.query(api.acp.ListAgentDefinitions, { workspace: f.workspace }),
  ).toHaveLength(1);
});

test("definition capacity is per workspace and updates still work at capacity", async () => {
  const f = await fixture();
  const ids = await f.t.run(async (ctx) => {
    const ids = [];
    for (let index = 0; index < ACP_AGENT_DEFINITIONS_MAX; index++) {
      ids.push(
        await ctx.db.insert("acp_agents", {
          workspace: f.workspace,
          ...definition,
          agentId: `agent-${index}`,
          updatedAt: Date.now(),
        }),
      );
    }
    return ids;
  });
  await expect(
    f.owner.mutation(api.acp.SaveAgentDefinition, { workspace: f.workspace, definition }),
  ).rejects.toThrow(/ACP_INVALID_AGENT/);
  await expect(
    f.owner.mutation(api.acp.SaveAgentDefinition, {
      workspace: f.workspace,
      id: ids[0],
      definition: { ...definition, agentId: "agent-0", name: "Updated" },
    }),
  ).resolves.toBe(ids[0]);
  expect(await f.first.machine.query(api.acp.agentDefinitions, {})).toHaveLength(
    ACP_AGENT_DEFINITIONS_MAX,
  );
});

test("machine definition subscriptions expose only enabled definitions in their workspace", async () => {
  const f = await fixture();
  await f.owner.mutation(api.acp.SaveAgentDefinition, { workspace: f.workspace, definition });
  await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace,
    definition: { ...definition, agentId: "disabled", enabled: false },
  });
  const foreignWorkspace = await f.t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "foreign", name: "Foreign" }),
  );
  await f.t.withIdentity({ subject: "foreign" }).mutation(api.acp.SaveAgentDefinition, {
    workspace: foreignWorkspace,
    definition: { ...definition, name: "Foreign agent" },
  });
  expect(await f.first.machine.query(api.acp.agentDefinitions, {})).toEqual([definition]);
  expect(await f.second.machine.query(api.acp.agentDefinitions, {})).toEqual([definition]);
  await expect(f.owner.query(api.acp.agentDefinitions, {})).rejects.toThrow(/WORKER_AUTH_DENIED/);
});

const registryFixture = {
  version: "1",
  agents: [
    {
      id: "npm-agent",
      name: "Npm agent",
      version: "1.2.3",
      description: "An npm agent",
      icon: "https://example.invalid/icon.svg",
      distribution: {
        npx: { package: "@example/agent@1.2.3", args: ["--acp"], env: { MODE: "code" } },
      },
    },
    {
      id: "python-agent",
      name: "Python agent",
      version: "2",
      distribution: { uvx: { package: "agent==2", args: ["acp"] } },
    },
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
    { id: "no-launch", name: "Invalid", version: "1", distribution: {} },
    {
      id: "bad-args",
      name: "Invalid",
      version: "1",
      distribution: { uvx: { package: "bad", args: [2] } },
    },
    {
      id: "bad-env",
      name: "Invalid",
      version: "1",
      distribution: { npx: { package: "bad", env: { PATH: "/tmp" } } },
    },
    {
      id: "bad-package",
      name: "Invalid",
      version: "1",
      distribution: { npx: { package: "--eval=bad" } },
    },
    { id: "no-version", name: "Invalid", distribution: { npx: { package: "bad" } } },
    null,
  ],
};

test("registry normalization handles npx, uvx and binary PATH hints and skips invalid entries", () => {
  expect(normalizeRegistryAgents(registryFixture)).toEqual([
    {
      id: "npm-agent",
      name: "Npm agent",
      version: "1.2.3",
      description: "An npm agent",
      icon: "https://example.invalid/icon.svg",
      launch: {
        command: "npx",
        args: ["-y", "@example/agent@1.2.3", "--acp"],
        env: [{ name: "MODE", value: "code" }],
      },
    },
    {
      id: "python-agent",
      name: "Python agent",
      version: "2",
      launch: { command: "uvx", args: ["agent==2", "acp"], env: [] },
    },
    {
      id: "binary-agent",
      name: "Binary agent",
      version: "3",
      pathCommand: { command: "agent", args: ["acp"] },
    },
  ]);
  expect(normalizeRegistryAgents(null)).toEqual([]);
  expect(normalizeRegistryAgents({ agents: [] })).toEqual([]);
  expect(
    normalizeRegistryAgents({
      version: "1",
      agents: Array.from({ length: 201 }, (_, index) => ({
        ...registryFixture.agents[0],
        id: `agent-${index}`,
      })),
    }),
  ).toHaveLength(200);
});

test("owner registry actions fetch and normalize on demand without a Worker", async () => {
  const f = await fixture();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(registryFixture)));
  vi.stubGlobal("fetch", fetchMock);
  expect(await f.owner.action(api.acp.RegistryAgents, { workspace: f.workspace })).toEqual(
    normalizeRegistryAgents(registryFixture),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("registry actions reject responses exceeding one MiB while streaming", async () => {
  const f = await fixture();
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
    ),
  );
  await expect(f.owner.action(api.acp.RegistryAgents, { workspace: f.workspace })).rejects.toThrow(
    /1 MiB/,
  );
  expect(cancel).toHaveBeenCalledOnce();
});
