import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

/** Launch options for the real stdio ACP fixture; the store also persists authentication. */
export interface ScriptedAgentOptions {
  store?: string;
  /** Gate session creation before a prompt keyword can be inspected. */
  requireAuth?: boolean;
}

interface StoredSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  transcript: SessionUpdate[];
  configOptions: SessionConfigOption[];
  modes: SessionModeState;
}

interface StoredState {
  version: 1;
  authenticated: boolean;
  sessions: StoredSession[];
}

// Session cancellation must finish even when the client never answers an interaction.
function untilCancelled<T>(request: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
  const cancelled = () => resolve(undefined);
  if (signal.aborted) {
    resolve(undefined);
  } else {
    signal.addEventListener("abort", cancelled, { once: true });
  }
  request.then(
    (answer) => {
      signal.removeEventListener("abort", cancelled);
      resolve(answer);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", cancelled);
      if (signal.aborted) resolve(undefined);
      else reject(error);
    },
  );
  return promise;
}

/**
 * Serve the scripted agent over stdin/stdout until the client disconnects.
 * stdout belongs exclusively to SDK JSON-RPC. With a store, every transcript
 * update and config/auth mutation is atomically persisted before it is acknowledged.
 * `--require-auth` exercises auth_required during session/new; the `auth` prompt
 * keyword exercises the same failure during a turn when authentication is absent.
 */
