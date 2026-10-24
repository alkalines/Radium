import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";

import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatWorkerSelection, ChatWorkerTool } from "backend/src/worker/chat-config";
import { ProviderLogo } from "@/components/gateway/provider-logo";
import { ProjectTile } from "@/components/harness/project-tile";
import { ProjectDialog } from "@/components/projects/project-dialog";
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
import { WorkerPresence, useWorkerPresenceClock } from "@/components/workspaces/worker-presence";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";
import { cn } from "@/lib/utils";
import type { SessionAgent, SessionProject, SessionWorker } from "./agents";
import { workerToolsFor } from "@/components/chatroom/tool-catalog";

const noWorkerValue = "__no-worker__";
const noProjectValue = "__no-project__";
const addProjectValue = "__add-project__";

type View = "summary" | "project" | "worker" | "agent";

/** Agent artwork inside the picker: ACP agents use their provider logo, Radium its letter. */
export function AgentLogo({ agent, className }: { agent: SessionAgent; className?: string }) {
  if (agent.logo) return <ProviderLogo slug={agent.logo} className={className} />;
  return <img src="/letters/R.svg" alt="" className={cn("shrink-0", className)} />;
}

/** A Project's tile: its color and icon, the same mark as in Tabs and the Home list. */
export function SessionProjectTile({
  project,
  className,
}: {
  project: { color?: string; icon?: string };
  className?: string;
}) {
  return (
    <ProjectTile color={project.color} className={className}>
      <WorkspaceIcon name={project.icon} />
    </ProjectTile>
  );
}

/**
 * Picks where a Session runs: Project, Worker, and the Agent. A summary of rows drills into one
 * view per part; picking returns to the summary, Backspace in an empty search steps back, and
 * closing resets to the summary. View switches are instant. Worker tools are picked in the Tools
 * Dialog, and the Worker directory is derived by the backend (the Project's folder for that
 * Worker, else the Worker's temp directory), so neither is chosen here.
 *
 * Workers are listed as active (selectable, with their online state from the last heartbeat) or
 * revoked (disabled). Every Worker change reports a complete `ChatWorkerSelection` without a
 * directory (or `null` for no Worker and no tools) through `onSelectionChange`; a newly picked
 * Worker gets the workspace's `defaultWorkerTools` plus the tools already chosen. The caller
 * decides whether changes are local draft state or persisted chat settings. `+ Add project` opens
 * the `ProjectDialog` and selects the new Project once the list has it.
 */
