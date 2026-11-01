import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validAcpAgentId } from "backend/src/acp/contract";

/** Local owner-controlled executable definition; chat commands cannot supply executables. */
export interface AcpAgentDefinition {
  id: string;
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Refuse launch overrides that redirect executable lookup, loaders, proxies or TLS trust. */
export function forbiddenAgentEnv(key: string): boolean {
  return (
    /^(PATH|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|.*_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|BUN_.*)$/i.test(
      key,
    ) || /^(RADIUM_|CONVEX_)/i.test(key)
  );
}

/** Read agents.json without creating state; malformed or unsafe definitions fail startup. */
export async function readAgentDefinitions(stateDirectory: string): Promise<AcpAgentDefinition[]> {
  let text: string;
  try {
    text = await readFile(join(stateDirectory, "agents.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents)) {
    throw new Error("agents.json must contain an agents array");
  }
  if (value.agents.length > 32) throw new Error("agents.json supports at most 32 agents");
  const seen = new Set<string>();
  return value.agents.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid agent definition");
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !validAcpAgentId(row.id) || seen.has(row.id)) {
      throw new Error("Agent ids must be valid and unique");
    }
    if (typeof row.command !== "string" || !row.command.trim() || row.command.includes("\0")) {
      throw new Error(`Invalid command for ${row.id}`);
    }
    if (row.name !== undefined && typeof row.name !== "string")
      throw new Error(`Invalid name for ${row.id}`);
    if (
      row.args !== undefined &&
      (!Array.isArray(row.args) ||
        row.args.some((arg) => typeof arg !== "string" || arg.includes("\0")))
    ) {
      throw new Error(`Invalid args for ${row.id}`);
    }
    if (row.env !== undefined) {
      if (!row.env || typeof row.env !== "object" || Array.isArray(row.env))
        throw new Error(`Invalid env for ${row.id}`);
      for (const [key, item] of Object.entries(row.env)) {
        if (
          forbiddenAgentEnv(key) ||
          !/^[a-z_][a-z0-9_]*$/i.test(key) ||
          typeof item !== "string" ||
          item.includes("\0")
        ) {
          throw new Error(`Unsafe environment key for ${row.id}: ${key}`);
        }
      }
    }
    seen.add(row.id);
    return row as unknown as AcpAgentDefinition;
  });
}

/** Remove machine credentials/config before applying the already-validated local overrides. */
export function agentEnvironment(definition: AcpAgentDefinition): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(RADIUM_|CONVEX_)/i.test(key)),
  );
  for (const [key, value] of Object.entries(definition.env ?? {})) {
    if (forbiddenAgentEnv(key)) throw new Error(`Unsafe environment key: ${key}`);
    env[key] = value;
  }
  return env;
}
