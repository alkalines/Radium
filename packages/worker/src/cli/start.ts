import { recoverPendingIdentity } from "../auth/enrollment.js";
import { readWorkerState } from "../auth/state.js";
import {
  connectWorkerControl,
  type WorkerControlConnection,
  type WorkerControlStatus,
} from "../control.js";
import { WorkerProtocolError } from "../protocol.js";
import { consumeEditTasks, type EditExecutor } from "../tasks.js";
import { WorkerDirectoryEdits } from "../edit/directories.js";
import type { CliOptions } from "./options.js";
import { storageDescription } from "./prompt.js";

/** Recover local enrollment before opening the authenticated outbound control client. */
export async function startWorker(options: CliOptions): Promise<void> {
  let state = await readWorkerState(options.stateDirectory);
  if (!state) throw new WorkerProtocolError("Worker is not configured; run setup first");

  state = await recoverPendingIdentity(options.stateDirectory, state);
  console.info(storageDescription(state.credentialStoreMode));

  let control: WorkerControlConnection | undefined;
  let editor: EditExecutor | undefined;
  let tasks: ReturnType<typeof consumeEditTasks> | undefined;
  const close = async () => {
    try {
      if (tasks) await tasks.close();
      else await editor?.close();
    } finally {
      await control?.close();
    }
  };
  try {
    editor = new WorkerDirectoryEdits();
    let previousStatus: WorkerControlStatus["status"] | undefined;
    control = connectWorkerControl(state, (status) => {
      tasks?.setAvailable(status.status === "connected");
      if (previousStatus === status.status) return;
      previousStatus = status.status;
      console.info(`Worker control ${status.status}.`);
    });
    if (editor) {
      tasks = consumeEditTasks(control.client, editor);
      tasks.setAvailable(previousStatus === "connected");
      console.info("Worker edit task consumer enabled.");
    }
    await waitForShutdown(close);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
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