export function RunTargetPicker({
  trigger,
  triggerLabel,
  workspaceId,
  projects,
  project,
  workers,
  selection,
  defaultWorkerTools,
  agent,
  agents,
  disabled,
  onProjectChange,
  onSelectionChange,
  onAgentChange,
}: {
  trigger: ReactNode;
  /** Accessible name of the trigger, e.g. `Run on build-box with Radium`. */
  triggerLabel: string;
  /** Workspace new Projects are created in; without it `+ Add project` is hidden. */
  workspaceId: Id<"workspaces"> | undefined;
  /** Projects of the Session's workspace; `undefined` while loading. */
  projects: SessionProject[] | undefined;
  project: SessionProject | null;
  workers: SessionWorker[];
  selection: ChatWorkerSelection | null;
  defaultWorkerTools: ChatWorkerTool[];
  agent: SessionAgent;
  agents: SessionAgent[];
  disabled?: boolean;
  onProjectChange: (project: SessionProject | null) => void;
  onSelectionChange: (selection: ChatWorkerSelection | null) => void;
  onAgentChange: (agent: SessionAgent) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>("summary");
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const selectProjectWhenListed = usePendingProjectSelection(projects, onProjectChange);
  const now = useWorkerPresenceClock();

  const activeWorkers = workers.filter((candidate) => candidate.status === "active");
  const revokedWorkers = workers.filter((candidate) => candidate.status !== "active");
  const selectedWorker = activeWorkers.find(
    (candidate) => candidate.workerId === selection?.workerId,
  );
  const hasWorker = Boolean(selection?.workerId);

  function handleOpenChange(open: boolean) {
    setIsOpen(open);
    if (!open) setView("summary");
  }

  function pick(apply: () => void) {
    apply();
    setView("summary");
  }

  function selectWorker(workerId: string | null) {
    const chosenTools = selection?.tools ?? [];
    if (workerId === null) {
      // Tools chosen so far stay as a Worker-less selection; nothing chosen means no selection.
      onSelectionChange(chosenTools.length > 0 ? { tools: chosenTools } : null);
      return;
    }
    if (workerId === selection?.workerId) return;
    onSelectionChange({ workerId, tools: workerToolsFor(defaultWorkerTools, chosenTools) });
  }

  function openProjectDialog() {
    // The Dialog replaces the popover so focus moves into one surface at a time.
    handleOpenChange(false);
    setIsProjectDialogOpen(true);
  }

  let workerValue: ReactNode = <span className="text-muted-foreground">No Worker</span>;
  if (selectedWorker) {
    workerValue = (
      <>
        <span className="truncate">{selectedWorker.name}</span>
        <WorkerPresence lastSeenAt={selectedWorker.lastSeenAt} now={now} className="ml-auto" />
      </>
    );
  } else if (hasWorker) {
    workerValue = <span className="text-muted-foreground">Worker unavailable</span>;
  }

  return (
    <>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled}
            className="min-w-0 text-muted-foreground"
            aria-label={triggerLabel}
          >
            {trigger}
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        {/*
          Opens upward: the row sits under the Composer and near the bottom once docked, and a
          fixed side keeps the popover from flipping when a drill-down view is taller.
        */}
        <PopoverContent
          side="top"
          align="center"
          className="w-80 gap-0 overflow-hidden rounded-2xl p-0"
        >
          {view === "summary" ? (
            <div className="flex flex-col p-1">
              <SummaryRow
                label="Project"
                disabled={projects === undefined}
                onOpen={() => setView("project")}
              >
                {project ? (
                  <>
                    <SessionProjectTile project={project} />
                    <span className="truncate">{project.name}</span>
                  </>
                ) : (
                  <span className="truncate text-muted-foreground">No project</span>
                )}
              </SummaryRow>
              <SummaryRow label="Worker" onOpen={() => setView("worker")}>
                {workerValue}
              </SummaryRow>
              <SummaryRow label="Agent" onOpen={() => setView("agent")}>
                <AgentLogo agent={agent} className="size-4" />
                <span className="truncate">{agent.name}</span>
              </SummaryRow>
            </div>
          ) : null}

          {view === "project" ? (
            <DrillList
              title="Projects"
              placeholder="Search projects…"
              onBack={() => setView("summary")}
            >
              <ProjectOptions
                projects={projects ?? []}
                project={project}
                onSelect={(next) => pick(() => onProjectChange(next))}
                onAddProject={workspaceId ? openProjectDialog : undefined}
              />
            </DrillList>
          ) : null}

          {view === "worker" ? (
            <DrillList
              title="Workers"
              placeholder="Search workers…"
              onBack={() => setView("summary")}
            >
              <CommandGroup>
                <CommandItem
                  value={noWorkerValue}
                  keywords={["No Worker", "none"]}
                  data-checked={!hasWorker}
                  onSelect={() => pick(() => selectWorker(null))}
                >
                  <span className="truncate">No Worker</span>
                </CommandItem>
              </CommandGroup>
              {activeWorkers.length > 0 ? (
                <CommandGroup heading="Active">
                  {activeWorkers.map((candidate) => (
                    <CommandItem
                      key={candidate.workerId}
                      value={candidate.workerId}
                      keywords={[candidate.name]}
                      data-checked={candidate.workerId === selection?.workerId}
                      onSelect={() => pick(() => selectWorker(candidate.workerId))}
                    >
                      <span className="truncate">{candidate.name}</span>
                      <WorkerPresence
                        lastSeenAt={candidate.lastSeenAt}
                        now={now}
                        className="ml-auto"
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {revokedWorkers.length > 0 ? (
                <CommandGroup heading="Revoked">
                  {revokedWorkers.map((candidate) => (
                    <CommandItem
                      key={candidate.workerId}
                      value={candidate.workerId}
                      keywords={[candidate.name]}
                      disabled
                    >
                      <span className="truncate">{candidate.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {activeWorkers.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-muted-foreground">
                  No active Workers in this workspace. Enroll one in Settings → Workers.
                </p>
              ) : null}
            </DrillList>
          ) : null}

          {view === "agent" ? (
            <DrillList
              title={selectedWorker ? `Agents on ${selectedWorker.name}` : "Agents"}
              placeholder="Search agents…"
              onBack={() => setView("summary")}
            >
              <CommandGroup>
                {agents.map((candidate) => (
                  <CommandItem
                    key={candidate.id}
                    value={candidate.id}
                    keywords={[candidate.name]}
                    data-checked={candidate.id === agent.id}
                    onSelect={() => pick(() => onAgentChange(candidate))}
                  >
                    <AgentLogo agent={candidate} className="size-4" />
                    <span className="flex-1 truncate">{candidate.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {candidate.protocol === "acp" ? "ACP" : "Built-in"}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <p className="px-3 pb-3 text-xs text-muted-foreground">ACP agents are planned.</p>
            </DrillList>
          ) : null}
        </PopoverContent>
      </Popover>

      {workspaceId ? (
        <ProjectDialog
          open={isProjectDialogOpen}
          onOpenChange={setIsProjectDialogOpen}
          workspaceId={workspaceId}
          isOwner
          onCreated={selectProjectWhenListed}
        />
      ) : null}
    </>
  );
}

/**
 * Project chip for people who may manage the Session but not its Worker (workspace members, or an
 * owner while the Worker is fixed): Projects are not owner-only, so they pick or add one here
 * while the Worker stays a plain label.
 */
export function ProjectPicker({
  workspaceId,
  isOwner,
  projects,
  project,
  disabled,
  onProjectChange,
}: {
  /** Workspace new Projects are created in; without it `+ Add project` is hidden. */
  workspaceId: Id<"workspaces"> | undefined;
  isOwner: boolean;
  /** Projects of the Session's workspace; `undefined` while loading. */
  projects: SessionProject[] | undefined;
  project: SessionProject | null;
  disabled?: boolean;
  onProjectChange: (project: SessionProject | null) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const selectProjectWhenListed = usePendingProjectSelection(projects, onProjectChange);

  return (
    <>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled || projects === undefined}
            className="min-w-0 text-muted-foreground"
            aria-label={project ? `Project ${project.name}` : "Choose a project"}
          >
            {project ? (
              <>
                <SessionProjectTile project={project} />
                <span className="truncate">{project.name}</span>
              </>
            ) : (
              <span className="truncate">No project</span>
            )}
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        {/* Opens upward like the Run target picker; the chip sits under the Composer. */}
        <PopoverContent
          side="top"
          align="center"
          className="w-72 gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Command className="rounded-none bg-transparent">
            <CommandInput autoFocus placeholder="Search projects…" />
            <CommandList className="max-h-64">
              <CommandEmpty>No matches.</CommandEmpty>
              <ProjectOptions
                projects={projects ?? []}
                project={project}
                onSelect={(next) => {
                  onProjectChange(next);
                  setIsOpen(false);
                }}
                onAddProject={
                  workspaceId
                    ? () => {
                        setIsOpen(false);
                        setIsProjectDialogOpen(true);
                      }
                    : undefined
                }
              />
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {workspaceId ? (
        <ProjectDialog
          open={isProjectDialogOpen}
          onOpenChange={setIsProjectDialogOpen}
          workspaceId={workspaceId}
          isOwner={isOwner}
          onCreated={selectProjectWhenListed}
        />
      ) : null}
    </>
  );
}

/**
 * Selects a Project created from `+ Add project` as soon as `projects` lists it. The create
 * mutation can resolve before the list subscription updates, and the caller needs the full
 * Project (its Workers) rather than the bare id.
 */
function usePendingProjectSelection(
  projects: SessionProject[] | undefined,
  onProjectChange: (project: SessionProject | null) => void,
) {
  const pendingId = useRef<Id<"projects">>(undefined);
  const latestOnProjectChange = useRef(onProjectChange);
  useLayoutEffect(() => {
    latestOnProjectChange.current = onProjectChange;
  });

  useEffect(() => {
    const created = projects?.find((candidate) => candidate._id === pendingId.current);
    if (!created) return;
    pendingId.current = undefined;
    latestOnProjectChange.current(created);
  }, [projects]);

  return (projectId: Id<"projects">) => {
    const listed = projects?.find((candidate) => candidate._id === projectId);
    if (listed) {
      onProjectChange(listed);
      return;
    }
    pendingId.current = projectId;
  };
}

/** `No project`, the workspace's Projects with their tiles, then `+ Add project`. */
function ProjectOptions({
  projects,
  project,
  onSelect,
  onAddProject,
}: {
  projects: SessionProject[];
  project: SessionProject | null;
  onSelect: (project: SessionProject | null) => void;
  onAddProject?: () => void;
}) {
  return (
    <>
      <CommandGroup>
        <CommandItem
          value={noProjectValue}
          keywords={["No project", "none"]}
          data-checked={project === null}
          onSelect={() => onSelect(null)}
        >
          <span className="truncate">No project</span>
        </CommandItem>
      </CommandGroup>
      {projects.length > 0 ? (
        <CommandGroup heading="Projects">
          {projects.map((candidate) => (
            <CommandItem
              key={candidate._id}
              value={candidate._id}
              keywords={[candidate.name]}
              data-checked={candidate._id === project?._id}
              onSelect={() => onSelect(candidate)}
            >
              <SessionProjectTile project={candidate} />
              <span className="truncate">{candidate.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {onAddProject ? (
        <CommandGroup>
          <CommandItem
            value={addProjectValue}
            keywords={["Add project", "new", "create"]}
            onSelect={onAddProject}
          >
            <PlusIcon />
            <span className="truncate">Add project</span>
          </CommandItem>
        </CommandGroup>
      ) : null}
    </>
  );
}

/** One summary row; rows without `onOpen` (or `disabled`) render as inert labels. */
function SummaryRow({
  label,
  disabled,
  onOpen,
  children,
}: {
  label: string;
  disabled?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled || !onOpen}
      onClick={onOpen}
      className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-sm transition-colors outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="w-18 shrink-0 text-left text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {disabled || !onOpen ? null : (
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function DrillHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex h-9 items-center gap-1 px-1 pt-1">
      <Button variant="ghost" size="icon-xs" aria-label="Back" onClick={onBack}>
        <ChevronLeftIcon />
      </Button>
      <span className="truncate text-sm font-medium">{title}</span>
    </div>
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
      <DrillHeader title={title} onBack={onBack} />
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
