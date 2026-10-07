import { recoverPendingIdentity } from "../auth/enrollment.js";
import { readWorkerState } from "../auth/state.js";
import {
  connectWorkerControl,
  type WorkerControlConnection,
  type WorkerControlStatus,
} from "../control.js";
import { WorkerProtocolError } from "../protocol.js";
import type { CliOptions } from "./options.js";
import { storageDescription } from "./prompt.js";

/** Recover local enrollment before opening the authenticated outbound control client. */
export async function startWorker(options: CliOptions): Promise<void> {
  let state = await readWorkerState(options.stateDirectory);
  if (!state) throw new WorkerProtocolError("Worker is not configured; run setup first");

  state = await recoverPendingIdentity(options.stateDirectory, state);
  console.info(storageDescription(state.credentialStoreMode));

  let control: WorkerControlConnection | undefined;
  try {
    let previousStatus: WorkerControlStatus["status"] | undefined;
    control = connectWorkerControl(state, (status) => {
      if (previousStatus === status.status) return;
      previousStatus = status.status;
      console.info(`Worker control ${status.status}.`);
    });
    await waitForShutdown(control);
  } catch (error) {
    await control?.close().catch(() => undefined);
    throw error;
  }
}

/** Close the same connection once and detach both signal handlers before awaiting it. */
function waitForShutdown(control: WorkerControlConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const onSignal = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void control.close().then(resolve, reject);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
