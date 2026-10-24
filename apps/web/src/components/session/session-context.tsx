import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatWorkerSelection } from "backend/src/worker/chat-config";
import { agentsOnWorker, type SessionAgent } from "./agents";
import { RunTargetPicker } from "./run-target-picker";
import { SessionBranch } from "./session-branch";

const plainLabelClassName = "inline-flex h-6 min-w-0 items-center gap-1 px-2 text-muted-foreground";

/**
 * Where the Session runs, centered under the Composer as one `text-xs` line: `Worker (Agent)` and
 * then `/ branch`. The Agent shows only for ACP agents; no Worker reads `No Worker`.
 *
 * Worker configuration is owner-only (`api.workers.list` and `SetChatWorker` reject members), so
 * members get a plain label and the Worker list is never queried for them. Owners who may manage
 * the chat (`canManage`) open the `RunTargetPicker`; `isFixed` turns the row into plain labels.
 */
export function SessionContext({
  workspaceId,
  isOwner,
  canManage,
  isFixed,
  isSaving,
  selection,
  agent,
  onSelectionChange,
  onAgentChange,
}: {
  workspaceId: Id<"workspaces"> | undefined;
  isOwner: boolean;
  canManage: boolean;
  isFixed: boolean;
  isSaving?: boolean;
  selection: ChatWorkerSelection | null;
  agent: SessionAgent;
  onSelectionChange: (selection: ChatWorkerSelection | null) => void;
  onAgentChange: (agent: SessionAgent) => void;
}) {
  const { data: workers, error: workersError } = useQuery(
    convexQuery(api.workers.list, workspaceId && isOwner ? { workspace: workspaceId } : "skip"),
  );
  const selectedWorker = workers?.find(
    (candidate) => candidate.workerId === selection?.workerId && candidate.status === "active",
  );

  // An ACP agent only exists on the Worker that has it installed; fall back to the built-in one.
  function changeSelection(next: ChatWorkerSelection | null) {
    const nextWorker = workers?.find((candidate) => candidate.workerId === next?.workerId);
    const nextAgents = agentsOnWorker(nextWorker);
    if (!nextAgents.some((candidate) => candidate.id === agent.id)) {
      onAgentChange(nextAgents[0]);
    }
    onSelectionChange(next);
  }

  let workerName = "No Worker";
  if (selectedWorker) {
    workerName = selectedWorker.name;
  } else if (selection && !isOwner) {
    // Members cannot list Workers, so the name of the owner's choice is not available to them.
    workerName = "Worker configured";
  } else if (selection && workers !== undefined) {
    workerName = "Worker unavailable";
  } else if (selection) {
    workerName = "Worker";
  }

  const targetLabel = (
    <>
      <span className="truncate">{workerName}</span>
      {agent.protocol === "acp" ? (
        <span className="shrink-0 text-subtle-foreground">({agent.name})</span>
      ) : null}
    </>
  );

  let target = (
    <span
      className={plainLabelClassName}
      title={isOwner ? undefined : "Only workspace owners configure Workers"}
    >
      {targetLabel}
    </span>
  );

  if (isOwner && canManage && !isFixed) {
    if (workersError) {
      target = <span className={plainLabelClassName}>Workers unavailable</span>;
    } else if (workers === undefined) {
      target = <span className={plainLabelClassName}>Workers…</span>;
    } else {
      target = (
        <RunTargetPicker
          trigger={targetLabel}
          triggerLabel={`Run on ${workerName} with ${agent.name}`}
          workers={workers}
          selection={selection}
          agent={agent}
          agents={agentsOnWorker(selectedWorker)}
          disabled={isSaving}
          onSelectionChange={changeSelection}
          onAgentChange={onAgentChange}
        />
      );
    }
  }

  return (
    <div className="flex w-full min-w-0 items-center justify-center gap-0.5 px-1 text-xs">
      {target}
      {/* The branch comes from the Worker checkout of the Session's Project once Projects and
          Branches exist; until then there is none, so the chip stays hidden. */}
      <SessionBranch branch={undefined} isFixed={isFixed} />
    </div>
  );
}
