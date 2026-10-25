import type { ReactNode } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatWorkerSelection, ChatWorkerTool } from "backend/src/worker/chat-config";
import { cn } from "@/lib/utils";
import { agentsOnWorker, type SessionAgent, type SessionProject } from "./agents";
import { ProjectPicker, RunTargetPicker, SessionProjectTile } from "./run-target-picker";
import { SessionBranch } from "./session-branch";

const plainLabelClassName = "inline-flex h-6 min-w-0 items-center gap-1 px-2 text-muted-foreground";

/** What both Session context surfaces need to show and change where the Session runs. */
type WorkerControlProps = {
  workspaceId: Id<"workspaces"> | undefined;
  isOwner: boolean;
  canManage: boolean;
  isSaving?: boolean;
  selection: ChatWorkerSelection | null;
  /** Tools a newly picked Worker starts with (the workspace's Worker tool defaults). */
  defaultWorkerTools: ChatWorkerTool[];
  agent: SessionAgent;
  onSelectionChange: (selection: ChatWorkerSelection | null) => void;
  onAgentChange: (agent: SessionAgent) => void;
};

/**
 * The New session's context, centered under its Composer as one `text-xs` line:
 * `Project · Worker (Agent)` and then `/ branch`. The Project (with its tile) shows once one is
 * set; the Agent shows only for ACP agents; no Worker reads `No Worker`.
 *
 * Worker configuration is owner-only (`api.workers.list` and `SetChatWorker` reject members), so
 * the Worker list is never queried for members and their Worker part is a plain label. Owners who
 * may manage the draft open the `RunTargetPicker` for Project, Worker, and Agent. Projects are not
 * owner-only: anyone else who may manage the draft gets a separate `ProjectPicker` chip.
 *
 * Once the Session has a message, this line goes away and `SessionWorkerControl` (Panel corner)
 * shows the Worker; the Project then only shows in the Tab icon and Home.
 */
export function SessionContext({
  projects,
  project,
  onProjectChange,
  ...workerProps
}: WorkerControlProps & {
  /** Projects of the Session's workspace; `undefined` while loading. */
  projects: SessionProject[] | undefined;
  project: SessionProject | null;
  onProjectChange: (project: SessionProject | null) => void;
}) {
  const { workspaceId, isOwner, canManage, isSaving } = workerProps;
  const worker = useSessionWorker(workerProps);

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
  if (isOwner && canManage && worker.workers !== undefined && !worker.workersError) {
    const runLabel = `Run on ${worker.name} with ${workerProps.agent.name}`;
    target = (
      <RunTargetPicker
        side="top"
        trigger={
          <>
            {projectLabel ? (
              <>
                {projectLabel}
                {separator}
              </>
            ) : null}
            {worker.label}
          </>
        }
        triggerLabel={project ? `${project.name}: ${runLabel}` : runLabel}
        projectChoice={{ workspaceId, projects, project, onProjectChange }}
        workers={worker.workers}
        selection={workerProps.selection}
        defaultWorkerTools={workerProps.defaultWorkerTools}
        agent={workerProps.agent}
        agents={agentsOnWorker(worker.selected)}
        isAgentFixed={false}
        disabled={isSaving}
        onSelectionChange={worker.changeSelection}
        onAgentChange={workerProps.onAgentChange}
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

    target = (
      <>
        {projectPart}
        {projectPart ? separator : null}
        <WorkerLabel isOwner={isOwner} canManage={canManage} worker={worker} />
      </>
    );
  }

  return (
    <div className="flex w-full min-w-0 items-center justify-center gap-0.5 px-1 text-xs">
      {target}
      {/* The branch comes from the Worker checkout of the Session's Project once Branches exist;
          until then there is none, so the chip stays hidden. */}
      <SessionBranch branch={undefined} isFixed={false} />
    </div>
  );
}

/**
 * Where a started Session runs, in the Panel's top-right corner: `Worker (Agent)`. Owners who may
 * manage the chat open the `RunTargetPicker` for the Worker; the Agent is shown but no longer
 * changes, since a Session keeps its harness and only switches models. `isFixed` (an ACP agent,
 * whose process lives on its Worker) turns the control into a plain label, as do members, who
 * cannot configure Workers.
 */
export function SessionWorkerControl({
  isFixed,
  ...workerProps
}: WorkerControlProps & { isFixed: boolean }) {
  const { isOwner, canManage, isSaving } = workerProps;
  const worker = useSessionWorker(workerProps);

  if (isOwner && canManage && !isFixed && worker.workers !== undefined && !worker.workersError) {
    return (
      <RunTargetPicker
        side="bottom"
        trigger={worker.label}
        triggerLabel={`Run on ${worker.name} with ${workerProps.agent.name}`}
        workers={worker.workers}
        selection={workerProps.selection}
        defaultWorkerTools={workerProps.defaultWorkerTools}
        agent={workerProps.agent}
        agents={agentsOnWorker(worker.selected)}
        isAgentFixed
        disabled={isSaving}
        onSelectionChange={worker.changeSelection}
        onAgentChange={workerProps.onAgentChange}
      />
    );
  }

  return <WorkerLabel isOwner={isOwner} canManage={canManage && !isFixed} worker={worker} />;
}

type SessionWorker = ReturnType<typeof useSessionWorker>;

/** The Worker part as plain text: for members, fixed Workers, or while the Worker list loads. */
function WorkerLabel({
  isOwner,
  canManage,
  worker,
}: {
  isOwner: boolean;
  canManage: boolean;
  worker: SessionWorker;
}) {
  let label: ReactNode = worker.label;
  if (isOwner && canManage && worker.workersError) {
    label = "Workers unavailable";
  } else if (isOwner && canManage) {
    label = "Workers…";
  }

  return (
    <span
      className={cn(plainLabelClassName, "text-xs")}
      title={isOwner ? undefined : "Only workspace owners configure Workers"}
    >
      {label}
    </span>
  );
}

/**
 * The Session's Worker as both surfaces show it: the owner-only Worker list, the selected Worker,
 * its display name and `Worker (Agent)` label, and a selection change that falls back to the
 * built-in agent when the chosen ACP agent is not installed on the new Worker.
 */
function useSessionWorker({
  workspaceId,
  isOwner,
  selection,
  agent,
  onSelectionChange,
  onAgentChange,
}: WorkerControlProps) {
  const { data: workers, error: workersError } = useQuery(
    convexQuery(api.workers.list, workspaceId && isOwner ? { workspace: workspaceId } : "skip"),
  );
  const selected = workers?.find(
    (candidate) => candidate.workerId === selection?.workerId && candidate.status === "active",
  );

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
  let name = "No Worker";
  if (selected) {
    name = selected.name;
  } else if (hasWorker && !isOwner) {
    // Members cannot list Workers, so the name of the owner's choice is not available to them.
    name = "Worker configured";
  } else if (hasWorker && workers !== undefined) {
    name = "Worker unavailable";
  } else if (hasWorker) {
    name = "Worker";
  }

  const label = (
    <>
      <span className="truncate">{name}</span>
      {agent.protocol === "acp" ? (
        <span className="shrink-0 text-subtle-foreground">({agent.name})</span>
      ) : null}
    </>
  );

  return { workers, workersError, selected, name, label, changeSelection };
}
