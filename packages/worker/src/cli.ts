import { app } from "./service.js";
import { connectWorkerControl, type WorkerControlStatus } from "./control.js";
import { recoverPendingIdentity, setupWorker } from "./auth.js";
import { readSetupCodeFromFile, readSetupCodeFromStdin } from "./input.js";
import { WorkerHttpError, WorkerProtocolError } from "./protocol.js";
import { defaultStateDirectory, readWorkerState } from "./state.js";

interface CliOptions {
  stateDirectory: string;
  port: number;
  setupFile?: string;
}

async function runCli(args: string[]): Promise<void> {
  const [command, ...commandArgs] = args;
  if (command !== "setup" && command !== "start") {
    throw new WorkerProtocolError("Use the setup or start command");
  }

  const options = parseOptions(commandArgs, command);
  if (command === "setup") {
    const code = await readSetupCode(options.setupFile);
    await setupWorker(options.stateDirectory, code);
    console.info("Worker enrollment complete.");
    return;
  }

  await startWorker(options);
}

async function readSetupCode(path: string | undefined): Promise<string> {
  if (path) return readSetupCodeFromFile(path);
  if (process.stdin.isTTY) {
    throw new WorkerProtocolError(
      "Provide a setup code on stdin or use --setup-file with a protected file",
    );
  }
  return readSetupCodeFromStdin(Bun.stdin.stream());
}

async function startWorker(options: CliOptions): Promise<void> {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: options.port,
    fetch: (request) => app.fetch(request),
  });
  let control: ReturnType<typeof connectWorkerControl> | undefined;

  try {
    let state = await readWorkerState(options.stateDirectory);
    if (!state)
      throw new WorkerProtocolError("Worker is not configured; run the setup command first");
    if (!state.identity) state = await recoverPendingIdentity(options.stateDirectory, state);

    let previousStatus: WorkerControlStatus["status"] | undefined;
    control = connectWorkerControl(state, (status) => {
      if (previousStatus === status.status) return;
      previousStatus = status.status;
      console.info(`Worker control ${status.status}.`);
    });

    console.info(`Worker health endpoint listening on port ${options.port}.`);
    await waitForShutdown(server, control);
  } catch (error) {
    await control?.close();
    server.stop(true);
    throw error;
  }
}

function waitForShutdown(
  server: ReturnType<typeof Bun.serve>,
  control: ReturnType<typeof connectWorkerControl>,
): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const cleanup = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    const onSignal = () => {
      if (stopping) return;
      stopping = true;
      cleanup();
      void control.close().finally(() => {
        server.stop(true);
        resolve();
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function parseOptions(args: string[], command: "setup" | "start"): CliOptions {
  const options: CliOptions = {
    stateDirectory: defaultStateDirectory(),
    port: 3001,
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--state-dir" && value) {
      options.stateDirectory = value;
      index += 1;
    } else if (flag === "--setup-file" && value) {
      options.setupFile = value;
      index += 1;
    } else if (flag === "--port" && value) {
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new WorkerProtocolError("Port must be an integer from 1 to 65535");
      }
      options.port = port;
      index += 1;
    } else {
      throw new WorkerProtocolError("Worker command contains an unsupported option");
    }
  }

  if (command === "start" && options.setupFile) {
    throw new WorkerProtocolError("--setup-file is available only with the setup command");
  }

  return options;
}

function errorMessage(error: unknown): string {
  if (error instanceof WorkerProtocolError || error instanceof WorkerHttpError)
    return error.message;
  return "Worker command failed";
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
