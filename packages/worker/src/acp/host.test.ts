import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  AcpAgentDefinition,
  AcpAgentReport,
  AcpCommandPayload,
  AcpFrameInput,
  AcpInteractionAnswer,
  AcpInteractionRequest,
  AcpOp,
} from "backend/src/acp/contract";
import { AcpHost } from "./host.js";
import type {
  AcpTransport,
  AcpAssignment,
  AcpAnsweredInteraction,
  AcpClaim,
  AcpSessionBinding,
  AcpSessionPatch,
  AcpWarmSession,
} from "./transport.js";

class FakeTransport implements AcpTransport {
  assignments: AcpAssignment[] = [];
  claims = new Map<string, AcpClaim>();
  receipts = new Map<string, { status: string; error?: string; result?: string }>();
  patches: AcpSessionPatch[] = [];
  reports: AcpAgentReport[] = [];
  definitions: AcpAgentDefinition[] = [definition()];
  reportCount = 0;
  frames: { epoch: number; frame: AcpFrameInput }[] = [];
  opened: { id: string; key: string; request: AcpInteractionRequest }[] = [];
  resolved: { interaction: string; status: string }[] = [];
  epoch = 0;
  warm = true;
  binding: AcpSessionBinding = {
    agentId: "scripted",
    cwd: tmpdir(),
    sessionId: null,
    status: "idle",
    epoch: 0,
    warm: true,
    draft: null,
    config: null,
  };
  private commandListener?: (commands: AcpAssignment[]) => void;
  private definitionListener?: (definitions: AcpAgentDefinition[]) => void;
  private warmListener?: (sessions: AcpWarmSession[]) => void;
  private answerListener?: (answers: AcpAnsweredInteraction[]) => void;

  agentDefinitions = (receive: (rows: AcpAgentDefinition[]) => void) => {
    this.definitionListener = receive;
    queueMicrotask(() => receive(this.definitions));
    return () => {
      this.definitionListener = undefined;
    };
  };
  publishDefinitions(definitions: AcpAgentDefinition[]) {
    this.definitions = definitions;
    this.definitionListener?.(definitions);
  }
  assignedCommands = (receive: (rows: AcpAssignment[]) => void) => {
    this.commandListener = receive;
    queueMicrotask(() => receive(this.assignments));
    return () => {
      this.commandListener = undefined;
    };
  };
  warmSessions = (receive: (rows: AcpWarmSession[]) => void) => {
    this.warmListener = receive;
    queueMicrotask(() => this.publishWarm());
    return () => {
      this.warmListener = undefined;
    };
  };
  answeredInteractions = (receive: (rows: AcpAnsweredInteraction[]) => void) => {
    this.answerListener = receive;
    return () => {
      this.answerListener = undefined;
    };
  };
  publishWarm() {
    this.warmListener?.(
      this.warm
        ? [
            {
              chat: "chat",
              agentId: this.binding.agentId,
              cwd: this.binding.cwd,
              sessionId: this.binding.sessionId,
              epoch: this.epoch,
              status: this.binding.status,
            },
          ]
        : [],
    );
  }
  add(payload: AcpCommandPayload): string {
    const command = crypto.randomUUID();
    const agentLevel = ["list", "authenticate", "logout", "close", "delete"].includes(payload.kind);
    this.claims.set(command, {
      command,
      kind: payload.kind,
      payload,
      by: "user",
      chat: agentLevel ? null : "chat",
      session: agentLevel ? null : { ...this.binding },
    });
    this.assignments = [
      ...this.assignments,
      { _id: command, kind: payload.kind, chat: agentLevel ? null : "chat", createdAt: Date.now() },
    ];
    this.commandListener?.(this.assignments);
    return command;
  }
  async claimCommand({ command }: { command: string }) {
    const claim = this.claims.get(command) ?? null;
    this.claims.delete(command);
    this.assignments = this.assignments.filter((row) => row._id !== command);
    queueMicrotask(() => this.commandListener?.(this.assignments));
    return claim;
  }
  async finishCommand(args: {
    command: string;
    status: "done" | "failed";
    error?: string;
    result?: string;
  }) {
    this.receipts.set(args.command, args);
  }
  async startEpoch({ epoch }: { chat: string; epoch: number }) {
    this.epoch = epoch;
    this.binding.epoch = epoch;
    return { accepted: this.warm };
  }
  async appendFrames(args: { chat: string; epoch: number; frames: AcpFrameInput[] }) {
    if (!this.warm || args.epoch !== this.epoch) return { accepted: false, bytes: 0 };
    this.frames.push(...args.frames.map((frame) => ({ epoch: args.epoch, frame })));
    return {
      accepted: true,
      bytes: this.frames
        .filter((entry) => entry.epoch === args.epoch)
        .reduce((sum, entry) => sum + entry.frame.payload.length, 0),
    };
  }
  async updateSession({ patch }: { chat: string; patch: AcpSessionPatch }) {
    this.patches.push(patch);
    if (patch.sessionId) this.binding.sessionId = patch.sessionId;
    if (patch.status) this.binding.status = patch.status;
    if (patch.config) this.binding.config = patch.config;
    this.publishWarm();
  }
  async reportAgents({ agents }: { agents: AcpAgentReport[] }) {
    this.reports = structuredClone(agents);
    this.reportCount++;
  }
  async recoverWorker() {
    return { more: false };
  }
  async openInteraction(args: {
    chat: string;
    requestKey: string;
    request: AcpInteractionRequest;
  }) {
    const id = crypto.randomUUID();
    this.opened.push({ id, key: args.requestKey, request: args.request });
    return id;
  }
  async resolveInteraction(args: { interaction: string; status: "resolved" | "cancelled" }) {
    this.resolved.push(args);
  }
  answer(index: number, answer: AcpInteractionAnswer) {
    const interaction = this.opened[index]!;
    this.answerListener?.([
      { _id: interaction.id, chat: "chat", requestKey: interaction.key, answer },
    ]);
  }
  ops(): AcpOp[] {
    return this.frames.flatMap(({ frame }) => JSON.parse(frame.payload) as AcpOp[]);
  }
}

