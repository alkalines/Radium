import { recoverPendingIdentity } from "../auth/enrollment.js";
import { readWorkerState } from "../auth/state.js";
import {
  connectWorkerControl,
  type WorkerControlConnection,
  type WorkerControlDisconnectReason,
  type WorkerControlStatus,
} from "../control.js";
import { WorkerProtocolError } from "../protocol.js";
import { consumeEditTasks, type EditExecutor } from "../tasks.js";
import { WorkerDirectoryEdits } from "../edit/directories.js";
import type { CliOptions } from "./options.js";
import { storageDescription } from "./prompt.js";

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
  console.info(storageDescription(state.credentialStoreMode));

  let control: WorkerControlConnection | undefined;
  let editor: EditExecutor | undefined;
  let tasks: ReturnType<typeof consumeEditTasks> | undefined;
  let diagnosticsTimer: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    if (diagnosticsTimer) clearInterval(diagnosticsTimer);
    try {
      if (tasks) await tasks.close();
      else await editor?.close();
    } finally {
      await control?.close();
    }
  };
  try {
    editor = new WorkerDirectoryEdits();
    let previousStatusKey: string | undefined;
    control = connectWorkerControl(state, (status) => {
      tasks?.setAvailable(status.status === "connected");
      const statusKey =
        status.status === "connected" ? "connected" : `disconnected:${status.reason}`;
      if (previousStatusKey === statusKey) return;
      previousStatusKey = statusKey;
      console.info(formatControlStatus(status));
    });
    diagnosticsTimer = setInterval(() => {
      if (!control || previousStatusKey === "connected") return;
      const state = control.diagnostics();
      console.info(
        `Worker connection pending: socket=${state.socketConnected ? "open" : "closed"}, auth=${state.authenticated ? "accepted" : "pending"}, identity=${state.identityAvailable ? "available" : "pending"}, tokenExchange=${state.tokenExchangePending ? "pending" : "idle"}, socketRetries=${state.connectionRetries}.`,
      );
    }, 15_000);
    if (editor) {
      tasks = consumeEditTasks(control.client, editor);
      tasks.setAvailable(previousStatusKey === "connected");
      console.info("Worker edit task consumer enabled.");
    }
    await waitForShutdown(close);
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

/** Close the same connection once and detach both signal handlers before awaiting it. */
function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const onSignal = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void close().then(resolve, reject);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
