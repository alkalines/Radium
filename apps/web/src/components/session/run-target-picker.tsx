import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";

import { api } from "backend/convex/_generated/api";
import type { AcpSessionListPage } from "backend/src/acp/contract";
import { isWorkerOnline } from "backend/src/worker/presence";

import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatWorkerSelection, ChatWorkerTool } from "backend/src/worker/chat-config";
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
import {
  agentAvailability,
  firstReadyWorker,
  type AcpExistingSession,
  type AcpSessionAgent,
  type AgentAvailability,
  type SessionAgent,
  type SessionAgentRow,
  type SessionProject,
  type SessionWorker,
} from "./agents";
import { workerToolsFor } from "@/components/chatroom/tool-catalog";
import { AcpAgentAuth } from "./acp/agent-auth";
import { AcpAgentIcon } from "./acp/agent-icon";

const noWorkerValue = "__no-worker__";
const noProjectValue = "__no-project__";
const addProjectValue = "__add-project__";

type View = "summary" | "project" | "worker" | "agent" | "session";

/** The Project part of the Run target picker; only a draft offers it (saved Sessions keep theirs). */
export type RunTargetProjectChoice = {
  /** Workspace new Projects are created in; without it `+ Add project` is hidden. */
  workspaceId: Id<"workspaces"> | undefined;
  /** Projects of the Session's workspace; `undefined` while loading. */
  projects: SessionProject[] | undefined;
  project: SessionProject | null;
  onProjectChange: (project: SessionProject | null) => void;
};

