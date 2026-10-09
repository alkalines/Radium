import { WorkerHttpError, WorkerProtocolError } from "./protocol.js";
import { runCli } from "./cli/run.js";

/** Public CLI facade; package scripts execute this module directly. */
export { runCli };

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
