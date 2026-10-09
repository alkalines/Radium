import * as prompts from "@clack/prompts";
import { readSetupCodeFromStdin } from "./input.js";
import type { WorkerCredentialStoreMode } from "../auth/credentials.js";
import { parseSetupCode, WorkerProtocolError } from "../protocol.js";

/** Read setup credentials from bounded stdin or a masked prompt. */
export async function readSetupCode(): Promise<string | null> {
  if (!process.stdin.isTTY) return readSetupCodeFromStdin(Bun.stdin.stream());
  if (!isInteractive()) {
    throw new WorkerProtocolError("Pipe the setup code to stdin when stdout is redirected");
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

/** Whether both terminal streams are interactive. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Describe the selected credential store without exposing credential contents. */
export function storageDescription(mode: WorkerCredentialStoreMode): string {
  return mode === "keyring"
    ? "Credential storage: OS keyring"
    : "Credential storage: protected file (not encrypted at rest)";
}

/** Render a spinner only on an interactive terminal; preserve the action's result/error. */
export async function withProgress<T>(message: string, action: () => Promise<T>): Promise<T> {
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
