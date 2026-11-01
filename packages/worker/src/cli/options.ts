import { defaultStateDirectory } from "../auth/state.js";
import { WorkerProtocolError } from "../protocol.js";

/** Commands supported by the Worker command-line interface. */
export type Command = "setup" | "start" | "status" | "refresh" | "forget";

/** Parsed command options; setup credentials are deliberately absent. */
export interface CliOptions {
  stateDirectory: string;
  yes: boolean;
}

/** CLI usage text, including credential-store choices and aliases. */
export const HELP = `Radium Worker

  setup        Enroll using a masked prompt or stdin
  add-token    Alias for setup (the one-time code is never saved)
  start        Run the authenticated outbound Convex control subscription
  status       Show local enrollment metadata, without making network requests
  refresh      Recover pending enrollment and verify a fresh access-token exchange
  forget       Delete this machine's saved identity (does not revoke it remotely)
  forget-token Alias for forget

Options:
  --state-dir PATH    State directory (default: ~/.radium-worker)
  --yes              Confirm local removal, forget only
  --help             Show this help

Credential storage:
  RADIUM_WORKER_CREDENTIAL_STORE=keyring (default), auto, or file
  auto permits a protected-file fallback when the OS keyring is unavailable.

Run without a command in a terminal to open the interactive menu.`;

/** Map documented aliases to the internal command set and reject unknown commands. */
export function normalizeCommand(command: string): Command {
  if (command === "add-token") return "setup";
  if (command === "forget-token") return "forget";
  if (["setup", "start", "status", "refresh", "forget"].includes(command)) {
    return command as Command;
  }

  throw new WorkerProtocolError("Unknown command; use --help");
}

/** Parse only options supported by the selected command. */
export function parseOptions(args: string[], command: Command): CliOptions {
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
    } else {
      throw new WorkerProtocolError("Unsupported or missing option; use --help");
    }
  }
  return options;
}
