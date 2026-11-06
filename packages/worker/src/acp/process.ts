import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type InitializeResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import {
  acpAgentDefinitionError,
  type AcpAgentDefinition,
  type AcpAgentReport,
} from "backend/src/acp/contract";
import { agentEnvironment, resolveAgentCommand } from "./config.js";

/** Local protocol callbacks; raw requests never cross the Convex boundary. */
export interface AcpProcessHandlers {
  update(notification: SessionNotification): void | Promise<void>;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  elicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  elicitationComplete?(notification: unknown): void | Promise<void>;
  /** The connection is gone (child exit or protocol close); the child may still be exiting. */
  exited(): void;
}

/** Own one stdio SDK connection and a bounded local-only stderr diagnostic ring. */
export class AcpAgentProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: ClientConnection;
  readonly ready: Promise<InitializeResponse>;
  private stderr = Buffer.alloc(0);
  private stopping = false;
  private childEnded = false;
  private readonly exited = Promise.withResolvers<void>();
  private terminating?: Promise<void>;

  constructor(
    definition: AcpAgentDefinition,
    command: string,
    handlers: AcpProcessHandlers,
    environment: NodeJS.ProcessEnv = agentEnvironment(definition),
  ) {
    this.child = spawn(command, definition.args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const app = client({ name: "radium-worker" })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        handlers.permission(params),
      )
      .onRequest(methods.client.elicitation.create, ({ params }) => handlers.elicitation(params))
      .onNotification(methods.client.session.update, ({ params }) => handlers.update(params))
      .onNotification(methods.client.elicitation.complete, ({ params }) =>
        handlers.elicitationComplete?.(params),
      );
    this.connection = app.connect(
      ndJsonStream(
        Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
        // Node and Bun declare incompatible BYOB overloads for the same Web Streams runtime.
        Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]);
      if (this.stderr.length > 64 * 1024)
        this.stderr = Buffer.from(this.stderr.subarray(-64 * 1024));
    });
    const failed = Promise.withResolvers<never>();
    let disconnected = false;
    const disconnect = (error: Error) => {
      if (disconnected) return;
      disconnected = true;
      failed.reject(error);
      if (!this.stopping) handlers.exited();
    };
    const onExit = (error?: Error) => {
      if (this.childEnded) return;
      this.childEnded = true;
      this.exited.resolve();
      this.connection.close(new Error("Agent process exited"));
      disconnect(error ?? new Error("Agent process exited"));
    };
    this.child.once("error", onExit);
    this.child.once("exit", () => onExit());
    // A closed or failed connection makes the child unusable: terminate it, but `stop()` still
    // waits for the real child exit (with SIGKILL escalation).
    void this.connection.closed
      .catch(() => undefined)
      .then(() => {
        disconnect(new Error("Agent connection closed"));
        void this.terminate();
      });
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => timeout.reject(new Error("Agent initialization timed out")),
      15_000,
    );
    this.ready = Promise.race([
      this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {}, url: {} },
        },
        clientInfo: { name: "radium-worker", version: "0.1.0" },
      }),
      failed.promise,
      timeout.promise,
    ])
      .then((response) => {
        if (response.protocolVersion !== PROTOCOL_VERSION)
          throw new Error("Unsupported ACP protocol version");
        return response;
      })
      .finally(() => clearTimeout(timer));
  }

  /** Read diagnostics locally; callers must never relay this text to Convex or chat output. */
  diagnostics(): string {
    return this.stderr.toString("utf8");
  }

  /** Terminate once, escalating to SIGKILL after five seconds. Sessions are closed by the host. */
  stop(): Promise<void> {
    this.stopping = true;
    this.connection.close();
    return this.terminate();
  }

  private terminate(): Promise<void> {
    this.terminating ??= (async () => {
      if (
        this.childEnded ||
        this.child.exitCode !== null ||
        this.child.signalCode !== null ||
        !this.child.pid
      )
        return;
      this.child.kill("SIGTERM");
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
      await this.exited.promise;
      clearTimeout(timer);
    })();
    return this.terminating;
  }
}

/** Normalize advertised capabilities into the shared catalog, absent capabilities are false. */
export function agentReport(
  definition: AcpAgentDefinition,
  response?: InitializeResponse,
): AcpAgentReport {
  const capabilities = response?.agentCapabilities;
  const session = capabilities?.sessionCapabilities;
  return {
    agentId: definition.agentId,
    name: definition.name,
    version: response?.agentInfo?.version ?? definition.version ?? "unknown",
    source: definition.source,
    ...(definition.icon ? { icon: definition.icon } : {}),
    status: "ready",
    capabilities: {
      loadSession: capabilities?.loadSession ?? false,
      list: Boolean(session?.list),
      resume: Boolean(session?.resume),
      close: Boolean(session?.close),
      delete: Boolean(session?.delete),
      fork: Boolean(session && "fork" in session && session.fork),
      logout: Boolean(capabilities?.auth?.logout),
      image: capabilities?.promptCapabilities?.image ?? false,
      audio: capabilities?.promptCapabilities?.audio ?? false,
      embeddedContext: capabilities?.promptCapabilities?.embeddedContext ?? false,
      mcpHttp: capabilities?.mcpCapabilities?.http ?? false,
      mcpSse: capabilities?.mcpCapabilities?.sse ?? false,
    },
    authMethods: (response?.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      type: "type" in method && method.type === "terminal" ? "terminal" : "agent",
      ...(method.description ? { description: method.description } : {}),
    })),
  };
}

/** Probe locally without leaving a long-lived agent running or contacting Convex. */
export async function probeAgent(
  definition: AcpAgentDefinition,
  signal?: AbortSignal,
): Promise<AcpAgentReport> {
  const report = agentReport(definition);
  const invalid = acpAgentDefinitionError(definition);
  if (invalid) return { ...report, status: "failed", error: invalid };
  const command = await resolveAgentCommand(definition.command);
  if (!command)
    return {
      ...report,
      status: "unavailable",
      error: `${definition.command} was not found on this Worker's PATH`,
    };
  if (signal?.aborted) return { ...report, status: "failed", error: "ACP host stopped" };
  const process = new AcpAgentProcess(definition, command, {
    update: () => undefined,
    exited: () => undefined,
    permission: async () => ({ outcome: { outcome: "cancelled" } }),
    elicitation: async () => ({ action: "cancel" }),
  });
  const abort = () => {
    void process.stop();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return agentReport(definition, await process.ready);
  } catch {
    return { ...report, status: "failed", error: "Agent initialization failed" };
  } finally {
    signal?.removeEventListener("abort", abort);
    await process.stop();
  }
}
