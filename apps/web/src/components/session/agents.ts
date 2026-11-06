import type { FunctionReturnType } from "convex/server";

import type { api } from "backend/convex/_generated/api";
import type { AcpProfile } from "backend/src/acp/contract";
import { acpGatewayProfileOffered } from "backend/src/acp/gateway";
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
  /** `gateway` runs the same harness with its model calls through the Radium Gateway. */
  profile: AcpProfile;
  installation?: SessionAgentRow;
};

/** The definition identifies a harness; its installation is only the selected Worker's report. */
export type SessionAgent = BuiltInAgent | AcpSessionAgent;
export type AgentAvailability =
  | "ready"
  | "needs_auth"
  | "unavailable"
  | "offline"
  | "no_worker"
  | "gateway_off"
  | "gateway_pending"
  | "gateway_missing";

export const builtInAgent: BuiltInAgent = { id: "radium", name: "Radium", protocol: "built-in" };

const gatewayPrefix = "acp-gateway:";

/**
 * Every enabled definition stays visible, even without a Worker or a successful report. A
 * definition that offers the Gateway profile also gets a `<Name> · Gateway` entry; its id has its
 * own prefix, so it never collides with `acp:<id>` or a legacy `acp:<worker>:<id>`.
 */
export function workspaceAgents(
  definitions: readonly SessionAgentDefinition[] | undefined,
  workerId: string | undefined,
  agentRows: readonly SessionAgentRow[] | undefined,
): SessionAgent[] {
  return [
    builtInAgent,
    ...(definitions ?? [])
      .filter((definition) => definition.enabled)
      .flatMap((definition): AcpSessionAgent[] => {
        const native: AcpSessionAgent = {
          id: `acp:${definition.agentId}`,
          protocol: "acp",
          profile: "native",
          agentId: definition.agentId,
          name: definition.name,
          icon: definition.icon,
          installation: agentRows?.find(
            (row) => row.worker === workerId && row.agentId === definition.agentId,
          ),
        };
        if (!acpGatewayProfileOffered(definition)) return [native];
        return [
          native,
          {
            ...native,
            id: `${gatewayPrefix}${definition.agentId}`,
            profile: "gateway",
            name: `${definition.name} · Gateway`,
          },
        ];
      }),
  ];
}

/**
 * Presence wins over a stale installation's status; missing reports are unavailable online. The
 * Gateway profile follows the Worker's Gateway access, then the native report, where a missing
 * agent login does not matter because the Gateway key replaces it.
 */
export function agentAvailability(
  agent: SessionAgent,
  worker: SessionWorker | undefined,
  now: number,
  agentRows?: readonly SessionAgentRow[],
): AgentAvailability {
  if (agent.protocol === "built-in") return "ready";
  if (!worker) return "no_worker";
  if (agent.profile === "gateway") {
    if (worker.gateway.access === "off") return "gateway_off";
    if (worker.status === "active" && worker.gateway.access === "pending") return "gateway_pending";
    if (worker.status === "active" && worker.gateway.access === "missing") return "gateway_missing";
  }
  if (worker.status !== "active" || !isWorkerOnline(worker.lastSeenAt, now)) return "offline";
  const installation = agentRows
    ? agentRows.find((row) => row.worker === worker.workerId && row.agentId === agent.agentId)
    : agent.installation?.worker === worker.workerId
      ? agent.installation
      : undefined;
  if (installation?.status === "ready") return "ready";
  if (installation?.status === "needs_auth") {
    return agent.profile === "gateway" ? "ready" : "needs_auth";
  }
  return "unavailable";
}

/**
 * Whether the Agent list shows an entry. A Gateway entry is hidden where Gateway access is off:
 * on the selected Worker, or, without one, on every active Worker.
 */
export function agentListed(
  agent: SessionAgent,
  worker: SessionWorker | undefined,
  workers: readonly SessionWorker[],
): boolean {
  if (agent.protocol === "built-in" || agent.profile === "native") return true;
  if (worker) return worker.gateway.access !== "off";
  return workers.some(
    (candidate) => candidate.status === "active" && candidate.gateway.access !== "off",
  );
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
  if (id.startsWith(gatewayPrefix)) {
    const agentId = id.slice(gatewayPrefix.length);
    return agentId && !agentId.includes(":") ? { id } : { id: "radium" };
  }
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
