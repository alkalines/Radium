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
  ACP_INTERACTION_RETENTION_MS,
  acpAnswerError,
  type AcpAgentReport,
  type AcpInteractionRequest,
} from "../src/acp/contract";

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

test("import binds an agent session to one chat only", async () => {
  const f = await fixture();
  const imported = {
    workspace: f.workspace,
    worker: f.first.identity.workerId,
    agentId: agent.agentId,
    cwd: "/work",
    sessionId: "outside-session",
  };
  const chat = await f.owner.mutation(api.acp.CreateSession, imported);
  expect((await f.owner.query(api.acp.GetSession, { chat })).agent.sessionId).toBe(
    "outside-session",
  );
  // The Worker may still confirm the same ID after loading it, but never replace it.
  await f.first.machine.mutation(api.acp.updateSession, {
    chat,
    patch: { sessionId: "outside-session", history: "full" },
  });
  await expect(
    f.first.machine.mutation(api.acp.updateSession, { chat, patch: { sessionId: "other" } }),
  ).rejects.toThrow(/ACP_SESSION_BOUND/);

  await expect(f.owner.mutation(api.acp.CreateSession, imported)).rejects.toThrow(
    /ACP_SESSION_BOUND/,
  );
  await expect(
    f.member.mutation(api.acp.CreateSession, { ...imported, sessionId: "member-import" }),
  ).rejects.toThrow();
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
  const command = await f.owner.mutation(api.acp.ListAgentSessions, {
    workspace: f.workspace,
    worker: f.first.identity.workerId,
    agentId: agent.agentId,
    cwd: "/work",
    clientId: "list",
  });
  expect(await f.member.query(api.acp.GetCommand, { command })).toBeNull();
  await expect(f.member.query(api.acp.ListAgents, { workspace: f.workspace })).rejects.toThrow();
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
