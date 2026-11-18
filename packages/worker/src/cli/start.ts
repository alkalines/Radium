import { watch, type FSWatcher } from "node:fs";
import { recoverPendingIdentity } from "../auth/enrollment.js";
import { readWorkerState } from "../auth/state.js";
import { createGatewayKeyStore } from "../auth/gateway.js";
import {
  connectWorkerControl,
  type WorkerControlConnection,
  type WorkerControlDisconnectReason,
  type WorkerControlStatus,
} from "../control.js";
import { WorkerProtocolError } from "../protocol.js";
import { consumeEditTasks, type EditExecutor } from "../tasks.js";
import { WorkerDirectoryEdits } from "../edit/directories.js";
import { createBashExecutor } from "../bash/service.js";
import { prepareTempDirectory, startPresenceReporter, type PresenceReporter } from "../presence.js";
import type { CliOptions } from "./options.js";
import { storageDescription } from "./prompt.js";
import { convexAcpTransport } from "../acp/convex-transport.js";
import { AcpHost } from "../acp/host.js";
import {
  convexLocalUsageTransport,
  startLocalUsageSync,
  type LocalUsageSync,
} from "../usage/local-usage.js";
import { convexTrustTransport, WorkerTrust } from "../e2ee/trust.js";

const DISCONNECT_GUIDANCE: Record<WorkerControlDisconnectReason, string> = {
  connecting: "Opening the Convex connection.",
  token_http_failed:
    "Could not obtain a machine token from the configured backend. Check backend availability and run `refresh` to test token issuance.",
  verifier_auth_rejected:
    "Convex rejected the issued machine token. Check that the backend issuer, Convex JWT verifier issuer/audience, and signing keys agree; `refresh` tests issuance only.",
  identity_unavailable:
    "Convex did not return an active Worker matching this local identity. Check the Worker status in Chatroom → Workers; `status` and `refresh` inspect local state and token issuance.",
  transport:
    "The Convex WebSocket is disconnected. Check the configured Convex URL and network, proxy, or firewall connectivity.",
  shutdown: "The Worker control connection has stopped.",
};

