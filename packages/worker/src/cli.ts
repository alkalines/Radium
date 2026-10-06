import * as prompts from "@clack/prompts";
import { connectWorkerControl, type WorkerControlStatus } from "./control.js";
import { recoverPendingIdentity, requestMachineToken, setupWorker } from "./auth.js";
import { readSetupCodeFromFile, readSetupCodeFromStdin } from "./input.js";
import { parseSetupCode, WorkerHttpError, WorkerProtocolError } from "./protocol.js";
import {
  credentialStorage,
  defaultStateDirectory,
  forgetWorkerState,
  readWorkerState,
} from "./state.js";
import type { WorkerCredentialStoreMode } from "./credentials.js";

type Command = "setup" | "start" | "status" | "refresh" | "forget";

interface CliOptions {
  stateDirectory: string;
  setupFile?: string;
  yes: boolean;
}

const HELP = `Radium Worker

  setup        Enroll using a masked prompt, stdin, or --setup-file PATH
  add-token    Alias for setup (the one-time code is never saved)
  start        Run the authenticated outbound Convex control subscription
  status       Show local enrollment metadata, without making network requests
  refresh      Recover pending enrollment and verify a fresh access-token exchange
  forget       Delete this machine's saved identity (does not revoke it remotely)
  forget-token Alias for forget

Options:
  --state-dir PATH    State directory (default: ~/.radium-worker)
  --setup-file PATH   Protected setup-code file, setup only
  --yes              Confirm local removal, forget only
  --help             Show this help

Credential storage:
  RADIUM_WORKER_CREDENTIAL_STORE=keyring (default), auto, or file
  auto permits a protected-file fallback when the OS keyring is unavailable.

Run without a command in a terminal to open the interactive menu.`;

/** CLI values never contain credentials: setup input uses a masked prompt or protected stream. */
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
    const code = await readSetupCode(options.setupFile);
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
      if (command === "refresh")
        throw new WorkerProtocolError("Worker is not configured; run setup");
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

async function readSetupCode(path: string | undefined): Promise<string | null> {
  if (path) return readSetupCodeFromFile(path);
  if (!process.stdin.isTTY) return readSetupCodeFromStdin(Bun.stdin.stream());
  if (!isInteractive()) {
    throw new WorkerProtocolError(
      "Use --setup-file or pipe the setup code when stdout is redirected",
    );
  }
  const result = await prompts.password({
    message: "Paste the setup code from Chatroom → Workers",
    validate(value) {
      try {
        parseSetupCode(value?.trim() ?? "", Date.now());
      } catch {
        return "Enter a valid, unexpired Radium Worker setup code.";
      }
    },
  });
  if (prompts.isCancel(result)) {
    prompts.cancel("Cancelled.");
    return null;
  }
  return result.trim();
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function storageDescription(mode: WorkerCredentialStoreMode): string {
  return mode === "keyring"
    ? "Credential storage: OS keyring"
    : "Credential storage: protected file (not encrypted at rest)";
}

/** Only interactive sessions render a spinner, keeping redirected output readable. */
async function withProgress<T>(message: string, action: () => Promise<T>): Promise<T> {
  const spinner = process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(message);
  try {
    const result = await action();
    spinner?.stop("Done.");
    return result;
  } catch (error) {
    spinner?.stop("Failed.");
    throw error;
  }
}

async function startWorker(options: CliOptions): Promise<void> {
  let state = await readWorkerState(options.stateDirectory);
  if (!state) throw new WorkerProtocolError("Worker is not configured; run setup first");
  state = await recoverPendingIdentity(options.stateDirectory, state);
  console.info(storageDescription(state.credentialStoreMode));

  let control: ReturnType<typeof connectWorkerControl> | undefined;
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

function waitForShutdown(control: ReturnType<typeof connectWorkerControl>): Promise<void> {
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

function normalizeCommand(command: string): Command {
  if (command === "add-token") return "setup";
  if (command === "forget-token") return "forget";
  if (["setup", "start", "status", "refresh", "forget"].includes(command))
    return command as Command;
  throw new WorkerProtocolError("Unknown command; use --help");
}

function parseOptions(args: string[], command: Command): CliOptions {
  if (args[0] === "--") args = args.slice(1);
  const options: CliOptions = { stateDirectory: defaultStateDirectory(), yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--yes" && command === "forget") {
      options.yes = true;
    } else if (value && !value.startsWith("--") && flag === "--state-dir") {
      options.stateDirectory = value;
      index += 1;
    } else if (value && !value.startsWith("--") && flag === "--setup-file" && command === "setup") {
      options.setupFile = value;
      index += 1;
    } else {
      throw new WorkerProtocolError("Unsupported or missing option; use --help");
    }
  }
  return options;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof WorkerProtocolError || error instanceof WorkerHttpError
        ? error.message
        : "Worker command failed",
    );
    process.exitCode = 1;
  });
}