async function until(check: () => boolean): Promise<void> {
  const expires = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > expires) throw new Error("Timed out waiting for observable ACP state");
    // Real subprocess I/O and its cancellation timers cannot use the parent's fake clock.
    await delay(10);
  }
}
const hosts: AcpHost[] = [];
const directories: string[] = [];
const script = fileURLToPath(new URL("./test-agent.ts", import.meta.url));
const bun = execFileSync("bun", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
function definition(args: string[] = []): AcpAgentDefinition {
  return {
    agentId: "scripted",
    name: "Scripted",
    command: bun,
    args: [script, ...args],
    env: [],
    enabled: true,
    source: "custom",
  };
}
async function start(transport: FakeTransport, args: string[] = []) {
  transport.definitions = [definition(args)];
  const host = new AcpHost(transport);
  hosts.push(host);
  host.setAvailable(true);
  await until(() => transport.reports.length > 0);
  return host;
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("ACP host with real stdio agent", () => {
  it("keeps a running turn on its old definition and uses the replacement for the next prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "radium-acp-redefine-"));
    directories.push(directory);
    const transport = new FakeTransport();
    const store = join(directory, "sessions.json");
    await start(transport, ["--store", store]);
    const running = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "permission" }],
    });
    await until(() => transport.opened.length === 1);
    const reportCount = transport.reportCount;
    transport.publishDefinitions([
      {
        ...definition(["--store", store, "--require-auth"]),
        name: "Changed agent",
      },
    ]);
    await until(() => transport.reportCount > reportCount);
    expect(transport.receipts.has(running)).toBe(false);
    transport.answer(0, { kind: "permission", optionId: "allow_once" });
    await until(() => transport.receipts.has(running));
    expect(transport.receipts.get(running)?.status).toBe("done");
    const next = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "hello" }],
    });
    await until(() => transport.receipts.has(next));
    expect(transport.receipts.get(next)).toMatchObject({
      status: "failed",
      error: "Sign in to Changed agent",
    });
  });

  it("fails a new prompt with Agent removed after its definition is deleted", async () => {
    const transport = new FakeTransport();
    await start(transport);
    const first = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "hello" }],
    });
    await until(() => transport.receipts.has(first));
    const reportCount = transport.reportCount;
    transport.publishDefinitions([]);
    await until(() => transport.reportCount > reportCount);
    expect(transport.reports).toEqual([]);
    const next = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "hello again" }],
    });
    await until(() => transport.receipts.has(next));
    expect(transport.receipts.get(next)).toMatchObject({
      status: "failed",
      error: "Agent removed",
    });
  });

  it("re-probes definitions when the Worker reconnects", async () => {
    const transport = new FakeTransport();
    const host = await start(transport);
    const count = transport.reportCount;
    host.setAvailable(false);
    host.setAvailable(true);
    await until(() => transport.reportCount > count);
    expect(transport.reports[0]?.status).toBe("ready");
  });

  it("relays a prompt and durable lifecycle, applies drafts and agent title/config updates", async () => {
    const transport = new FakeTransport();
    transport.binding.draft = {
      config: [{ configId: "model", value: "scripted-large" }],
      modeId: "plan",
    };
    await start(transport);
    const command = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "hello" }] });
    await until(() => transport.receipts.has(command));
    await until(() => transport.ops().some((op) => op.op === "turn.end"));
    expect(transport.receipts.get(command)?.status).toBe("done");
    expect(transport.binding.sessionId).toBeTruthy();
    expect(
      transport.binding.config?.options.find((option) => option.id === "model")?.currentValue,
    ).toBe("scripted-large");
    expect(transport.binding.config?.modes?.currentModeId).toBe("plan");
    expect(transport.patches.map((patch) => patch.status).filter(Boolean)).toEqual([
      "running",
      "idle",
    ]);
    expect(transport.patches.some((patch) => patch.title)).toBe(true);
    expect(transport.patches.some((patch) => patch.usage)).toBe(true);
    expect(transport.ops().some((op) => op.op === "item.upsert" && op.item.kind === "tool")).toBe(
      true,
    );
    expect(transport.ops().some((op) => op.op === "item.upsert" && op.item.kind === "plan")).toBe(
      true,
    );
    expect(transport.frames.some(({ frame }) => frame.kind === "snapshot")).toBe(true);
  });

  it("round trips permission and form decisions through durable interactions", async () => {
    const transport = new FakeTransport();
    await start(transport);
    const permission = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "permission" }],
    });
    await until(() => transport.opened.length === 1);
    expect(transport.opened[0]?.request.kind).toBe("permission");
    transport.answer(0, { kind: "permission", optionId: "allow_once" });
    await until(() => transport.receipts.has(permission));
    expect(transport.resolved[0]).toEqual({
      interaction: transport.opened[0]!.id,
      status: "resolved",
    });
    expect(JSON.stringify(transport.ops())).toContain("allow_once");
    const question = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "question" }],
    });
    await until(() => transport.opened.length === 2);
    expect(transport.opened[1]?.request).toMatchObject({
      kind: "elicitation",
      mode: "form",
      required: ["color", "confirm"],
    });
    transport.answer(1, {
      kind: "elicitation",
      action: "accept",
      content: [
        { name: "color", value: "blue" },
        { name: "confirm", value: true },
      ],
    });
    await until(() => transport.receipts.has(question));
    expect(transport.receipts.get(question)?.status).toBe("done");
    expect(JSON.stringify(transport.ops())).toContain("blue");
  });

  it("cancels a running slow prompt without waiting for it to finish, including open requests", async () => {
    const transport = new FakeTransport();
    await start(transport);
    const slow = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "slow" }] });
    await until(() => transport.binding.status === "running");
    const cancel = transport.add({ kind: "cancel" });
    await until(() => transport.receipts.has(slow) && transport.receipts.has(cancel));
    expect(transport.patches.at(-1)).toMatchObject({ status: "idle", stopReason: "cancelled" });
    const permission = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "permission" }],
    });
    await until(() => transport.opened.length === 1);
    transport.add({ kind: "cancel" });
    await until(() => transport.receipts.has(permission));
    expect(transport.resolved).toContainEqual({
      interaction: transport.opened[0]!.id,
      status: "cancelled",
    });
  });

  it("fails a crashed turn and lazily reloads the persisted session on the next command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "radium-acp-crash-"));
    directories.push(directory);
    const transport = new FakeTransport();
    await start(transport, ["--store", join(directory, "sessions.json")]);
    const crash = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "crash" }] });
    await until(() => transport.receipts.has(crash));
    expect(transport.receipts.get(crash)).toMatchObject({
      status: "failed",
      error: "Agent process exited",
    });
    expect(transport.patches).toContainEqual({ status: "failed", error: "Agent process exited" });
    const next = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "hello again" }] });
    await until(() => transport.receipts.has(next));
    expect(transport.receipts.get(next)?.status).toBe("done");
    expect(transport.patches.some((patch) => patch.history === "full")).toBe(true);
  });

  it("rebuilds warm history by loading the actual persistent agent store after host restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "radium-acp-load-"));
    directories.push(directory);
    const args = ["--store", join(directory, "sessions.json")];
    const transport = new FakeTransport();
    const first = await start(transport, args);
    const command = transport.add({
      kind: "prompt",
      prompt: [{ type: "text", text: "persistent hello" }],
    });
    await until(() => transport.receipts.has(command));
    await first.close();
    const previousEpoch = transport.epoch;
    transport.frames = [];
    transport.reports = [];
    await start(transport, args);
    await until(() => transport.epoch > previousEpoch && transport.frames.length > 0);
    expect(transport.patches.some((patch) => patch.history === "full")).toBe(true);
    expect(JSON.stringify(transport.ops())).toContain("persistent hello");
    expect(transport.frames[0]?.frame.kind).toBe("snapshot");
  });

  it("ends a warm session the agent no longer knows instead of leaving viewers waiting", async () => {
    const transport = new FakeTransport();
    transport.binding.sessionId = "lost-session";
    await start(transport);
    await until(() => transport.patches.some((patch) => patch.status === "ended"));
    expect(transport.patches.find((patch) => patch.status === "ended")?.error).toContain(
      "no longer has this session",
    );
    expect(transport.frames).toEqual([]);
  });

  it("reports auth_required, authenticates, lists bounded sessions and handles refusal", async () => {
    const transport = new FakeTransport();
    await start(transport, ["--require-auth"]);
    const denied = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "hello" }] });
    await until(() => transport.receipts.has(denied));
    expect(transport.reports[0]?.status).toBe("needs_auth");
    expect(transport.receipts.get(denied)?.error).toContain("Sign in to");
    const auth = transport.add({ kind: "authenticate", agentId: "scripted", methodId: "scripted" });
    await until(() => transport.receipts.has(auth));
    expect(transport.reports[0]?.status).toBe("ready");
    const refuse = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "refuse" }] });
    await until(() => transport.receipts.has(refuse));
    expect(transport.patches.at(-1)).toMatchObject({ status: "failed", stopReason: "refusal" });
    const list = transport.add({ kind: "list", agentId: "scripted", cwd: tmpdir() });
    await until(() => transport.receipts.has(list));
    expect(JSON.parse(transport.receipts.get(list)!.result!).sessions).toMatchObject([
      { sessionId: transport.binding.sessionId },
    ]);
  });

  it("round trips URL consent, keeps cold output local, and snapshots again after warming", async () => {
    const transport = new FakeTransport();
    transport.warm = false;
    await start(transport);
    const command = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "link" }] });
    await until(() => transport.opened.length === 1);
    expect(transport.opened[0]?.request).toMatchObject({ kind: "elicitation", mode: "url" });
    transport.answer(0, { kind: "elicitation", action: "accept", content: [] });
    await until(() => transport.receipts.has(command));
    expect(transport.frames).toEqual([]);
    transport.warm = true;
    transport.publishWarm();
    await until(() => transport.frames.length > 0);
    expect(transport.frames[0]?.frame.kind).toBe("snapshot");
    expect(transport.ops().some((op) => op.op === "item.upsert")).toBe(true);
    const previousEpoch = transport.epoch;
    transport.warm = false;
    transport.publishWarm();
    transport.warm = true;
    transport.publishWarm();
    await until(() => transport.epoch > previousEpoch);
    expect(
      transport.frames.some(
        ({ epoch, frame }) => epoch > previousEpoch && frame.kind === "snapshot",
      ),
    ).toBe(true);
  });

  it("runs config commands during a prompt and deletes only the selected persisted session", async () => {
    const transport = new FakeTransport();
    await start(transport);
    const slow = transport.add({ kind: "prompt", prompt: [{ type: "text", text: "slow" }] });
    await until(() => transport.binding.status === "running");
    const config = transport.add({
      kind: "set_config",
      configId: "model",
      value: "scripted-large",
    });
    await until(() => transport.receipts.has(config));
    expect(transport.receipts.has(slow)).toBe(false);
    expect(
      transport.binding.config?.options.find((option) => option.id === "model")?.currentValue,
    ).toBe("scripted-large");
    transport.add({ kind: "cancel" });
    await until(() => transport.receipts.has(slow));
    const removed = transport.add({
      kind: "delete",
      agentId: "scripted",
      cwd: tmpdir(),
      sessionId: transport.binding.sessionId!,
    });
    await until(() => transport.receipts.has(removed));
    const list = transport.add({ kind: "list", agentId: "scripted", cwd: tmpdir() });
    await until(() => transport.receipts.has(list));
    expect(JSON.parse(transport.receipts.get(list)!.result!).sessions).toEqual([]);
  });
});
