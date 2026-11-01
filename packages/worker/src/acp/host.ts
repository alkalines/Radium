import {
  methods,
  RequestError,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import type {
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { ForkSessionRequest, ForkSessionResponse } from "@agentclientprotocol/sdk/unstable";
import {
  ACP_COMMAND_RESULT_BYTES,
  ACP_INTERACTION_REQUEST_BYTES,
  utf8Bytes,
  acpAgentDefinitionError,
  type AcpAgentDefinition,
  type AcpAgentReport,
  type AcpInteractionAnswer,
  type AcpInteractionRequest,
  type AcpSessionListPage,
} from "backend/src/acp/contract";
import { resolveAgentCommand } from "./config.js";
import { AcpAgentProcess, agentReport, probeAgent } from "./process.js";
import { AcpLifecycle, acpDelay } from "./lifecycle.js";
import { normalizeElicitation } from "./interactions.js";
import { AcpTimeline, normalizeConfig, normalizeToolContent } from "./timeline.js";
import { AcpRelay } from "./relay.js";
import type {
  AcpTransport,
  AcpAssignment,
  AcpClaim,
  AcpSessionBinding,
  AcpSessionPatch,
  AcpWarmSession,
} from "./transport.js";

interface LocalSession {
  chat: string;
  binding: AcpSessionBinding;
  timeline: AcpTimeline;
  relay: AcpRelay;
  process?: AcpAgentProcess;
  setup?: Promise<LocalSession>;
  warming?: Promise<void>;
  running: boolean;
  preparing: boolean;
  updates: Promise<void>;
}
interface AgentSlot {
  definition: AcpAgentDefinition;
  process?: AcpAgentProcess;
  starting?: Promise<AcpAgentProcess>;
  stopping?: Promise<void>;
  failures: number;
  lastUsed: number;
  restartAt: number;
}
interface PendingInteraction {
  chat: string;
  resolve(answer: AcpInteractionAnswer | null): void;
}

/** Hosts local agents while Convex owns authority, durable commands and user decisions. */
export class AcpHost {
  private readonly lifecycle = new AcpLifecycle();
  private readonly slots = new Map<string, AgentSlot>();
  private readonly retired = new Set<AgentSlot>();
  private readonly sessions = new Map<string, LocalSession>();
  private readonly earlyUpdates = new WeakMap<AcpAgentProcess, SessionNotification[]>();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly claimed = new Set<string>();
  private readonly turns = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private readonly warm = new Map<string, AcpWarmSession>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly retry: ReturnType<typeof setInterval>;
  private readonly idle: ReturnType<typeof setInterval>;
  private reports: AcpAgentReport[] = [];
  private assignments: AcpAssignment[] = [];
  private available = false;
  private stopped = false;
  private recovered = false;
  private initialized = false;
  private pumping = false;
  private commandDirty = false;
  private initializing?: Promise<void>;
  private definitionsReady = false;
  private definitionsRevision = 0;

  constructor(private readonly transport: AcpTransport) {
    this.retry = setInterval(() => {
      void this.connect();
      void this.pump();
      void this.syncWarm();
    }, 1_000);
    this.idle = setInterval(() => {
      void this.stopIdleAgents();
    }, 60_000);
  }

  /** Control availability gates recovery, claims, subscriptions and durable delivery. */
  setAvailable(value: boolean): void {
    const reconnected = value && !this.available;
    this.available = value;
    this.lifecycle.setAvailable(value);
    if (value) {
      if (reconnected && this.initialized)
        void this.applyDefinitions([...this.slots.values()].map((slot) => slot.definition));
      void this.connect();
      void this.pump();
      void this.syncWarm();
    }
  }

  private async connect(): Promise<void> {
    if (!this.available || this.stopped || this.initialized || this.initializing) return;
    this.initializing = (async () => {
      if (!this.recovered) {
        while ((await this.transport.recoverWorker({})).more) {
          if (!this.available || this.stopped) return;
        }
        this.recovered = true;
      }
      if (this.stopped) return;
      this.unsubscribers.push(
        this.transport.agentDefinitions(
          (definitions) => {
            void this.applyDefinitions(definitions);
          },
          () => {
            this.definitionsReady = false;
          },
        ),
      );
      if (this.stopped) return;
      this.unsubscribers.push(
        this.transport.assignedCommands(
          (assignments) => {
            this.assignments = assignments;
            this.commandDirty = true;
            const pending = new Set(assignments.map((assignment) => assignment._id));
            for (const command of this.claimed)
              if (!pending.has(command)) this.claimed.delete(command);
            void this.pump();
          },
          () => {
            this.assignments = [];
          },
        ),
        this.transport.warmSessions(
          (sessions) => {
            this.warm.clear();
            for (const session of sessions) this.warm.set(session.chat, session);
            for (const [chat, local] of this.sessions) if (!this.warm.has(chat)) local.relay.stop();
            void this.syncWarm();
          },
          () => {
            this.warm.clear();
            for (const local of this.sessions.values()) local.relay.stop();
          },
        ),
        this.transport.answeredInteractions(
          (answers) => {
            for (const answer of answers)
              this.interactions.get(answer.requestKey)?.resolve(answer.answer);
          },
          () => undefined,
        ),
      );
      this.initialized = true;
      void this.pump();
      void this.syncWarm();
    })()
      .catch(() => undefined)
      .finally(() => {
        this.initializing = undefined;
      });
    await this.initializing;
  }

  private async applyDefinitions(definitions: AcpAgentDefinition[]): Promise<void> {
    const revision = ++this.definitionsRevision;
    this.definitionsReady = false;
    const previous = new Map(this.slots);
    this.slots.clear();
    for (const definition of definitions) {
      if (!definition.enabled) continue;
      const existing = previous.get(definition.agentId);
      if (existing && JSON.stringify(existing.definition) === JSON.stringify(definition)) {
        this.slots.set(definition.agentId, existing);
        previous.delete(definition.agentId);
      } else {
        this.slots.set(definition.agentId, {
          definition,
          failures: 0,
          lastUsed: Date.now(),
          restartAt: 0,
        });
      }
    }
    for (const slot of previous.values()) this.retired.add(slot);
    void this.stopRetiredAgents();
    try {
      const reports = await Promise.all(
        [...this.slots.values()].map((slot) => probeAgent(slot.definition, this.abort.signal)),
      );
      if (this.stopped || revision !== this.definitionsRevision) return;
      this.reports = reports;
      await this.lifecycle.run("worker", () => this.transport.reportAgents({ agents: reports }));
      if (this.stopped || revision !== this.definitionsRevision) return;
      this.definitionsReady = true;
      void this.pump();
      void this.syncWarm();
    } catch {
      // The Convex subscription delivers a fresh definition set after reconnect.
    }
  }

  private async stopRetiredAgents(): Promise<void> {
    for (const slot of this.retired) {
      if (
        slot.starting ||
        [...this.sessions.values()].some(
          (local) =>
            (local.process === slot.process && local.running) ||
            (local.binding.agentId === slot.definition.agentId && (local.setup || local.preparing)),
        )
      )
        continue;
      await this.stopAgent(slot);
      this.retired.delete(slot);
    }
  }

  private async pump(): Promise<void> {
    if (
      !this.initialized ||
      !this.definitionsReady ||
      !this.available ||
      this.stopped ||
      this.pumping
    )
      return;
    this.pumping = true;
    this.commandDirty = false;
    try {
      for (const assignment of this.assignments) {
        if (!this.available || this.stopped) return;
        if (this.claimed.has(assignment._id)) continue;
        let claim: AcpClaim | null;
        try {
          claim = await this.transport.claimCommand({ command: assignment._id });
        } catch {
          return;
        }
        if (!claim) continue;
        this.claimed.add(claim.command);
        const key =
          claim.chat ?? ("agentId" in claim.payload ? `agent:${claim.payload.agentId}` : "worker");
        const work = (this.commandTails.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => this.execute(claim))
          .catch(() => undefined);
        this.commandTails.set(key, work);
        void work.finally(() => {
          if (this.commandTails.get(key) === work) this.commandTails.delete(key);
        });
      }
    } finally {
      this.pumping = false;
      if (this.commandDirty) void this.pump();
    }
  }

  private local(chat: string, binding: AcpSessionBinding): LocalSession {
    let local = this.sessions.get(chat);
    if (!local) {
      const timeline = new AcpTimeline();
      local = {
        chat,
        binding: { ...binding },
        timeline,
        relay: new AcpRelay(this.transport, chat, timeline),
        running: false,
        preparing: false,
        updates: Promise.resolve(),
      };
      this.sessions.set(chat, local);
    } else {
      local.binding.epoch = Math.max(local.binding.epoch, binding.epoch);
      if (!local.binding.sessionId) {
        local.binding.sessionId = binding.sessionId;
        local.binding.draft = binding.draft ?? local.binding.draft;
      }
      if (!local.binding.config && binding.config) local.binding.config = binding.config;
    }
    return local;
  }

  private patch(local: LocalSession, patch: AcpSessionPatch): Promise<unknown> {
    if (patch.sessionId) local.binding.sessionId = patch.sessionId;
    if (patch.config) {
      local.binding.config = patch.config;
      local.timeline.sessionPatch.config = patch.config;
    }
    if (patch.status) local.binding.status = patch.status;
    if (patch.commands) local.timeline.sessionPatch.commands = patch.commands;
    if (patch.usage) local.timeline.sessionPatch.usage = patch.usage;
    return this.lifecycle.run(local.chat, () =>
      this.transport.updateSession({ chat: local.chat, patch }),
    );
  }

  private async processFor(agentId: string): Promise<AcpAgentProcess> {
    const slot = this.slots.get(agentId);
    if (!slot) throw new Error("Agent removed");
    slot.lastUsed = Date.now();
    if (slot.starting) return slot.starting;
    if (slot.process) return slot.process;
    slot.starting = (async () => {
      if (slot.restartAt > Date.now())
        await acpDelay(slot.restartAt - Date.now(), this.abort.signal);
      if (this.stopped) throw new Error("ACP host stopped");
      const invalid = acpAgentDefinitionError(slot.definition);
      if (invalid) throw new Error(invalid);
      const command = await resolveAgentCommand(slot.definition.command);
      if (!command)
        throw new Error(`${slot.definition.command} was not found on this Worker's PATH`);
      if (this.stopped) throw new Error("ACP host stopped");
      const process = new AcpAgentProcess(slot.definition, command, {
        update: (notification) => this.onUpdate(process, notification),
        permission: (request) => this.permission(process, request),
        elicitation: (request) => this.elicitation(process, request),
        elicitationComplete: () => undefined,
        exited: () => this.processExited(slot, process),
      });
      // Shutdown must own the child even before initialize has answered.
      slot.process = process;
      try {
        const response = await process.ready;
        if (this.stopped) throw new Error("ACP host stopped");
        if (this.slots.get(agentId) === slot) {
          const previous = this.reports.find((entry) => entry.agentId === agentId);
          const report = agentReport(slot.definition, response);
          if (previous?.defaults) report.defaults = previous.defaults;
          this.reports = [...this.reports.filter((entry) => entry.agentId !== agentId), report];
        }
        return process;
      } catch (error) {
        if (slot.process === process) slot.process = undefined;
        await process.stop();
        throw error;
      }
    })().finally(() => {
      slot.starting = undefined;
    });
    return slot.starting;
  }

  private processExited(slot: AgentSlot, process: AcpAgentProcess): void {
    if (slot.process === process) slot.process = undefined;
    slot.failures += 1;
    slot.restartAt = Date.now() + Math.min(60_000, 1_000 * 2 ** (slot.failures - 1));
    for (const local of this.sessions.values()) {
      if (local.process !== process) continue;
      local.process = undefined;
      this.cancelInteractions(local.chat);
      // Pending prompt requests reject through the SDK and own their terminal lifecycle.
      if (!local.running) local.binding.status = "idle";
    }
  }

  private onUpdate(process: AcpAgentProcess, notification: SessionNotification): Promise<void> {
    const local = [...this.sessions.values()].find(
      (candidate) =>
        candidate.process === process && candidate.binding.sessionId === notification.sessionId,
    );
    if (!local) {
      // Agents can announce commands/config for a new session before new returns its ID.
      const pending = this.earlyUpdates.get(process) ?? [];
      if (
        pending.length < 64 &&
        utf8Bytes(JSON.stringify(pending)) + utf8Bytes(JSON.stringify(notification)) <= 1024 * 1024
      ) {
        pending.push(notification);
        this.earlyUpdates.set(process, pending);
      }
      return Promise.resolve();
    }
    local.updates = local.updates
      .catch(() => undefined)
      .then(async () => {
        const ops = local.timeline.update(notification.update);
        local.relay.push(ops);
        for (const op of ops) {
          if (op.op !== "session.patch") continue;
          const patch: AcpSessionPatch = {};
          if (op.config) patch.config = op.config;
          if (op.commands) patch.commands = op.commands;
          if (op.info?.title) patch.title = op.info.title;
          if (Object.keys(patch).length) await this.patch(local, patch);
        }
      });
    return local.updates;
  }

  private async ensureSession(local: LocalSession): Promise<LocalSession> {
    const slot = this.slots.get(local.binding.agentId);
    if (!slot) throw new Error("Agent removed");
    if (local.setup) return local.setup;
    if (
      local.process &&
      (local.running || local.process === slot.process) &&
      !local.timeline.needsReload
    )
      return local;
    local.setup = (async () => {
      const process = await this.processFor(local.binding.agentId);
      const report = this.reports.find((entry) => entry.agentId === local.binding.agentId)!;
      const previousId = local.binding.sessionId;
      local.process = process;
      try {
        let response;
        let history: "full" | "resumed" | "none" = "none";
        if (previousId) {
          local.timeline = new AcpTimeline();
          local.relay.stop();
          local.relay = new AcpRelay(this.transport, local.chat, local.timeline);
          if (report.capabilities.loadSession) {
            response = await process.connection.agent.request(methods.agent.session.load, {
              sessionId: previousId,
              cwd: local.binding.cwd,
              mcpServers: [],
            });
            history = "full";
          } else if (report.capabilities.resume) {
            response = await process.connection.agent.request(methods.agent.session.resume, {
              sessionId: previousId,
              cwd: local.binding.cwd,
              mcpServers: [],
            });
            history = "resumed";
            local.timeline.update({
              sessionUpdate: "notice",
              title: "Earlier history is not available from this agent",
              severity: "info",
            });
          } else {
            await this.patch(local, { status: "ended" });
            throw new Error("This agent cannot reopen the session");
          }
        } else {
          const created = await process.connection.agent.request(methods.agent.session.new, {
            cwd: local.binding.cwd,
            mcpServers: [],
          });
          local.binding.sessionId = created.sessionId;
          response = created;
          const pending = this.earlyUpdates.get(process) ?? [];
          this.earlyUpdates.set(
            process,
            pending.filter((notification) => notification.sessionId !== created.sessionId),
          );
          for (const notification of pending)
            if (notification.sessionId === created.sessionId)
              void this.onUpdate(process, notification);
        }
        await local.updates;
        const config = normalizeConfig(response, local.binding.config ?? undefined);
        await this.patch(local, { sessionId: local.binding.sessionId!, config, history });
        if (!previousId) {
          for (const choice of local.binding.draft?.config ?? []) {
            if (
              config.options.find((option) => option.id === choice.configId)?.currentValue ===
              choice.value
            )
              continue;
            const request: SetSessionConfigOptionRequest = {
              sessionId: local.binding.sessionId!,
              configId: choice.configId,
              ...(typeof choice.value === "boolean"
                ? { type: "boolean", value: choice.value }
                : { value: choice.value }),
            };
            const updated = await process.connection.agent.request<
              SetSessionConfigOptionResponse,
              SetSessionConfigOptionRequest
            >(methods.agent.session.setConfigOption, request);
            await this.patch(local, {
              config: normalizeConfig(updated, local.binding.config ?? undefined),
            });
          }
          if (
            local.binding.draft?.modeId &&
            local.binding.config?.modes?.currentModeId !== local.binding.draft.modeId
          ) {
            await this.setMode(local, local.binding.draft.modeId);
          }
          report.defaults = {
            config: local.binding.config ?? config,
            commands: local.timeline.sessionPatch.commands ?? [],
          };
          await this.lifecycle.run("worker", () =>
            this.transport.reportAgents({ agents: this.reports }),
          );
        }
        return local;
      } catch (error) {
        local.process = undefined;
        if (error instanceof RequestError && error.code === -32000) {
          report.status = "needs_auth";
          await this.lifecycle.run("worker", () =>
            this.transport.reportAgents({ agents: this.reports }),
          );
          throw new Error(`Sign in to ${report.name}`);
        }
        throw error;
      }
    })().finally(() => {
      local.setup = undefined;
    });
    return local.setup;
  }

  private async syncWarm(): Promise<void> {
    if (!this.initialized || !this.definitionsReady || !this.available || this.stopped) return;
    await Promise.all(
      [...this.warm.values()].map(async (entry) => {
        const local = this.local(entry.chat, { ...entry, warm: true, draft: null, config: null });
        if (local.relay.active || local.warming || local.binding.status === "ended") return;
        local.binding.warm = true;
        local.warming = (async () => {
          try {
            if (entry.sessionId) await this.ensureSession(local);
            if (!this.warm.has(entry.chat) || this.stopped) return;
            await local.relay.start(Math.max(entry.epoch, local.binding.epoch));
            local.binding.epoch = local.relay.epoch;
          } catch (error) {
            local.binding.warm = false;
            // Viewers wait for a snapshot that never comes unless the failure is reported. An
            // agent that no longer knows the session (-32002) cannot reopen it: the Session ends.
            const message = error instanceof Error ? error.message.slice(0, 400) : String(error);
            const gone = error instanceof RequestError && error.code === -32002;
            await this.patch(
              local,
              gone
                ? { status: "ended", error: `The agent no longer has this session: ${message}` }
                : { error: `Could not open the session: ${message}` },
            ).catch(() => {});
          }
        })().finally(() => {
          local.warming = undefined;
        });
        await local.warming;
      }),
    );
  }

  private async execute(claim: AcpClaim): Promise<void> {
    const payload = claim.payload;
    const local = claim.chat && claim.session ? this.local(claim.chat, claim.session) : undefined;
    try {
      if (this.stopped) throw new Error("Worker stopped before execution");
      if (!this.available) throw new Error("Worker disconnected before execution");
      if (payload.kind === "prompt") {
        if (!local) throw new Error("Session deleted");
        local.preparing = true;
        await this.ensureSession(local);
        if (local.warming) await local.warming;
        if (this.warm.has(local.chat) && !local.relay.active) {
          await local.relay.start(Math.max(local.binding.epoch, local.relay.epoch));
          local.binding.epoch = local.relay.epoch;
        }
        await this.patch(local, { status: "running", error: null });
        local.running = true;
        local.relay.push([
          ...local.timeline.startTurn(claim.command),
          ...local.timeline.user(payload.prompt),
        ]);
        const turn = this.prompt(local, claim);
        this.turns.add(turn);
        void turn.finally(() => this.turns.delete(turn)).catch(() => undefined);
        return;
      }
      if (payload.kind === "cancel") {
        if (local?.process && local.binding.sessionId) {
          await local.process.connection.agent.notify(methods.agent.session.cancel, {
            sessionId: local.binding.sessionId,
          });
        }
        if (local) this.cancelInteractions(local.chat);
      } else if (payload.kind === "set_config") {
        if (!local) throw new Error("Session deleted");
        await this.ensureSession(local);
        const request: SetSessionConfigOptionRequest = {
          sessionId: local.binding.sessionId!,
          configId: payload.configId,
          ...(typeof payload.value === "boolean"
            ? { type: "boolean", value: payload.value }
            : { value: payload.value }),
        };
        const response = await local.process!.connection.agent.request<
          SetSessionConfigOptionResponse,
          SetSessionConfigOptionRequest
        >(methods.agent.session.setConfigOption, request);
        const config = normalizeConfig(response, local.binding.config ?? undefined);
        await this.patch(local, { config });
        local.relay.push([{ op: "session.patch", config }]);
      } else if (payload.kind === "set_mode") {
        if (!local) throw new Error("Session deleted");
        await this.ensureSession(local);
        await this.setMode(local, payload.modeId);
      } else if (payload.kind === "history") {
        if (local && payload.epoch === local.relay.epoch) {
          await this.ensureSession(local);
          if (payload.epoch === local.relay.epoch)
            local.relay.push(local.timeline.history(payload.before, payload.limit), "history");
        }
      } else if (payload.kind === "list") {
        const process = await this.processFor(payload.agentId);
        const response = await process.connection.agent.request(methods.agent.session.list, {
          cwd: payload.cwd,
          ...(payload.cursor ? { cursor: payload.cursor } : {}),
        });
        const page: AcpSessionListPage = {
          sessions: response.sessions.map((session) => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            ...(session.title ? { title: session.title } : {}),
            ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
          })),
          ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
        };
        const result = JSON.stringify(page);
        if (utf8Bytes(result) > ACP_COMMAND_RESULT_BYTES)
          throw new Error("Agent session list exceeds result limit");
        await this.finish(claim, "done", undefined, result);
        return;
      } else if (payload.kind === "authenticate" || payload.kind === "logout") {
        const process = await this.processFor(payload.agentId);
        if (payload.kind === "authenticate")
          await process.connection.agent.request(methods.agent.authenticate, {
            methodId: payload.methodId,
          });
        else await process.connection.agent.request(methods.agent.logout, {});
        const response = await process.connection.agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            elicitation: { form: {}, url: {} },
          },
          clientInfo: { name: "radium-worker", version: "0.1.0" },
        });
        const report = agentReport(this.slots.get(payload.agentId)!.definition, response);
        this.reports = this.reports.map((entry) =>
          entry.agentId === payload.agentId
            ? { ...report, ...(entry.defaults ? { defaults: entry.defaults } : {}) }
            : entry,
        );
        await this.lifecycle.run("worker", () =>
          this.transport.reportAgents({ agents: this.reports }),
        );
      } else if (payload.kind === "fork") {
        if (
          !local ||
          !this.reports.find((entry) => entry.agentId === local.binding.agentId)?.capabilities.fork
        )
          throw new Error("Agent does not support fork");
        await this.ensureSession(local);
        const request: ForkSessionRequest = {
          sessionId: local.binding.sessionId!,
          cwd: local.binding.cwd,
          mcpServers: [],
        };
        const response = await local.process!.connection.agent.request<
          ForkSessionResponse,
          ForkSessionRequest
        >("session/fork", request);
        await this.lifecycle.run(payload.targetChat, () =>
          this.transport.updateSession({
            chat: payload.targetChat,
            patch: {
              sessionId: response.sessionId,
              config: normalizeConfig(response),
              status: "idle",
            },
          }),
        );
      } else if (payload.kind === "close" || payload.kind === "delete") {
        const process = await this.processFor(payload.agentId);
        const capability = this.reports.find((entry) => entry.agentId === payload.agentId)
          ?.capabilities[payload.kind];
        if (capability)
          await process.connection.agent.request(
            payload.kind === "close" ? methods.agent.session.close : methods.agent.session.delete,
            { sessionId: payload.sessionId },
          );
        for (const [chat, session] of this.sessions)
          if (
            session.binding.agentId === payload.agentId &&
            session.binding.sessionId === payload.sessionId
          ) {
            this.cancelInteractions(chat);
            session.relay.stop();
            this.sessions.delete(chat);
          }
      }
      await this.finish(claim, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Agent command failed";
      if (local && payload.kind === "prompt" && local.binding.status !== "ended")
        await this.patch(local, { status: "failed", error: message });
      await this.finish(claim, "failed", message);
    } finally {
      if (local && payload.kind === "prompt") local.preparing = false;
      await this.stopRetiredAgents();
    }
  }

  private async prompt(local: LocalSession, claim: AcpClaim): Promise<void> {
    if (claim.payload.kind !== "prompt") return;
    try {
      const response = await local.process!.connection.agent.request<PromptResponse, PromptRequest>(
        methods.agent.session.prompt,
        { sessionId: local.binding.sessionId!, prompt: claim.payload.prompt },
      );
      await local.updates;
      this.cancelInteractions(local.chat);
      local.relay.push(local.timeline.endTurn(response.stopReason));
      await this.patch(local, {
        status:
          response.stopReason === "end_turn" || response.stopReason === "cancelled"
            ? "idle"
            : "failed",
        stopReason: response.stopReason,
        ...(local.timeline.sessionPatch.usage ? { usage: local.timeline.sessionPatch.usage } : {}),
      });
      await this.finish(claim, "done");
    } catch (error) {
      let message =
        !local.process || local.process.connection.signal.aborted
          ? "Agent process exited"
          : error instanceof Error
            ? error.message.slice(0, 500)
            : "Agent prompt failed";
      if (error instanceof RequestError && error.code === -32000) {
        const report = this.reports.find((entry) => entry.agentId === local.binding.agentId)!;
        report.status = "needs_auth";
        message = `Sign in to ${report.name}`;
        await this.lifecycle.run("worker", () =>
          this.transport.reportAgents({ agents: this.reports }),
        );
      }
      await local.updates.catch(() => undefined);
      this.cancelInteractions(local.chat);
      local.relay.push(local.timeline.endTurn(undefined, message));
      await this.patch(local, { status: "failed", error: message });
      await this.finish(claim, "failed", message);
    } finally {
      local.running = false;
      const slot = this.slots.get(local.binding.agentId);
      if (slot) {
        slot.lastUsed = Date.now();
        if (local.process) slot.failures = 0;
      }
      await this.stopRetiredAgents();
    }
  }

  private async setMode(local: LocalSession, modeId: string): Promise<void> {
    await local.process!.connection.agent.request(methods.agent.session.setMode, {
      sessionId: local.binding.sessionId!,
      modeId,
    });
    await local.updates;
    const previous = local.binding.config;
    if (previous?.modes) {
      const config = { ...previous, modes: { ...previous.modes, currentModeId: modeId } };
      await this.patch(local, { config });
      local.relay.push([{ op: "session.patch", config }]);
    }
  }

  private finish(
    claim: AcpClaim,
    status: "done" | "failed",
    error?: string,
    result?: string,
  ): Promise<unknown> {
    return this.lifecycle.run(claim.chat ?? "worker", () =>
      this.transport.finishCommand({
        command: claim.command,
        status,
        ...(error ? { error } : {}),
        ...(result !== undefined ? { result } : {}),
      }),
    );
  }

  private sessionFor(process: AcpAgentProcess, sessionId: string): LocalSession | undefined {
    return [...this.sessions.values()].find(
      (session) =>
        session.process === process && session.binding.sessionId === sessionId && session.running,
    );
  }

  private async ask(
    local: LocalSession,
    request: AcpInteractionRequest,
  ): Promise<AcpInteractionAnswer | null> {
    if (utf8Bytes(JSON.stringify(request)) > ACP_INTERACTION_REQUEST_BYTES) return null;
    const requestKey = crypto.randomUUID();
    const answer = Promise.withResolvers<AcpInteractionAnswer | null>();
    this.interactions.set(requestKey, { chat: local.chat, resolve: answer.resolve });
    try {
      const opened = this.lifecycle.run(local.chat, () =>
        this.transport.openInteraction({ chat: local.chat, requestKey, request }),
      );
      void opened.catch(() => answer.resolve(null));
      const decision = await answer.promise;
      // Cancellation must reach the agent even if durable delivery is currently offline.
      // The queued open retains its idempotency key; resolution follows it when delivered.
      void opened
        .then((interaction) =>
          this.lifecycle.run(local.chat, () =>
            this.transport.resolveInteraction({
              interaction,
              status: decision ? "resolved" : "cancelled",
            }),
          ),
        )
        .catch(() => undefined);
      return decision;
    } finally {
      this.interactions.delete(requestKey);
    }
  }

  private async permission(
    process: AcpAgentProcess,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const local = this.sessionFor(process, request.sessionId);
    if (!local) return { outcome: { outcome: "cancelled" } };
    const tool = request.toolCall;
    const normalized: AcpInteractionRequest = {
      kind: "permission",
      toolCallId: tool.toolCallId,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.kind ? { toolKind: tool.kind } : {}),
      ...(tool.locations
        ? {
            locations: tool.locations.map((location) => ({
              path: location.path,
              ...(location.line != null ? { line: location.line } : {}),
            })),
          }
        : {}),
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    };
    // Permission previews retain only text, diffs and references, never binary payloads.
    if (tool.content) {
      const content = normalizeToolContent(tool.content);
      while (
        content.length &&
        utf8Bytes(JSON.stringify({ ...normalized, content: JSON.stringify(content) })) >
          ACP_INTERACTION_REQUEST_BYTES
      )
        content.pop();
      normalized.content = JSON.stringify(content);
    }
    const answer = await this.ask(local, normalized);
    if (answer?.kind === "permission")
      return { outcome: { outcome: "selected", optionId: answer.optionId } };
    return { outcome: { outcome: "cancelled" } };
  }

  private async elicitation(
    process: AcpAgentProcess,
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (!("sessionId" in request) || typeof request.sessionId !== "string")
      return { action: "cancel" };
    const local = this.sessionFor(process, request.sessionId);
    if (!local) return { action: "cancel" };
    const normalized = normalizeElicitation(request);
    if (!normalized) return { action: "decline" };
    const answer = await this.ask(local, normalized);
    if (answer?.kind !== "elicitation") return { action: "cancel" };
    return answer.action === "accept"
      ? {
          action: "accept",
          content: Object.fromEntries(answer.content.map((entry) => [entry.name, entry.value])),
        }
      : { action: answer.action };
  }

  private cancelInteractions(chat: string): void {
    for (const pending of this.interactions.values())
      if (pending.chat === chat) pending.resolve(null);
  }

  private async stopIdleAgents(): Promise<void> {
    for (const slot of this.slots.values()) {
      if (!slot.process || Date.now() - slot.lastUsed < 15 * 60_000) continue;
      const sessions = [...this.sessions.values()].filter(
        (local) => local.process === slot.process,
      );
      if (sessions.some((local) => local.running)) continue;
      await this.stopAgent(slot);
      for (const local of sessions)
        if (!this.warm.has(local.chat)) {
          local.relay.stop();
          this.sessions.delete(local.chat);
        }
    }
  }

  private stopAgent(slot: AgentSlot): Promise<void> {
    if (slot.stopping) return slot.stopping;
    const process = slot.process;
    if (!process) return Promise.resolve();
    slot.process = undefined;
    slot.stopping = (async () => {
      const closes = [...this.sessions.values()]
        .filter((local) => local.process === process)
        .map(async (local) => {
          local.process = undefined;
          this.cancelInteractions(local.chat);
          if (
            this.reports.find((entry) => entry.agentId === slot.definition.agentId)?.capabilities
              .close &&
            local.binding.sessionId
          ) {
            await process.connection.agent
              .request(methods.agent.session.close, { sessionId: local.binding.sessionId })
              .catch(() => undefined);
          }
        });
      const deadline = Promise.withResolvers<void>();
      const timer = setTimeout(deadline.resolve, 1_000);
      await Promise.race([Promise.allSettled(closes), deadline.promise]);
      clearTimeout(timer);
      await process.stop();
    })().finally(() => {
      slot.stopping = undefined;
    });
    return slot.stopping;
  }

  /** Stop claims, cancel agent requests, close sessions/processes and bound receipt flushing. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.retry);
    clearInterval(this.idle);
    this.abort.abort();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const pending of this.interactions.values()) pending.resolve(null);
    const slots = [...this.slots.values(), ...this.retired];
    await Promise.all(slots.map((slot) => this.stopAgent(slot)));
    await Promise.all(
      slots.map(async (slot) => {
        await slot.starting?.catch(() => undefined);
        if (slot.process) await this.stopAgent(slot);
      }),
    );
    for (const local of this.sessions.values()) local.relay.stop();
    await this.lifecycle.close();
    await Promise.allSettled([...this.commandTails.values(), ...this.turns]);
  }
}