/** Recover local enrollment before opening the authenticated outbound control client. */
export async function startWorker(options: CliOptions): Promise<void> {
  let state = await readWorkerState(options.stateDirectory);
  if (!state) throw new WorkerProtocolError("Worker is not configured; run setup first");

  state = await recoverPendingIdentity(options.stateDirectory, state);
  // A v2 enrollment must never fall back to the legacy plaintext consumer after an interrupted
  // pairing; the pairing secret is intentionally not persisted for automatic recovery.
  if (state.setup.version === 2 && !state.e2ee) {
    throw new WorkerProtocolError(
      "Encrypted Worker setup is incomplete; create a pairing code and run `radium-worker pair`",
    );
  }
  console.info(storageDescription(state.credentialStoreMode));

  let control: WorkerControlConnection | undefined;
  let editor: EditExecutor | undefined;
  let tasks: ReturnType<typeof consumeEditTasks> | undefined;
  let bash: ReturnType<typeof createBashExecutor> | undefined;
  let diagnosticsTimer: ReturnType<typeof setInterval> | undefined;
  let presence: PresenceReporter | undefined;
  let acp: AcpHost | undefined;
  let localUsage: LocalUsageSync | undefined;
  let trust: WorkerTrust | null = null;
  const close = async () => {
    clearInterval(diagnosticsTimer);
    presence?.close();
    trust?.close();
    localUsage?.close();
    try {
      await acp?.close();
      if (tasks) await tasks.close();
      else {
        await bash?.close();
        await editor?.close();
      }
    } finally {
      await control?.close();
    }
  };
  try {
    editor = new WorkerDirectoryEdits();
    bash = createBashExecutor();
    const tempDirectory = await prepareTempDirectory();
    let previousStatusKey: string | undefined;
    control = connectWorkerControl(state, (status) => {
      tasks?.setAvailable(status.status === "connected");
      presence?.setAvailable(status.status === "connected");
      acp?.setAvailable(status.status === "connected");
      localUsage?.setAvailable(status.status === "connected");
      const statusKey =
        status.status === "connected" ? "connected" : `disconnected:${status.reason}`;
      if (previousStatusKey === statusKey) return;
      previousStatusKey = statusKey;
      console.info(formatControlStatus(status));
    });
    presence = startPresenceReporter(control.client, tempDirectory);
    // Paired Workers verify every command against the pinned owner; unpaired ones stay plaintext.
    const client = control.client;
    trust = await WorkerTrust.open({
      stateDirectory: options.stateDirectory,
      state,
      transport: () => convexTrustTransport(client),
    });
    console.info(
      trust
        ? "End-to-end encryption: paired; commands must be signed by workspace members."
        : "End-to-end encryption: not paired; this Worker only serves workspaces without keys.",
    );
    // Report an owner-key change, rollback or missing certification at startup (fixed messages).
    void trust?.roster().catch(() => undefined);
    presence.setAvailable(previousStatusKey === "connected");
    diagnosticsTimer = setInterval(() => {
      if (!control || previousStatusKey === "connected") return;
      const diagnostics = control.diagnostics();
      console.info(
        `Worker connection pending: socket=${diagnostics.socketConnected ? "open" : "closed"}, auth=${diagnostics.authenticated ? "accepted" : "pending"}, identity=${diagnostics.identityAvailable ? "available" : "pending"}, tokenExchange=${diagnostics.tokenExchangePending ? "pending" : "idle"}, socketRetries=${diagnostics.connectionRetries}.`,
      );
    }, 15_000);
    if (editor) {
      tasks = consumeEditTasks(control.client, editor, bash, trust);
      tasks.setAvailable(previousStatusKey === "connected");
      console.info("Worker edit and Bash task consumer enabled.");
    }
    acp = new AcpHost(
      convexAcpTransport(control.client),
      {
        gateway: {
          url: `${state.setup.backendUrl}/api/openai/v1`,
          keys: createGatewayKeyStore(options.stateDirectory),
        },
      },
      trust,
    );
    acp.setAvailable(previousStatusKey === "connected");
    localUsage = startLocalUsageSync(convexLocalUsageTransport(control.client));
    localUsage.setAvailable(previousStatusKey === "connected");
    // An unpaired Worker cannot serve a workspace that has keys, and `pair` runs as a separate
    // command. Reopen in signed mode once pairing lands, so the stale plaintext host stops.
    const reason = await waitForShutdown(close, trust ? undefined : pairingCompleted(options));
    if (reason === "paired") {
      console.info("Worker paired; restarting with end-to-end encryption.");
      await startWorker(options);
    }
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

function formatControlStatus(status: WorkerControlStatus): string {
  if (status.status === "connected") return "Worker control connected.";
  if (status.reason === "connecting") return "Worker control connecting.";
  return `Worker control disconnected (${status.reason}). ${DISCONNECT_GUIDANCE[status.reason]}`;
}

/**
 * Resolves once the state file on disk gains E2EE keys (`radium-worker pair` finished). `cancel`
 * stops watching.
 */
function pairingCompleted(options: CliOptions): { done: Promise<void>; cancel: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  let checking = false;
  let dirty = false;
  const check = () => {
    if (checking) {
      dirty = true;
      return;
    }
    checking = true;
    dirty = false;
    readWorkerState(options.stateDirectory, { skipE2eeKeys: true })
      .then((next) => {
        if (next?.e2ee) resolve();
      })
      // A partially written state file is re-read on its next change event.
      .catch(() => undefined)
      .finally(() => {
        checking = false;
        if (dirty) check();
      });
  };
  let watcher: FSWatcher;
  try {
    watcher = watch(options.stateDirectory, check);
  } catch {
    // No state directory to watch means no pairing can land in it either.
    return { done: promise, cancel: () => undefined };
  }
  // Losing the watch only loses the automatic restart; `pair` still tells the user to restart.
  watcher.on("error", () => watcher.close());
  void promise.finally(() => watcher.close());
  return { done: promise, cancel: () => watcher.close() };
}

/**
 * Close the same connection once and detach both signal handlers before awaiting it. Resolves
 * with what stopped the Worker: a signal, or completed pairing when `paired` is given.
 */
function waitForShutdown(
  close: () => Promise<void>,
  paired?: { done: Promise<void>; cancel: () => void },
): Promise<"signal" | "paired"> {
  const { promise, resolve, reject } = Promise.withResolvers<"signal" | "paired">();
  let stopping = false;
  const stop = (reason: "signal" | "paired") => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    paired?.cancel();
    void close().then(() => resolve(reason), reject);
  };
  const onSignal = () => stop("signal");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  void paired?.done.then(() => stop("paired"));
  return promise;
}
