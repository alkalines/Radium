import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { forbiddenAgentEnv, type AcpAgentDefinition } from "backend/src/acp/contract";

/** Resolve on the Worker's PATH, or require an executable file for explicit paths. */
export async function resolveAgentCommand(command: string): Promise<string | null> {
  if (!command.includes("/")) return Bun.which(command);
  const path = resolve(command);
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** Remove machine credentials/config before applying the validated owner-defined overrides. */
export function agentEnvironment(definition: AcpAgentDefinition): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(RADIUM_|CONVEX_)/i.test(key)),
  );
  for (const { name, value } of definition.env) {
    if (forbiddenAgentEnv(name)) throw new Error(`Unsafe environment key: ${name}`);
    env[name] = value;
  }
  return env;
}