/** Agent artwork is supplied by the Worker; non-URL icons fall back to a letter tile. */
export function AgentLogo({ agent, className }: { agent: SessionAgent; className?: string }) {
  if (agent.protocol === "built-in") {
    return <img src="/letters/R.svg" alt="" className={cn("shrink-0", className)} />;
  }
  return <AcpAgentIcon icon={agent.icon} name={agent.name} className={className} />;
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
 * Picks where a Session runs. A summary of rows drills into one view per part; picking returns to
 * the summary, Backspace in an empty search steps back, and closing resets to the summary. View
 * switches are instant. Worker tools are picked in the Tools Dialog, and the Worker directory is
 * derived by the backend (the Project's folder for that Worker, else the Worker's temp directory),
 * so neither is chosen here.
 *
 * - A New session (under its Composer, opening upward) passes `projectChoice` and gets Project,
 *   Worker, and Agent rows. `+ Add project` opens the `ProjectDialog` and selects the new Project
 *   once the list has it.
 * - Inside a chat (the Panel's top-right corner, opening downward) only Worker and Agent show, and
 *   `isAgentFixed` makes the Agent row a plain label: a Session keeps its harness and only switches
 *   models within it.
 *
 * Only active Workers are listed, with their online state from the last heartbeat; revoked ones
 * never show. Every Worker change reports a complete `ChatWorkerSelection` without a directory (or
 * `null` for no Worker and no tools) through `onSelectionChange`; a newly picked Worker gets the
 * workspace's `defaultWorkerTools` plus the tools already chosen. The caller decides whether
 * changes are local draft state or persisted chat settings.
 */
export function RunTargetPicker({
  trigger,
  triggerLabel,
  side,
  projectChoice,
  workers,
  selection,
  defaultWorkerTools,
  agent,
  agents,
  agentRows,
  isAgentFixed,
  disabled,
  onSelectionChange,
  onAgentChange,
  existingSession,
  onExistingSessionChange,
}: {
  trigger: ReactNode;
  /** Accessible name of the trigger, e.g. `Run on build-box with Radium`. */
  triggerLabel: string;
  /** `top` under the New session Composer, `bottom` in the chat's top-right corner. */
  side: "top" | "bottom";
  projectChoice?: RunTargetProjectChoice;
  workers: SessionWorker[];
  selection: ChatWorkerSelection | null;
  defaultWorkerTools: ChatWorkerTool[];
  agent: SessionAgent;
  agents: SessionAgent[];
  agentRows?: SessionAgentRow[];
  isAgentFixed: boolean;
  disabled?: boolean;
  onSelectionChange: (selection: ChatWorkerSelection | null) => void;
  onAgentChange: (agent: SessionAgent) => void;
  /** An agent session the draft continues instead of starting a new one (Session row). */
  existingSession?: AcpExistingSession | null;
  onExistingSessionChange?: (session: AcpExistingSession | null) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>("summary");
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const selectProjectWhenListed = usePendingProjectSelection(projectChoice?.projects, (project) =>
    projectChoice?.onProjectChange(project),
  );
  const now = useWorkerPresenceClock();

  const activeWorkers = workers.filter((candidate) => candidate.status === "active");
  const selectedWorker = activeWorkers.find(
    (candidate) => candidate.workerId === selection?.workerId,
  );
  const hasWorker = Boolean(selection?.workerId);
  const availability = agentAvailability(agent, selectedWorker, now, agentRows);
  const listTarget =
    agent.protocol === "acp" &&
    agent.installation?.capabilities.list &&
    selectedWorker &&
    isWorkerOnline(selectedWorker.lastSeenAt, now) &&
    projectChoice?.workspaceId &&
    onExistingSessionChange
      ? { workspace: projectChoice.workspaceId, worker: selectedWorker.workerId, agent }
      : null;

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

  function selectAgent(next: SessionAgent) {
    if (!hasWorker && next.protocol === "acp") {
      const readyWorker = firstReadyWorker(next, activeWorkers, agentRows, now);
      if (readyWorker) selectWorker(readyWorker.workerId);
    }
    onAgentChange(next);
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

  const project = projectChoice?.project ?? null;

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
        {/* A fixed side keeps the popover from flipping when a drill-down view is taller. */}
        <PopoverContent
          side={side}
          align={side === "top" ? "center" : "end"}
          className="w-80 gap-0 overflow-hidden rounded-2xl p-0"
        >
          {view === "summary" ? (
            <div className="flex flex-col p-1">
              {projectChoice ? (
                <SummaryRow
                  label="Project"
                  disabled={projectChoice.projects === undefined}
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
              ) : null}
              <SummaryRow label="Worker" onOpen={() => setView("worker")}>
                {workerValue}
              </SummaryRow>
              <SummaryRow label="Agent" onOpen={isAgentFixed ? undefined : () => setView("agent")}>
                <AgentLogo agent={agent} className="size-4" />
                <span className="truncate">{agent.name}</span>
                {agent.protocol === "acp" && availability !== "ready" ? (
                  <span className="ml-auto text-xs text-muted-foreground">Unavailable</span>
                ) : null}
              </SummaryRow>
              {listTarget ? (
                <SummaryRow label="Session" onOpen={() => setView("session")}>
                  {existingSession ? (
                    <span className="truncate" title={existingSession.title}>
                      {existingSession.title || existingSession.sessionId}
                    </span>
                  ) : (
                    <span className="truncate">New</span>
                  )}
                </SummaryRow>
              ) : null}
            </div>
          ) : null}

          {view === "project" && projectChoice ? (
            <DrillList
              title="Projects"
              placeholder="Search projects…"
              onBack={() => setView("summary")}
            >
              <ProjectOptions
                projects={projectChoice.projects ?? []}
                project={project}
                onSelect={(next) => pick(() => projectChoice.onProjectChange(next))}
                onAddProject={projectChoice.workspaceId ? openProjectDialog : undefined}
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
                      {agent.protocol === "acp" ? (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {workerAgentLabels[agentAvailability(agent, candidate, now, agentRows)]}
                        </span>
                      ) : (
                        <WorkerPresence
                          lastSeenAt={candidate.lastSeenAt}
                          now={now}
                          className="ml-auto"
                        />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : (
                <p className="px-3 pb-3 text-xs text-muted-foreground">
                  No active Workers in this workspace. Enroll one in Settings → Workers.
                </p>
              )}
            </DrillList>
          ) : null}

          {view === "agent" ? (
            <DrillList
              title="Agents"
              placeholder="Search agents…"
              onBack={() => setView("summary")}
            >
              <CommandGroup>
                {agents.map((candidate) => {
                  const state = agentAvailability(candidate, selectedWorker, now, agentRows);
                  return (
                    <div
                      key={candidate.id}
                      className="hidden items-center gap-2 has-[[cmdk-item]]:flex"
                    >
                      <CommandItem
                        className="min-w-0 flex-1"
                        value={candidate.id}
                        keywords={[candidate.name]}
                        data-checked={candidate.id === agent.id}
                        onSelect={() => pick(() => selectAgent(candidate))}
                      >
                        <AgentLogo agent={candidate} className="size-4" />
                        <span className="flex-1 truncate">{candidate.name}</span>
                        {state !== "ready" && state !== "needs_auth" ? (
                          <span className="text-xs text-muted-foreground">
                            {agentStateLabel(state)}
                          </span>
                        ) : null}
                      </CommandItem>
                      {state === "needs_auth" &&
                      candidate.protocol === "acp" &&
                      selectedWorker &&
                      projectChoice?.workspaceId ? (
                        <div
                          className="shrink-0 pr-1"
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <AcpAgentAuth
                            workspace={projectChoice.workspaceId}
                            worker={selectedWorker.workerId}
                            agentId={candidate.agentId}
                            name={candidate.name}
                            authMethods={candidate.installation?.authMethods ?? []}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </CommandGroup>
            </DrillList>
          ) : null}
          {view === "session" && listTarget ? (
            <DrillList
              title="Sessions"
              placeholder="Search sessions…"
              onBack={() => setView("summary")}
            >
              <AgentSessionOptions
                key={`${listTarget.workspace}:${listTarget.worker}:${listTarget.agent.agentId}:${project?._id ?? ""}`}
                {...listTarget}
                project={project}
                selected={existingSession ?? null}
                onSelect={(session) => pick(() => onExistingSessionChange?.(session))}
              />
            </DrillList>
          ) : null}
        </PopoverContent>
      </Popover>

      {projectChoice?.workspaceId ? (
        <ProjectDialog
          open={isProjectDialogOpen}
          onOpenChange={setIsProjectDialogOpen}
          workspaceId={projectChoice.workspaceId}
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

function agentStateLabel(state: AgentAvailability) {
  switch (state) {
    case "ready":
      return "";
    case "needs_auth":
      return "Sign in";
    case "offline":
      return "Worker offline";
    case "no_worker":
      return "Choose a Worker";
    case "unavailable":
      return "Unavailable";
  }
}

const workerAgentLabels: Record<AgentAvailability, string> = {
  ready: "Online",
  needs_auth: "Needs sign in",
  unavailable: "Unavailable",
  offline: "Offline",
  no_worker: "Unavailable",
};

/** Mounted only while drilling into Session: pages and command subscriptions stay local. */
function AgentSessionOptions({
  workspace,
  worker,
  agent,
  project,
  selected,
  onSelect,
}: {
  workspace: Id<"workspaces">;
  worker: string;
  agent: AcpSessionAgent;
  project: SessionProject | null;
  selected: AcpExistingSession | null;
  /** `null` starts a new session; a listed one is continued by the draft's first prompt. */
  onSelect: (session: AcpExistingSession | null) => void;
}) {
  const list = useMutation(api.acp.ListAgentSessions);
  const [sessions, setSessions] = useState<AcpSessionListPage["sessions"]>([]);
  const [cursor, setCursor] = useState<string>();
  const [command, setCommand] = useState<Id<"acp_commands">>();
  const [loading, setLoading] = useState(false);
  const [listed, setListed] = useState(false);
  const [failure, setFailure] = useState<string>();
  const mounted = useRef(false);
  const started = useRef(false);
  const busy = loading || command !== undefined;
  const { data: result, error } = useQuery(
    convexQuery(api.acp.GetCommand, command ? { command } : "skip"),
  );

  async function load(nextCursor?: string) {
    if (busy) return;
    setLoading(true);
    setFailure(undefined);
    try {
      const id = await list({
        workspace,
        worker,
        agentId: agent.agentId,
        project: project?._id,
        cursor: nextCursor,
        clientId: crypto.randomUUID(),
      });
      if (mounted.current) setCommand(id);
    } catch (error) {
      if (mounted.current)
        setFailure(error instanceof Error ? error.message : "Could not list sessions.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      void load();
    }
    return () => {
      mounted.current = false;
    };
    // The keyed view fixes the target for this mount; reopening explicitly reloads its first page.
  }, []);

  useEffect(() => {
    if (
      !command ||
      (!error && result !== null && result?.status !== "done" && result?.status !== "failed")
    )
      return;
    setCommand(undefined);
    if (error || !result || result.status === "failed") {
      setFailure(
        error instanceof Error
          ? error.message
          : (result?.error ?? "Session listing is no longer available."),
      );
      return;
    }
    try {
      const page: unknown = JSON.parse(result.result ?? "");
      if (!isSessionPage(page)) throw new Error("The agent returned an invalid session list.");
      setSessions((previous) => {
        const seen = new Set(previous.map((session) => session.sessionId));
        return [...previous, ...page.sessions.filter((session) => !seen.has(session.sessionId))];
      });
      setCursor(page.nextCursor);
      setListed(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not read the session list.");
    }
  }, [command, error, result]);

  return (
    <>
      <CommandGroup>
        <CommandItem
          value="__new-session__"
          keywords={["New session"]}
          data-checked={selected === null}
          onSelect={() => onSelect(null)}
        >
          New session
        </CommandItem>
      </CommandGroup>
      <CommandGroup heading="In this directory">
        {sessions.map((session) => (
          <CommandItem
            key={session.sessionId}
            value={session.sessionId}
            keywords={[session.title ?? session.sessionId]}
            data-checked={selected?.sessionId === session.sessionId}
            onSelect={() =>
              onSelect({
                sessionId: session.sessionId,
                ...(session.title ? { title: session.title } : {}),
              })
            }
          >
            <span className="flex-1 truncate" title={session.title ?? session.sessionId}>
              {session.title || session.sessionId}
            </span>
            {session.updatedAt && Number.isFinite(Date.parse(session.updatedAt)) ? (
              <time
                dateTime={session.updatedAt}
                title={session.updatedAt}
                className="shrink-0 text-xs tabular-nums text-muted-foreground"
              >
                {formatDistanceToNowStrict(new Date(session.updatedAt), { addSuffix: true })}
              </time>
            ) : null}
          </CommandItem>
        ))}
        {cursor || failure ? (
          <CommandItem
            value="__load-more__"
            keywords={["Load more", "Retry"]}
            disabled={busy}
            onSelect={() => void load(cursor)}
          >
            {failure ? "Try again" : "Load more"}
          </CommandItem>
        ) : null}
      </CommandGroup>
      {failure || busy || (listed && sessions.length === 0) ? (
        <p role="status" className="px-3 pb-3 text-xs text-muted-foreground">
          {failure ?? (busy ? "Loading sessions…" : "No sessions in this directory.")}
        </p>
      ) : null}
    </>
  );
}

function isSessionPage(page: unknown): page is AcpSessionListPage {
  return (
    typeof page === "object" &&
    page !== null &&
    "sessions" in page &&
    Array.isArray(page.sessions) &&
    page.sessions.every(
      (session: unknown) =>
        typeof session === "object" &&
        session !== null &&
        "sessionId" in session &&
        typeof session.sessionId === "string" &&
        "cwd" in session &&
        typeof session.cwd === "string" &&
        (!("title" in session) || typeof session.title === "string") &&
        (!("updatedAt" in session) || typeof session.updatedAt === "string"),
    ) &&
    (!("nextCursor" in page) || typeof page.nextCursor === "string")
  );
}
