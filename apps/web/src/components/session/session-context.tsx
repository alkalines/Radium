import type { ReactNode } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatWorkerSelection, ChatWorkerTool } from "backend/src/worker/chat-config";
import { agentsOnWorker, type SessionAgent, type SessionProject } from "./agents";
import { ProjectPicker, RunTargetPicker, SessionProjectTile } from "./run-target-picker";
import { SessionBranch } from "./session-branch";

const plainLabelClassName = "inline-flex h-6 min-w-0 items-center gap-1 px-2 text-muted-foreground";

/**
 * Where the Session runs, centered under the Composer as one `text-xs` line:
 * `Project · Worker (Agent)` and then `/ branch`. The Project (with its tile) shows once one is
 * set; the Agent shows only for ACP agents; no Worker reads `No Worker`.
 *
 * Worker configuration is owner-only (`api.workers.list` and `SetChatWorker` reject members), so
 * the Worker list is never queried for members and their Worker part is a plain label. Owners who
 * may manage the chat (`canManage`) open the `RunTargetPicker` for Project, Worker, and Agent;
 * `isFixed` turns the Worker part into a plain label. Projects are not owner-only: anyone who may
 * manage the chat but cannot open the Run target picker gets a separate `ProjectPicker` chip.
 */
export function SessionContext({
  workspaceId,
  isOwner,
  canManage,
  isFixed,
  isSaving,
  projects,
  project,
  selection,
  defaultWorkerTools,
  agent,
  onProjectChange,
  onSelectionChange,
  onAgentChange,
}: {
  workspaceId: Id<"workspaces"> | undefined;
  isOwner: boolean;
  canManage: boolean;
  isFixed: boolean;
  isSaving?: boolean;
  /** Projects of the Session's workspace; `undefined` while loading. */
  projects: SessionProject[] | undefined;
  project: SessionProject | null;
  selection: ChatWorkerSelection | null;
  /** Tools a newly picked Worker starts with (the workspace's Worker tool defaults). */
  defaultWorkerTools: ChatWorkerTool[];
  agent: SessionAgent;
  onProjectChange: (project: SessionProject | null) => void;
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

  // A selection without `workerId` only carries Worker tools chosen before a Worker.
  const hasWorker = Boolean(selection?.workerId);
  let workerName = "No Worker";
  if (selectedWorker) {
    workerName = selectedWorker.name;
  } else if (hasWorker && !isOwner) {
    // Members cannot list Workers, so the name of the owner's choice is not available to them.
    workerName = "Worker configured";
  } else if (hasWorker && workers !== undefined) {
    workerName = "Worker unavailable";
  } else if (hasWorker) {
    workerName = "Worker";
  }

  const workerLabel = (
    <>
      <span className="truncate">{workerName}</span>
      {agent.protocol === "acp" ? (
        <span className="shrink-0 text-subtle-foreground">({agent.name})</span>
      ) : null}
    </>
  );
  const projectLabel = project ? (
    <>
      <SessionProjectTile project={project} />
      <span className="truncate">{project.name}</span>
    </>
  ) : null;
  const separator = (
    <span aria-hidden="true" className="shrink-0 text-subtle-foreground">
      ·
    </span>
  );

  let target: ReactNode;
  if (isOwner && canManage && !isFixed && workers !== undefined && !workersError) {
    const runLabel = `Run on ${workerName} with ${agent.name}`;
    target = (
      <RunTargetPicker
        trigger={
          <>
            {projectLabel ? (
              <>
                {projectLabel}
                {separator}
              </>
            ) : null}
            {workerLabel}
          </>
        }
        triggerLabel={project ? `${project.name}: ${runLabel}` : runLabel}
        workspaceId={workspaceId}
        projects={projects}
        project={project}
        workers={workers}
        selection={selection}
        defaultWorkerTools={defaultWorkerTools}
        agent={agent}
        agents={agentsOnWorker(selectedWorker)}
        disabled={isSaving}
        onProjectChange={onProjectChange}
        onSelectionChange={changeSelection}
        onAgentChange={onAgentChange}
      />
    );
  } else {
    let projectPart: ReactNode = null;
    if (canManage) {
      projectPart = (
        <ProjectPicker
          workspaceId={workspaceId}
          isOwner={isOwner}
          projects={projects}
          project={project}
          disabled={isSaving}
          onProjectChange={onProjectChange}
        />
      );
    } else if (projectLabel) {
      projectPart = <span className={plainLabelClassName}>{projectLabel}</span>;
    }

    let workerPart = (
      <span
        className={plainLabelClassName}
        title={isOwner ? undefined : "Only workspace owners configure Workers"}
      >
        {workerLabel}
      </span>
    );
    if (isOwner && canManage && !isFixed && workersError) {
      workerPart = <span className={plainLabelClassName}>Workers unavailable</span>;
    } else if (isOwner && canManage && !isFixed) {
      workerPart = <span className={plainLabelClassName}>Workers…</span>;
    }

    target = (
      <>
        {projectPart}
        {projectPart ? separator : null}
        {workerPart}
      </>
    );
  }

  return (
    <div className="flex w-full min-w-0 items-center justify-center gap-0.5 px-1 text-xs">
      {target}
      {/* The branch comes from the Worker checkout of the Session's Project once Branches exist;
          until then there is none, so the chip stays hidden. */}
      <SessionBranch branch={undefined} isFixed={isFixed} />
    </div>
  );
}