export async function runScriptedAgent(options: ScriptedAgentOptions = {}): Promise<void> {
  let state: StoredState = { version: 1, authenticated: false, sessions: [] };
  if (options.store) {
    try {
      state = JSON.parse(readFileSync(options.store, "utf8")) as StoredState;
      if (state.version !== 1 || !Array.isArray(state.sessions)) {
        throw new Error("Unsupported scripted agent store");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const sessions = new Map(state.sessions.map((session) => [session.id, session]));
  const activeSessions = new Set<string>();
  const turns = new Map<string, AbortController>();

  function persist(): void {
    if (!options.store) return;
    state.sessions = [...sessions.values()];
    mkdirSync(dirname(options.store), { recursive: true });
    const temporary = `${options.store}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, options.store);
  }

  function requireAuthentication(): void {
    if (options.requireAuth && !state.authenticated) throw RequestError.authRequired();
  }

  function getSession(id: string, active = true): StoredSession {
    requireAuthentication();
    const session = sessions.get(id);
    if (!session || (active && !activeSessions.has(id))) throw RequestError.sessionNotFound(id);
    return session;
  }

  async function emit(
    client: AgentContext,
    session: StoredSession,
    update: SessionUpdate,
  ): Promise<void> {
    session.transcript.push(update);
    session.updatedAt = new Date().toISOString();
    persist();
    await client.notify(methods.client.session.update, { sessionId: session.id, update });
  }

  async function announce(client: AgentContext, session: StoredSession): Promise<void> {
    await client.notify(methods.client.session.update, {
      sessionId: session.id,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "help",
            description: "Keywords: permission, question, link, slow, refuse, crash, auth",
          },
        ],
      },
    });
  }

  const app = agent({ name: "radium-scripted-agent" });
  app.onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "radium-scripted-agent", title: "Scripted ACP Agent", version: "1.0.0" },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
      auth: { logout: {} },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    // Stable ACP uses an absent `type` for agent-handled authentication.
    authMethods: [{ id: "scripted", name: "Scripted sign in" }],
  }));

  app.onRequest(methods.agent.authenticate, ({ params }) => {
    if (params.methodId !== "scripted") throw RequestError.invalidParams("Unknown auth method");
    state.authenticated = true;
    persist();
    return {};
  });
  app.onRequest(methods.agent.logout, () => {
    state.authenticated = false;
    persist();
    return {};
  });

  app.onRequest(methods.agent.session.new, async ({ params, client }) => {
    requireAuthentication();
    if (!isAbsolute(params.cwd)) throw RequestError.invalidParams("cwd must be absolute");
    const session: StoredSession = {
      id: randomUUID(),
      cwd: params.cwd,
      title: "Scripted session",
      updatedAt: new Date().toISOString(),
      transcript: [],
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "scripted-small",
          options: [
            { value: "scripted-small", name: "Scripted Small" },
            { value: "scripted-large", name: "Scripted Large" },
          ],
        },
        {
          id: "thought_level",
          name: "Thought level",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code", description: "Execute the scripted turn" },
          { id: "plan", name: "Plan", description: "Plan the scripted turn" },
        ],
      },
    };
    sessions.set(session.id, session);
    activeSessions.add(session.id);
    persist();
    await announce(client, session);
    return { sessionId: session.id, configOptions: session.configOptions, modes: session.modes };
  });

  app.onRequest(methods.agent.session.load, async ({ params, client }) => {
    const session = getSession(params.sessionId, false);
    if (turns.has(session.id)) throw RequestError.invalidRequest("Session is running");
    if (params.cwd !== session.cwd) throw RequestError.invalidParams("Session cwd does not match");
    activeSessions.add(session.id);
    for (const update of session.transcript) {
      await client.notify(methods.client.session.update, { sessionId: session.id, update });
    }
    await announce(client, session);
    return { configOptions: session.configOptions, modes: session.modes };
  });

  app.onRequest(methods.agent.session.resume, async ({ params, client }) => {
    const session = getSession(params.sessionId, false);
    if (turns.has(session.id)) throw RequestError.invalidRequest("Session is running");
    if (params.cwd !== session.cwd) throw RequestError.invalidParams("Session cwd does not match");
    activeSessions.add(session.id);
    await announce(client, session);
    return { configOptions: session.configOptions, modes: session.modes };
  });

  app.onRequest(methods.agent.session.list, ({ params }) => {
    requireAuthentication();
    const cursor = params.cursor ?? "0";
    if (!/^\d+$/.test(cursor)) throw RequestError.invalidParams("Invalid session cursor");
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset)) throw RequestError.invalidParams("Invalid session cursor");
    const matching = [...sessions.values()]
      .filter((session) => params.cwd == null || session.cwd === params.cwd)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return {
      sessions: matching.slice(offset, offset + 2).map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
      ...(offset + 2 < matching.length ? { nextCursor: String(offset + 2) } : {}),
    };
  });

  app.onRequest(methods.agent.session.close, ({ params }) => {
    turns.get(params.sessionId)?.abort();
    activeSessions.delete(params.sessionId);
    return {};
  });
  app.onRequest(methods.agent.session.delete, ({ params }) => {
    turns.get(params.sessionId)?.abort();
    activeSessions.delete(params.sessionId);
    sessions.delete(params.sessionId);
    persist();
    return {};
  });

  app.onRequest(methods.agent.session.setMode, async ({ params, client }) => {
    const session = getSession(params.sessionId);
    if (!session.modes.availableModes.some((mode) => mode.id === params.modeId)) {
      throw RequestError.invalidParams("Unknown mode");
    }
    session.modes.currentModeId = params.modeId;
    await emit(client, session, {
      sessionUpdate: "current_mode_update",
      currentModeId: params.modeId,
    });
    return {};
  });
  app.onRequest(methods.agent.session.setConfigOption, async ({ params, client }) => {
    const session = getSession(params.sessionId);
    const option = session.configOptions.find((candidate) => candidate.id === params.configId);
    if (!option || option.type !== "select" || typeof params.value !== "string") {
      throw RequestError.invalidParams("Unknown config option or invalid value");
    }
    const allowed = option.options.some((choice) =>
      "value" in choice
        ? choice.value === params.value
        : choice.options.some((value) => value.value === params.value),
    );
    if (!allowed) throw RequestError.invalidParams("Unknown config value");
    option.currentValue = params.value;
    await emit(client, session, {
      sessionUpdate: "config_option_update",
      configOptions: structuredClone(session.configOptions),
    });
    return { configOptions: session.configOptions };
  });

  app.onNotification(methods.agent.session.cancel, ({ params }) => {
    turns.get(params.sessionId)?.abort();
  });

  app.onRequest(methods.agent.session.prompt, async ({ params, client, signal: requestSignal }) => {
    const session = getSession(params.sessionId);
    if (turns.has(session.id)) throw RequestError.invalidRequest("Session is running");
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    const keywords = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
    if (keywords.has("auth") && !state.authenticated) throw RequestError.authRequired();

    const turn = new AbortController();
    const signal = AbortSignal.any([turn.signal, requestSignal]);
    turns.set(session.id, turn);
    const messageId = randomUUID();
    const say = (text: string) =>
      emit(client, session, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      });
    try {
      // Prompts belong in the agent's replay, but the client already has the live user item.
      for (const content of params.prompt) {
        session.transcript.push({
          sessionUpdate: "user_message_chunk",
          messageId: `user:${messageId}`,
          content,
        });
      }
      session.updatedAt = new Date().toISOString();
      persist();
      await emit(client, session, {
        sessionUpdate: "agent_thought_chunk",
        messageId: `thought:${messageId}`,
        content: { type: "text", text: "Thinking through the scripted request.\n" },
      });
      if (signal.aborted) return { stopReason: "cancelled" };
      if (keywords.has("crash")) {
        await say("The scripted agent is about to crash.\n");
        process.exit(1);
      }
      if (keywords.has("refuse")) {
        await say("I refuse this scripted request.\n");
        return { stopReason: "refusal" };
      }
      if (keywords.has("slow")) {
        let chunk = 0;
        while (!signal.aborted) {
          await say(`Slow chunk ${++chunk}.\n`);
          await delay(100, undefined, { signal });
        }
        return { stopReason: "cancelled" };
      }

      if (keywords.has("permission")) {
        const toolCallId = `permission:${messageId}`;
        await emit(client, session, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Read with permission",
          kind: "read",
          status: "pending",
        });
        const answer = await untilCancelled(
          client.request(
            methods.client.session.requestPermission,
            {
              sessionId: session.id,
              toolCall: {
                toolCallId,
                title: "Read with permission",
                kind: "read",
                status: "pending",
              },
              options: [
                { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
                { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
              ],
            },
            { cancellationSignal: signal },
          ),
          signal,
        );
        if (signal.aborted || !answer || answer.outcome.outcome === "cancelled")
          return { stopReason: "cancelled" };
        await say(`Permission selected: ${answer.outcome.optionId}\n`);
        await emit(client, session, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: answer.outcome.optionId === "allow_once" ? "completed" : "failed",
        });
      }
      if (keywords.has("question")) {
        const answer = await untilCancelled(
          client.request(
            methods.client.elicitation.create,
            {
              mode: "form",
              sessionId: session.id,
              message: "Choose a color and whether to continue.",
              requestedSchema: {
                type: "object",
                properties: {
                  color: { type: "string", title: "Color", enum: ["red", "blue"] },
                  confirm: { type: "boolean", title: "Continue?", default: true },
                },
                required: ["color", "confirm"],
              },
            },
            { cancellationSignal: signal },
          ),
          signal,
        );
        if (signal.aborted || !answer || answer.action === "cancel")
          return { stopReason: "cancelled" };
        await say(`Question answer: ${JSON.stringify(answer)}\n`);
      }
      if (keywords.has("link")) {
        const elicitationId = `link:${messageId}`;
        const answer = await untilCancelled(
          client.request(
            methods.client.elicitation.create,
            {
              mode: "url",
              sessionId: session.id,
              elicitationId,
              message: "Open the scripted agent link?",
              url: "https://example.com/acp-scripted-agent",
            },
            { cancellationSignal: signal },
          ),
          signal,
        );
        if (signal.aborted || !answer || answer.action === "cancel")
          return { stopReason: "cancelled" };
        await say(`Link answer: ${answer.action}\n`);
        if (answer.action === "accept") {
          await client.notify(methods.client.elicitation.complete, { elicitationId });
        }
      }
      if (signal.aborted) return { stopReason: "cancelled" };
      await say("Hello from the scripted ");
      await say("ACP agent.\n");
      const toolCallId = `read:${messageId}`;
      const path = join(session.cwd, "scripted.txt");
      await emit(client, session, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Read scripted.txt",
        name: "read",
        kind: "read",
        status: "pending",
        locations: [{ path, line: 1 }],
        rawInput: { path },
      });
      await emit(client, session, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
      });
      await emit(client, session, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "Scripted file contents.\n" } },
        ],
        rawOutput: { text: "Scripted file contents.\n" },
      });
      await emit(client, session, {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the scripted file", priority: "high", status: "completed" },
          { content: "Report the result", priority: "medium", status: "completed" },
        ],
      });
      await emit(client, session, {
        sessionUpdate: "usage_update",
        used: session.transcript.length * 10,
        size: 32000,
        cost: { amount: 0.001, currency: "USD" },
      });
      session.title = `Scripted: ${text.replace(/\s+/g, " ").trim().slice(0, 60) || "Resource prompt"}`;
      await emit(client, session, {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: new Date().toISOString(),
      });
      return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      turns.delete(session.id);
      persist();
    }
  });

  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      // Node and Bun declare incompatible BYOB overloads for the same Web Streams runtime.
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  );
  await connection.closed;
  for (const turn of turns.values()) turn.abort();
}

function parseOptions(args: string[]): ScriptedAgentOptions {
  const options: ScriptedAgentOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--require-auth") {
      options.requireAuth = true;
    } else if (argument === "--store") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--store requires a file path");
      options.store = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

if (import.meta.main) {
  runScriptedAgent(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
