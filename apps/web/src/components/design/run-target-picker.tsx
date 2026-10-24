import { type ReactNode, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { AgentStatus } from "@/components/agentic/agent-status";
import { ProviderLogo } from "@/components/gateway/provider-logo";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  demoAgents,
  demoProjects,
  demoWorkers,
  type DemoAgent,
  type DemoProject,
  type DemoWorker,
  type DemoWorkspace,
} from "./demo-data";
import { ProjectTile } from "./project-tile";

/** Agents a Worker can run: the built-in one everywhere, ACP agents only where installed. */
export function agentsOn(worker: DemoWorker) {
  return demoAgents.filter(
    (agent) => agent.protocol === "built-in" || worker.acpAgents.includes(agent.id),
  );
}

export function AgentLogo({ agent, className }: { agent: DemoAgent; className?: string }) {
  if (agent.logo) return <ProviderLogo slug={agent.logo} className={className} />;
  return <img src="/letters/R.svg" alt="" className={cn("shrink-0", className)} />;
}

type View = "summary" | "project" | "worker" | "agent";

/**
 * Picks the Project, Worker, and Agent of a new Session. Workspaces can hold many Projects and
 * Workers, so the popover never lists them all at once: a three-row summary drills into one
 * searchable, scrolling list per part, and picking returns to the summary. Switching views is
 * instant (navigation), and closing resets to the summary.
 */
export function RunTargetPicker({
  workspace,
  project,
  worker,
  agent,
  trigger,
  onProjectChange,
  onWorkerChange,
  onAgentChange,
}: {
  workspace: DemoWorkspace;
  project: DemoProject;
  worker: DemoWorker;
  agent: DemoAgent;
  trigger: ReactNode;
  onProjectChange: (projectId: string) => void;
  onWorkerChange: (workerId: string) => void;
  onAgentChange: (agentId: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>("summary");

  function handleOpenChange(open: boolean) {
    setIsOpen(open);
    if (!open) setView("summary");
  }

  function pick(apply: () => void) {
    apply();
    setView("summary");
  }

  const onlineWorkers = demoWorkers.filter((candidate) => candidate.online);
  const offlineWorkers = demoWorkers.filter((candidate) => !candidate.online);
  const availableAgents = agentsOn(worker);

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="min-w-0 text-muted-foreground"
          aria-label={`Run in ${project.name} on ${worker.name} with ${agent.name}`}
        >
          {trigger}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      {/*
        Opens upward: the row sits under the Composer and near the bottom once docked, and a fixed
        side keeps the popover from flipping when a drill-down list is taller than the summary.
      */}
      <PopoverContent
        data-design="harness"
        side="top"
        align="center"
        className="w-80 gap-0 overflow-hidden rounded-2xl p-0"
      >
        {view === "summary" ? (
          <div className="flex flex-col p-1">
            <SummaryRow label="Project" onOpen={() => setView("project")}>
              <ProjectTile initial={project.initial} />
              <span className="truncate">{project.name}</span>
            </SummaryRow>
            <SummaryRow label="Worker" onOpen={() => setView("worker")}>
              <AgentStatus
                state={worker.online ? "succeeded" : "idle"}
                label={worker.online ? "Online" : "Offline"}
                hideLabel
              />
              <span className="truncate">{worker.name}</span>
            </SummaryRow>
            <SummaryRow label="Agent" onOpen={() => setView("agent")}>
              <AgentLogo agent={agent} className="size-4" />
              <span className="truncate">{agent.name}</span>
            </SummaryRow>
          </div>
        ) : null}

        {view === "project" ? (
          <DrillList
            title={`Projects in ${workspace.name}`}
            placeholder="Search projects…"
            onBack={() => setView("summary")}
          >
            <CommandGroup>
              {demoProjects.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  keywords={[candidate.name]}
                  data-checked={candidate.id === project.id}
                  onSelect={() => pick(() => onProjectChange(candidate.id))}
                >
                  <ProjectTile initial={candidate.initial} />
                  <span className="truncate">{candidate.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </DrillList>
        ) : null}

        {view === "worker" ? (
          <DrillList
            title="Workers"
            placeholder="Search workers…"
            onBack={() => setView("summary")}
          >
            <CommandGroup heading="Online">
              {onlineWorkers.map((candidate) => (
                <WorkerItem
                  key={candidate.id}
                  worker={candidate}
                  isSelected={candidate.id === worker.id}
                  onSelect={() => pick(() => onWorkerChange(candidate.id))}
                />
              ))}
            </CommandGroup>
            {offlineWorkers.length > 0 ? (
              <CommandGroup heading="Offline">
                {offlineWorkers.map((candidate) => (
                  <WorkerItem
                    key={candidate.id}
                    worker={candidate}
                    isSelected={false}
                    onSelect={() => undefined}
                  />
                ))}
              </CommandGroup>
            ) : null}
          </DrillList>
        ) : null}

        {view === "agent" ? (
          <DrillList
            title={`Agents on ${worker.name}`}
            placeholder="Search agents…"
            onBack={() => setView("summary")}
          >
            <CommandGroup>
              {availableAgents.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  keywords={[candidate.name]}
                  data-checked={candidate.id === agent.id}
                  onSelect={() => pick(() => onAgentChange(candidate.id))}
                >
                  <AgentLogo agent={candidate} className="size-4" />
                  <span className="flex-1 truncate">{candidate.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {candidate.protocol === "acp" ? "ACP" : "Built-in"}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            {availableAgents.length === 1 ? (
              <p className="px-3 pb-3 text-xs text-muted-foreground">
                No ACP agents are installed on {worker.name}.
              </p>
            ) : null}
          </DrillList>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SummaryRow({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-sm transition-colors outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <span className="w-16 shrink-0 text-left text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** One part's list: back to the summary, search, then a bounded scrolling list. */
function DrillList({
  title,
  placeholder,
  onBack,
  children,
}: {
  title: string;
  placeholder: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");

  return (
    <Command className="rounded-none bg-transparent">
      <div className="flex h-9 items-center gap-1 px-1 pt-1">
        <Button variant="ghost" size="icon-xs" aria-label="Back" onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
        <span className="truncate text-sm font-medium">{title}</span>
      </div>
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={placeholder}
        // An empty search plus Backspace steps back, so the keyboard can walk the whole picker.
        onKeyDown={(event) => {
          if (event.key === "Backspace" && query === "") onBack();
        }}
      />
      <CommandList className="max-h-64">
        <CommandEmpty>No matches.</CommandEmpty>
        {children}
      </CommandList>
    </Command>
  );
}

function WorkerItem({
  worker,
  isSelected,
  onSelect,
}: {
  worker: DemoWorker;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={worker.id}
      keywords={[worker.name, worker.username]}
      disabled={!worker.online}
      data-checked={isSelected}
      onSelect={onSelect}
    >
      <AgentStatus
        state={worker.online ? "succeeded" : "idle"}
        label={worker.online ? "Online" : "Offline"}
        hideLabel
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate">{worker.name}</span>
        <span className="truncate text-xs text-muted-foreground">as {worker.username}</span>
      </span>
    </CommandItem>
  );
}
