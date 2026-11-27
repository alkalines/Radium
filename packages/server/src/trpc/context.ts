import type { Bus } from "../ports/bus";
import type { Kv } from "../ports/kv";
import type { Database, Ports } from "../ports/types";

/**
 * What every procedure receives. Middleware (`sessionProcedure`, `workspaceProcedure`, …) adds the
 * verified identity on top; nothing here is authenticated yet.
 */
export type Context = {
  db: Database;
  kv: Kv;
  bus: Bus;
  /** Headers of the HTTP request, or of the WebSocket upgrade request for socket calls. */
  headers: Headers;
  /** Values a WebSocket client sent with `connectionParams` (Worker JWT); `null` over HTTP. */
  connectionParams: Record<string, string | undefined> | null;
};

export interface ContextSource {
  headers: Headers;
  connectionParams: Record<string, string | undefined> | null;
}

export function createContext(ports: Ports, source: ContextSource): Context {
  return {
    db: ports.db,
    kv: ports.kv,
    bus: ports.bus,
    headers: source.headers,
    connectionParams: source.connectionParams,
  };
}
