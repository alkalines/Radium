import { useState } from "react";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { demoAgents, demoProjects, demoWorkers, type DemoWorkspace } from "./demo-data";
import { ProjectTile } from "@/components/harness/project-tile";
import { agentsOn, RunTargetPicker } from "./run-target-picker";

const builtInAgent = demoAgents.find((agent) => agent.protocol === "built-in") ?? demoAgents[0];

/**
 * Where the Session runs, centered under the Composer as one line:
 * `Project · Worker (ACP agent)` and then `/ branch`. `RunTargetPicker` picks the Project, the
 * Worker, and the agent harness on it (the built-in Radium agent, or an ACP agent installed on
 * that Worker). After the first message all of it is fixed, because the agent process lives on
 * that Worker, so the row becomes plain labels.
 */
export function SessionContext({
  workspace,
  isFixed,
}: {
  workspace: DemoWorkspace;
  isFixed: boolean;
}) {
  const [projectId, setProjectId] = useState(demoProjects[0].id);
  const project = demoProjects.find((candidate) => candidate.id === projectId) ?? demoProjects[0];
  const [branch, setBranch] = useState(project.branches[0]);
  const [workerId, setWorkerId] = useState(demoWorkers[0].id);
  const worker = demoWorkers.find((candidate) => candidate.id === workerId) ?? demoWorkers[0];
  const [agentId, setAgentId] = useState(builtInAgent.id);
  const agent = demoAgents.find((candidate) => candidate.id === agentId) ?? builtInAgent;

  function selectProject(id: string) {
    const next = demoProjects.find((candidate) => candidate.id === id);
    if (!next) return;
    setProjectId(next.id);
    setBranch(next.branches[0]);
  }

  // An ACP agent only exists on the Worker that has it installed; fall back to the built-in one.
  function selectWorker(id: string) {
    const next = demoWorkers.find((candidate) => candidate.id === id);
    if (!next) return;
    setWorkerId(next.id);
    if (!agentsOn(next).some((candidate) => candidate.id === agentId)) {
      setAgentId(builtInAgent.id);
    }
  }

  const targetLabel = (
    <>
      <ProjectTile initial={project.initial} />
      <span className="truncate">{project.name}</span>
      <span aria-hidden="true" className="text-subtle-foreground">
        ·
      </span>
      <span className="truncate">{worker.name}</span>
      {agent.protocol === "acp" ? (
        <span className="shrink-0 text-subtle-foreground">({agent.name})</span>
      ) : null}
    </>
  );
  const branchLabel = (
    <>
      <GitBranchIcon className="size-3.5 shrink-0" />
      <span className="max-w-44 truncate font-mono text-xs">{branch}</span>
    </>
  );

  return (
    <div className="flex w-full min-w-0 items-center justify-center gap-0.5 px-1 text-xs">
      {isFixed ? (
        <span className="inline-flex h-6 min-w-0 items-center gap-1 px-2 text-muted-foreground">
          {targetLabel}
        </span>
      ) : (
        <RunTargetPicker
          workspace={workspace}
          project={project}
          worker={worker}
          agent={agent}
          trigger={targetLabel}
          onProjectChange={selectProject}
          onWorkerChange={selectWorker}
          onAgentChange={setAgentId}
        />
      )}

      <span aria-hidden="true" className="text-subtle-foreground">
        /
      </span>

      {isFixed ? (
        <span
          className="inline-flex h-6 min-w-0 items-center gap-1 px-2 text-muted-foreground"
          title={branch}
        >
          {branchLabel}
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              title={branch}
              className="min-w-0 text-muted-foreground"
              aria-label={`Branch: ${branch}`}
            >
              {branchLabel}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-80">
            <DropdownMenuLabel>Branches on {worker.name}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={branch} onValueChange={setBranch}>
              {project.branches.map((candidate) => (
                <DropdownMenuRadioItem key={candidate} value={candidate}>
                  <span className="truncate font-mono text-[13px]">{candidate}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
