import { readEnv, type ServerEnv } from "../env";
import type { Ports } from "./types";

export type { Ports, Database } from "./types";

/**
 * Creates the ports with the adapter for the runtime actually executing, not the build preset, so
 * a Node-preset build run by Bun still uses Bun's native clients. Adapters are imported dynamically
 * because they are platform-specific: `drizzle-orm/bun-sql` imports the `bun` module, which does
 * not exist on Node.
 */
export async function createPorts(env: ServerEnv): Promise<Ports> {
  if (process.versions.bun) {
    const { createBunPorts } = await import("./bun");
    return createBunPorts(env);
  }

  const { createNodePorts } = await import("./node");
  return createNodePorts(env);
}

let shared: Promise<Ports> | undefined;

/** The process-wide ports, created from the environment on first use. A failed start is retried on the next call. */
export function getPorts(): Promise<Ports> {
  shared ??= createPorts(readEnv()).catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

/** Closes the process-wide ports if they were created. Called on server shutdown. */
export async function closePorts(): Promise<void> {
  const current = shared;
  shared = undefined;
  if (current) await (await current).close();
}
