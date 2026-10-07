import * as prompts from "@clack/prompts";
import { recoverPendingIdentity, setupWorker } from "../auth/enrollment.js";
import { credentialStorage, forgetWorkerState, readWorkerState } from "../auth/state.js";
import { requestMachineToken } from "../auth/token.js";
import { WorkerProtocolError } from "../protocol.js";
import { HELP, normalizeCommand, parseOptions, type Command } from "./options.js";
import { isInteractive, readSetupCode, storageDescription, withProgress } from "./prompt.js";
import { startWorker } from "./start.js";

/** Run the Worker CLI without exposing setup or access credentials in output. */
export async function runCli(args: string[]): Promise<void> {
  // Accept a leading package-manager separator as well as direct Bun arguments.
  if (args[0] === "--") args = args.slice(1);

  if (args.includes("--help") || args[0] === "help") {
    console.info(HELP);
    return;
  }

  let [requested, ...commandArgs] = args;
  if (!requested) {
    if (!isInteractive()) throw new WorkerProtocolError("Choose a command; use --help");
    prompts.intro("Radium Worker");
    const selection = await prompts.select<Command>({
      message: "What would you like to do?",
      options: [
        { value: "setup", label: "Add setup code", hint: "enroll this machine" },
        { value: "start", label: "Start Worker" },
        { value: "status", label: "Show local status" },
        { value: "refresh", label: "Refresh authentication", hint: "verify backend access" },
        { value: "forget", label: "Forget local identity" },
      ],
    });
    if (prompts.isCancel(selection)) return prompts.cancel("Cancelled.");
    requested = selection;
  }

  const command = normalizeCommand(requested);
  const options = parseOptions(commandArgs, command);

  if (command === "setup") {
    const code = await readSetupCode();
    if (code === null) return;
    await withProgress("Enrolling Worker", () => setupWorker(options.stateDirectory, code));
    console.info("Worker enrollment complete.");
    const storage = await credentialStorage(options.stateDirectory);
    if (storage) console.info(storageDescription(storage));
  } else if (command === "start") {
    await startWorker(options);
  } else if (command === "forget") {
    if (!options.yes) {
      if (!isInteractive()) throw new WorkerProtocolError("Use --yes to forget local identity");
      const confirmed = await prompts.confirm({
        message:
          "Forget local credentials? Stop this Worker first. Remote identity is not revoked.",
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || !confirmed) return prompts.cancel("Cancelled.");
    }
    await forgetWorkerState(options.stateDirectory);
    console.info(
      "Local Worker identity forgotten. Revoke the Worker on the Workers page if needed.",
    );
  } else {
    const state = await readWorkerState(options.stateDirectory);
    if (!state) {
      if (command === "refresh") {
        throw new WorkerProtocolError("Worker is not configured; run setup");
      }

      console.info("Worker is not configured.");
      return;
    }

    if (command === "status") {
      console.info(`Enrollment: ${state.identity ? "complete" : "pending recovery"}`);
      console.info(storageDescription(state.credentialStoreMode));
      console.info(`Backend: ${state.setup.backendUrl}`);
      if (state.identity) {
        console.info(`Worker: ${state.identity.workerId}`);
        console.info(`Workspace: ${state.identity.workspaceId}`);
      }
      console.info("Local status only; use refresh to check authentication with the backend.");
      return;
    }

    const result = await withProgress("Checking Worker authentication", async () => {
      const enrolled = await recoverPendingIdentity(options.stateDirectory, state);
      return requestMachineToken(enrolled);
    });
    // Access tokens are deliberately neither printed nor persisted by this diagnostic command.
    console.info(
      `Authentication succeeded. Access expires at ${new Date(result.expiresAt).toISOString()}.`,
    );
  }
}
