import type { FunctionReturnType } from "convex/server";

import type { api } from "backend/convex/_generated/api";

/** Owner-only Worker and agent catalogs, shared by the draft and Run target picker. */
export type SessionWorker = FunctionReturnType<typeof api.workers.list>[number];
export type SessionAgentRow = FunctionReturnType<typeof api.acp.ListAgents>[number];
export type SessionProject = FunctionReturnType<typeof api.projects.list>[number];

type BuiltInAgent = { id: string; name: string; protocol: "built-in" };
export type AcpSessionAgent = Pick<
  SessionAgentRow,
  "agentId" | "name" | "status" | "icon" | "capabilities" | "authMethods" | "defaults"
> & { id: string; protocol: "acp"; workerId: string };

/** A Session keeps its harness, and ACP also keeps its Worker and directory, after creation. */
export type SessionAgent = BuiltInAgent | AcpSessionAgent;

export const builtInAgent: BuiltInAgent = { id: "radium", name: "Radium", protocol: "built-in" };

function catalogAgent(row: SessionAgentRow): AcpSessionAgent {
  return {
    id: `acp:${row.worker}:${row.agentId}`,
    protocol: "acp",
    workerId: row.worker,
    agentId: row.agentId,
    name: row.name,
    icon: row.icon,
    status: row.status,
    capabilities: row.capabilities,
    authMethods: row.authMethods,
    defaults: row.defaults,
  };
}

/** Built-in stays first; failed/unavailable installations remain visible only in Settings. */
export function agentsOnWorker(
  worker: SessionWorker | undefined,
  agentRows: readonly SessionAgentRow[] | undefined,
): SessionAgent[] {
  return [
    builtInAgent,
    ...(worker
      ? (agentRows ?? [])
          .filter(
            (row) =>
              row.worker === worker.workerId &&
              (row.status === "ready" || row.status === "needs_auth"),
          )
          .map(catalogAgent)
      : []),
  ];
}

/** Restoring a missing installation never silently selects a different external harness. */
export function sessionAgentById(
  id: string,
  agentRows: readonly SessionAgentRow[] | undefined,
): SessionAgent {
  const row = agentRows?.find(
    (candidate) =>
      `acp:${candidate.worker}:${candidate.agentId}` === id &&
      (candidate.status === "ready" || candidate.status === "needs_auth"),
  );
  return row ? catalogAgent(row) : builtInAgent;
}
