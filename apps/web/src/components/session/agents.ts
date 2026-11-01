import type { FunctionReturnType } from "convex/server";

import type { api } from "backend/convex/_generated/api";
import { isWorkerOnline } from "backend/src/worker/presence";

/** Owner-only catalogs, shared by the draft and Run target picker. */
export type SessionWorker = FunctionReturnType<typeof api.workers.list>[number];
export type SessionAgentRow = FunctionReturnType<typeof api.acp.ListAgents>[number];
export type SessionAgentDefinition = FunctionReturnType<
  typeof api.acp.ListAgentDefinitions
>[number];
export type SessionProject = FunctionReturnType<typeof api.projects.list>[number];

type BuiltInAgent = { id: string; name: string; protocol: "built-in" };
export type AcpSessionAgent = Pick<SessionAgentDefinition, "agentId" | "name" | "icon"> & {
  id: string;
  protocol: "acp";
  installation?: SessionAgentRow;
};

/** The definition identifies a harness; its installation is only the selected Worker's report. */
export type SessionAgent = BuiltInAgent | AcpSessionAgent;
export type AgentAvailability = "ready" | "needs_auth" | "unavailable" | "offline" | "no_worker";

/** An agent session listed by the Session row; the draft's first prompt continues it. */
export type AcpExistingSession = { sessionId: string; title?: string };
export const builtInAgent: BuiltInAgent = { id: "radium", name: "Radium", protocol: "built-in" };

/** Every enabled definition stays visible, even without a Worker or a successful report. */
export function workspaceAgents(
  definitions: readonly SessionAgentDefinition[] | undefined,
  workerId: string | undefined,
  agentRows: readonly SessionAgentRow[] | undefined,
): SessionAgent[] {
  return [
    builtInAgent,
    ...(definitions ?? [])
      .filter((definition) => definition.enabled)
      .map((definition): AcpSessionAgent => ({
        id: `acp:${definition.agentId}`,
        protocol: "acp",
        agentId: definition.agentId,
        name: definition.name,
        icon: definition.icon,
        installation: agentRows?.find(
          (row) => row.worker === workerId && row.agentId === definition.agentId,
        ),
      })),
  ];
}

/** Presence wins over a stale installation's status; missing reports are unavailable online. */
export function agentAvailability(
  agent: SessionAgent,
  worker: SessionWorker | undefined,
  now: number,
  agentRows?: readonly SessionAgentRow[],
): AgentAvailability {
  if (agent.protocol === "built-in") return "ready";
  if (!worker) return "no_worker";
  if (worker.status !== "active" || !isWorkerOnline(worker.lastSeenAt, now)) return "offline";
  const installation = agentRows
    ? agentRows.find((row) => row.worker === worker.workerId && row.agentId === agent.agentId)
    : agent.installation?.worker === worker.workerId
      ? agent.installation
      : undefined;
  if (installation?.status === "ready") return "ready";
  if (installation?.status === "needs_auth") return "needs_auth";
  return "unavailable";
}

export function firstReadyWorker(
  agent: SessionAgent,
  workers: readonly SessionWorker[],
  rows: readonly SessionAgentRow[] | undefined,
  now: number,
): SessionWorker | undefined {
  return workers.find((worker) => agentAvailability(agent, worker, now, rows) === "ready");
}

/** Accept old Worker-qualified ids without making Worker identity part of the new agent id. */
export function restoreAgentId(id: string): { id: string; workerId?: string } {
  if (id === "radium") return { id };
  if (!id.startsWith("acp:")) return { id: "radium" };
  const parts = id.slice(4).split(":");
  if (parts.length === 1 && parts[0]) return { id };
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { id: `acp:${parts[1]}`, workerId: parts[0] };
  }
  return { id: "radium" };
}

/** Missing or disabled definitions fall back only after the definition catalog has loaded. */
export function sessionAgentById(id: string, agents: readonly SessionAgent[]): SessionAgent {
  return agents.find((agent) => agent.id === restoreAgentId(id).id) ?? builtInAgent;
}
