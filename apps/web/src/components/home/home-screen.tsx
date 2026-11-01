import { Component, useEffect, useState, type ReactNode } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { usePaginatedQuery } from "convex-helpers/react/cache";
import {
  FolderMinusIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  RotateCcwIcon,
  SquarePenIcon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { isWorkerOnline } from "backend/src/worker/presence";
import { AgentStatus } from "@/components/agentic/agent-status";
import { ProjectActionsMenu } from "@/components/projects/project-actions-menu";
import { ProjectDialog } from "@/components/projects/project-dialog";
import { AcpAgentIcon } from "@/components/session/acp/agent-icon";
import { acpActionError } from "@/components/session/acp/use-acp-session";
import type { SessionAgentDefinition, SessionWorker } from "@/components/session/agents";
import { useWorkerPresenceClock } from "@/components/workspaces/worker-presence";
import { ProjectGlyph, type ProjectSummary } from "@/components/projects/project-glyph";
import {
  SideColumnItem,
  SideColumnLayout,
  SideColumnSearch,
  SideColumnSection,
} from "@/components/harness/side-column";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { newTabId } from "@/components/window/window-tabs";
import { SessionActionsMenu } from "./session-actions-menu";
import { AgentSessions, useOpenAgentSession } from "./agent-sessions";
import { HOME_PAGE_SIZE, useMergedPages, type PagedSource } from "./merged-pages";
import { formatRelativeTime, groupByRecency } from "./recency";

type HomeSession = FunctionReturnType<typeof api.aisdk.ListPinnedChats>[number];
type UnopenedAgentSession = FunctionReturnType<
  typeof api.acp.ListUnopenedAgentSessions
>["page"][number];
type RowAgent = Pick<SessionAgentDefinition, "name" | "icon">;

/**
 * A Home Row: a Radium session, or (for the owner) an agent session that Radium has not opened
 * yet, such as one started in Zed or the agent's own CLI.
 */
type HomeRow =
  | { kind: "chat"; id: string; title: string; at: number; session: HomeSession }
  | {
      kind: "agent";
      id: string;
      title: string;
      at: number;
      row: UnopenedAgentSession;
      agent: RowAgent;
    };

const minute = 60_000;

/**
 * A Home session filter, remembered with the workspace it was picked in. `project: null` is the
 * `No project` filter (sessions outside every Project).
 */
type ProjectSelection = { workspace: Id<"workspaces">; project: Id<"projects"> | null };

/**
 * Home (`docs/Interface_Design.md` §5.1): a side column with `New session`, a small search, and
 * the workspace's Projects, plus its sessions grouped by recency as plain Rows on the Panel.
 * Selecting a Project, or `No project`, filters the list (selecting it again, or `All sessions`,
 * clears the filter); for the owner every list also holds the agent sessions not yet opened in
 * Radium. Opening a Row navigates to its session, which focuses or appends its Tab.
 */
export function HomeScreen() {
  const navigate = useNavigate();
  const {
    workspace,
    workspaceId,
    isLoading: isWorkspaceLoading,
    isProvisioning,
    provisionError,
    retryProvisioning,
  } = useWorkspace();
  const [query, setQuery] = useState("");
  const [projectSelection, setProjectSelection] = useState<ProjectSelection | null>(null);
  const [agentSelection, setAgentSelection] = useState<{
    workspace: Id<"workspaces">;
    agentId: string;
  } | null>(null);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const now = useMinuteClock();
  const presenceNow = useWorkerPresenceClock();
  const isOwner = workspace?.role === "owner";
  const ownerArgs = workspaceId && isOwner ? { workspace: workspaceId } : "skip";
  const { data: workers } = useQuery(convexQuery(api.workers.list, ownerArgs));
  const { data: definitions } = useQuery(convexQuery(api.acp.ListAgentDefinitions, ownerArgs));
  const { data: agentRows } = useQuery(convexQuery(api.acp.ListAgents, ownerArgs));
  const activeWorkers = (workers ?? []).filter((worker) => worker.status === "active");
  const activeWorkerIds = new Set(activeWorkers.map((worker) => worker.workerId));
  const agents = (definitions ?? []).filter(
    (definition) =>
      definition.enabled &&
      agentRows?.some(
        (row) =>
          row.agentId === definition.agentId &&
          row.capabilities?.list &&
          activeWorkerIds.has(row.worker),
      ),
  );
  const selectedAgent =
    agentSelection && agentSelection.workspace === workspaceId
      ? agents.find((agent) => agent.agentId === agentSelection.agentId)
      : undefined;

  const { data: projectsData, error: projectsError } = useQuery(
    convexQuery(api.projects.list, workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const projects = Array.isArray(projectsData) ? projectsData : [];
  // A selection made in another workspace, or of a Project deleted since, shows all sessions.
  const isSelectionCurrent =
    projectSelection !== null && projectSelection.workspace === workspaceId;
  const isNoProjectSelected = isSelectionCurrent && projectSelection.project === null;
  let selectedProject: ProjectSummary | undefined;
  if (isSelectionCurrent) {
    selectedProject = projects.find((project) => project._id === projectSelection.project);
  }
  // `undefined` lists every session; `null` lists sessions without a Project.
  let projectFilter: Id<"projects"> | null | undefined = selectedProject?._id;
  if (isNoProjectSelected) projectFilter = null;

  // Refreshes the agents' session indexes whenever the owner looks at a session list, as opening
  // an agent under Agents does; the backend skips offline Workers and anything synced in the
  // last minute.
  const syncAgentSessions = useMutation(api.acp.SyncAgentSessions);
  const agentIdsToSync =
    isOwner && !selectedAgent ? agents.map((agent) => agent.agentId).join("\n") : "";
  const filterKey = `${workspaceId}:${String(projectFilter)}`;
  useEffect(() => {
    if (!workspaceId || !agentIdsToSync) return;
    for (const agentId of agentIdsToSync.split("\n")) {
      void syncAgentSessions({ workspace: workspaceId, agentId }).catch((error) => {
        const message = acpActionError(error);
        if (message) toast.error(message);
      });
    }
  }, [agentIdsToSync, filterKey, syncAgentSessions, workspaceId]);

  const workspaceName = workspace?.name ?? "workspace";

  /** Starts a draft Tab; with `project`, the Session screen seeds the draft's Project from it. */
  function openNewSession(project?: Id<"projects">) {
    void navigate({ to: "/chat", search: { draft: newTabId(), project } });
  }

  /** Selects a Project (or `null`, No project); selecting the current filter again clears it. */
  function toggleProject(project: Id<"projects"> | null) {
    setAgentSelection(null);
    if (!workspaceId || (projectFilter !== undefined && projectFilter === project)) {
      setProjectSelection(null);
      return;
    }
    setProjectSelection({ workspace: workspaceId, project });
  }

  let empty;
  if (selectedProject) {
    empty = (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareDashedIcon />
          </EmptyMedia>
          <EmptyTitle>No sessions in {selectedProject.name}</EmptyTitle>
          <EmptyDescription>Start one here, or move a session in from its … menu.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (isNoProjectSelected) {
    empty = (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareDashedIcon />
          </EmptyMedia>
          <EmptyTitle>Every session is in a project</EmptyTitle>
          <EmptyDescription>Sessions without a project appear here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    empty = (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareDashedIcon />
          </EmptyMedia>
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>Sessions in {workspaceName} appear here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => openNewSession()}>
            <SquarePenIcon data-icon="inline-start" />
            New session
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  let content;
  if (provisionError) {
    content = (
      <Alert variant="destructive">
        <AlertTitle>Workspace setup failed</AlertTitle>
        <AlertDescription>{provisionError.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={retryProvisioning}>
            <RotateCcwIcon data-icon="inline-start" />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  } else if (isWorkspaceLoading || isProvisioning || !workspaceId) {
    content = <SessionListSkeleton />;
  } else {
    // Keyed by filter: a new filter starts over at one page.
    content = (
      <SessionListBoundary key={filterKey}>
        <SessionList
          workspaceId={workspaceId}
          projectFilter={projectFilter}
          isOwner={isOwner}
          query={query}
          now={now}
          presenceNow={presenceNow}
          projects={projects}
          definitions={definitions}
          workers={workers}
          empty={empty}
        />
      </SessionListBoundary>
    );
  }

  let projectList;
  if (projectsError || typeof projectsData === "string") {
    projectList = <p className="px-3 text-sm text-muted-foreground">Projects unavailable</p>;
  } else if (projectsData !== undefined && projects.length === 0) {
    projectList = (
      <>
        {isOwner ? (
          <SideColumnItem
            isActive={!selectedAgent}
            onClick={() => {
              setProjectSelection(null);
              setAgentSelection(null);
            }}
          >
            <MessagesSquareIcon /> All sessions
          </SideColumnItem>
        ) : null}
        <p className="px-3 text-sm text-muted-foreground">No projects yet</p>
      </>
    );
  } else if (projects.length > 0) {
    projectList = (
      <>
        <SideColumnItem
          isActive={projectFilter === undefined && !selectedAgent}
          onClick={() => {
            setProjectSelection(null);
            setAgentSelection(null);
          }}
        >
          <MessagesSquareIcon />
          All sessions
        </SideColumnItem>
        <SideColumnItem isActive={isNoProjectSelected} onClick={() => toggleProject(null)}>
          <FolderMinusIcon />
          No project
        </SideColumnItem>
        {projects.map((project) => (
          <SideColumnItem
            key={project._id}
            isActive={project._id === selectedProject?._id}
            title={project.name}
            onClick={() => toggleProject(project._id)}
          >
            <ProjectGlyph project={project} />
            <span className="truncate">{project.name}</span>
          </SideColumnItem>
        ))}
      </>
    );
  }

  return (
    <SideColumnLayout
      side={
        <>
          <div className="flex flex-col gap-2">
            <SideColumnItem onClick={() => openNewSession()}>
              <SquarePenIcon />
              New session
            </SideColumnItem>
            <SideColumnSearch
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${workspaceName}`}
              aria-label={`Search sessions in ${workspaceName}`}
            />
          </div>

          <SideColumnSection
            title="Projects"
            action={
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="New project"
                    disabled={!workspaceId}
                    onClick={() => setIsCreateProjectOpen(true)}
                  >
                    <FolderPlusIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New project</TooltipContent>
              </Tooltip>
            }
          >
            {projectList}
          </SideColumnSection>
          {isOwner && agents.length > 0 ? (
            <SideColumnSection title="Agents">
              {agents.map((agent) => (
                <SideColumnItem
                  key={agent.agentId}
                  isActive={selectedAgent?.agentId === agent.agentId}
                  onClick={() => {
                    setProjectSelection(null);
                    setAgentSelection(
                      selectedAgent?.agentId === agent.agentId || !workspaceId
                        ? null
                        : { workspace: workspaceId, agentId: agent.agentId },
                    );
                  }}
                >
                  <AcpAgentIcon icon={agent.icon} name={agent.name} className="size-4" />
                  <span className="truncate">{agent.name}</span>
                </SideColumnItem>
              ))}
            </SideColumnSection>
          ) : null}

          {workspaceId ? (
            <ProjectDialog
              open={isCreateProjectOpen}
              onOpenChange={setIsCreateProjectOpen}
              workspaceId={workspaceId}
              isOwner={isOwner}
              onCreated={(project) => {
                setAgentSelection(null);
                setProjectSelection({ workspace: workspaceId, project });
              }}
            />
          ) : null}
        </>
      }
      contentClassName="gap-6"
    >
      {selectedProject && workspaceId ? (
        <header className="flex h-10 items-center gap-2.5 pr-1.5 pl-3">
          <ProjectGlyph project={selectedProject} />
          <h1
            className="min-w-0 flex-1 truncate text-base font-medium"
            title={selectedProject.name}
          >
            {selectedProject.name}
          </h1>
          <Button variant="ghost" size="sm" onClick={() => openNewSession(selectedProject._id)}>
            <SquarePenIcon data-icon="inline-start" />
            New session
          </Button>
          {selectedProject.canManage ? (
            <ProjectActionsMenu
              project={selectedProject}
              workspaceId={workspaceId}
              isOwner={isOwner}
            />
          ) : null}
        </header>
      ) : null}
      {isNoProjectSelected ? (
        <header className="flex h-10 items-center gap-2.5 pr-1.5 pl-3">
          <FolderMinusIcon className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="min-w-0 flex-1 truncate text-base font-medium">No project</h1>
          <Button variant="ghost" size="sm" onClick={() => openNewSession()}>
            <SquarePenIcon data-icon="inline-start" />
            New session
          </Button>
          {/* Keeps the New session button where it sits in a Project header with a … menu. */}
          <span aria-hidden="true" className="size-8 shrink-0" />
        </header>
      ) : null}
      {selectedAgent && workspaceId ? (
        <AgentSessions
          key={`${workspaceId}:${selectedAgent.agentId}`}
          workspace={workspaceId}
          agent={selectedAgent}
          reports={(agentRows ?? []).filter(
            (row) => row.agentId === selectedAgent.agentId && activeWorkerIds.has(row.worker),
          )}
          workers={activeWorkers}
          workersLoaded={workers !== undefined}
          projects={projects}
          query={query}
          now={now}
          presenceNow={presenceNow}
        />
      ) : (
        content
      )}
    </SideColumnLayout>
  );
}

/** A failed list query (the workspace or Project became unavailable) shows a notice, not a crash. */
class SessionListBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert>
        <AlertTitle>Sessions unavailable</AlertTitle>
        <AlertDescription>
          This workspace is no longer available to your account. Choose another workspace from the
          Tab strip.
        </AlertDescription>
      </Alert>
    );
  }
}

/**
 * One filter's session list: pinned sessions, then the Radium sessions and (for the owner) the
 * unopened agent sessions merged by recency, `HOME_PAGE_SIZE` rows at a time. Both lists are
 * paginated on the server, and their subscriptions outlive the screen for five minutes
 * (`ConvexQueryCacheProvider`), so returning Home reuses the loaded pages.
 */
function SessionList({
  workspaceId,
  projectFilter,
  isOwner,
  query,
  now,
  presenceNow,
  projects,
  definitions,
  workers,
  empty,
}: {
  workspaceId: Id<"workspaces">;
  /** `undefined` lists every session; `null` lists sessions without a Project. */
  projectFilter: Id<"projects"> | null | undefined;
  isOwner: boolean;
  query: string;
  now: number;
  presenceNow: number;
  projects: ProjectSummary[];
  definitions: SessionAgentDefinition[] | undefined;
  workers: SessionWorker[] | undefined;
  empty: ReactNode;
}) {
  const filter = { workspace: workspaceId, project: projectFilter };
  const { data: pinned, error: pinnedError } = useQuery({
    ...convexQuery(api.aisdk.ListPinnedChats, filter),
    gcTime: 5 * minute,
  });
  const chats = usePaginatedQuery(api.aisdk.ListChats, filter, {
    initialNumItems: HOME_PAGE_SIZE,
    customPagination: true,
  });
  const agentSessions = usePaginatedQuery(
    api.acp.ListUnopenedAgentSessions,
    isOwner ? filter : "skip",
    { initialNumItems: HOME_PAGE_SIZE, customPagination: true },
  );
  const { pending: openingAgentSessions, openRow: openAgentSession } = useOpenAgentSession();
  if (pinnedError) throw pinnedError;

  const definitionsById = new Map((definitions ?? []).map((agent) => [agent.agentId, agent]));
  const sources: PagedSource<HomeRow>[] = [
    { items: chats.results.map(chatRow), status: chats.status, loadMore: chats.loadMore },
    isOwner
      ? {
          items: agentSessions.results.map((row) => ({
            kind: "agent" as const,
            id: row._id,
            title: row.title?.trim() || "Untitled session",
            at: row.updatedAt,
            row,
            agent: definitionsById.get(row.agentId) ?? { name: row.agentId },
          })),
          status: agentSessions.status,
          loadMore: agentSessions.loadMore,
        }
      : { items: [], status: "Exhausted", loadMore: () => {} },
  ];
  const merged = useMergedPages(sources, (row) => row.at);

  // Agent rows wait for the agent catalog so their icons do not pop in.
  if (merged.loading || pinned === undefined || (isOwner && definitions === undefined)) {
    return <SessionListSkeleton />;
  }
  const rows = [...pinned.map(chatRow), ...merged.items];
  if (rows.length === 0 && !merged.hasMore) return empty;

  const normalizedQuery = query.trim().toLowerCase();
  const groups = groupByRecency(
    rows.filter((row) => row.title.toLowerCase().includes(normalizedQuery)),
    now,
    (row) => row.at,
    (row) => row.kind === "chat" && Boolean(row.session.pinnedAt),
  );
  const projectsById = new Map(projects.map((project) => [project._id, project]));

  return (
    <>
      {groups.length === 0 && rows.length > 0 ? (
        <p className="px-3 text-sm text-muted-foreground">No loaded sessions match “{query}”.</p>
      ) : null}
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <h2 className="flex h-8 items-center px-3 text-sm font-normal text-subtle-foreground">
            {group.label}
          </h2>
          {/* Rows sit directly on the Panel; only the hovered or menu-open Row gets a surface. */}
          <ul className="flex flex-col">
            {group.sessions.map((row) =>
              row.kind === "chat" ? (
                <SessionRow
                  key={row.id}
                  session={row.session}
                  project={row.session.project ? projectsById.get(row.session.project) : undefined}
                  projects={projects}
                  now={now}
                  offline={
                    isOwner &&
                    row.session.agent !== null &&
                    isWorkerOffline(workers, row.session.agent.worker, presenceNow)
                  }
                />
              ) : (
                <AgentSessionRow
                  key={row.id}
                  title={row.title}
                  untitled={!row.row.title?.trim()}
                  updatedAt={row.at}
                  agent={row.agent}
                  project={row.row.project ? projectsById.get(row.row.project) : undefined}
                  now={now}
                  offline={isWorkerOffline(workers, row.row.worker, presenceNow)}
                  opening={openingAgentSessions.has(row.id)}
                  onOpen={() => void openAgentSession(workspaceId, row.row)}
                />
              ),
            )}
          </ul>
        </div>
      ))}
      {merged.loadingMore ? (
        <Spinner className="self-center text-muted-foreground" />
      ) : merged.hasMore ? (
        <Button variant="outline" size="sm" className="self-center" onClick={merged.showMore}>
          Load more
        </Button>
      ) : null}
    </>
  );
}

function chatRow(session: HomeSession): HomeRow {
  return {
    kind: "chat",
    id: session.id,
    title: sessionTitle(session),
    at: session.lastInteractionAt,
    session,
  };
}

function SessionRow({
  session,
  project,
  projects,
  now,
  offline,
}: {
  session: HomeSession;
  /** The session's Project, when it has one and it is in the list. */
  project: ProjectSummary | undefined;
  projects: ProjectSummary[];
  now: number;
  offline: boolean;
}) {
  const title = sessionTitle(session);

  return (
    <li className="group/session relative flex h-10 items-center gap-2.5 rounded-xl pr-1.5 pl-3 text-sm transition-colors hover:bg-accent has-data-[state=open]:bg-accent">
      <SessionGlyph session={session} project={project} />
      {/* The overlay makes the whole Row open the session; the menu sits above it. */}
      <Link
        to="/chat/$chatId"
        params={{ chatId: session.id }}
        title={title}
        className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
      >
        {session.title?.trim() ? title : <span className="text-muted-foreground">{title}</span>}
      </Link>
      <time
        dateTime={new Date(session.lastInteractionAt).toISOString()}
        title={new Date(session.lastInteractionAt).toLocaleString()}
        className="shrink-0 text-xs text-subtle-foreground tabular-nums"
      >
        {formatRelativeTime(session.lastInteractionAt, now)}
      </time>
      {session.agent ? (
        <span
          className="max-w-32 truncate text-xs text-muted-foreground"
          title={session.agent.name}
        >
          {session.agent.name}
        </span>
      ) : null}
      {offline ? <span className="shrink-0 text-xs text-muted-foreground">Offline</span> : null}
      {session.canManage ? (
        <SessionActionsMenu session={session} projects={projects} />
      ) : (
        // Keeps the time aligned with Rows that have a menu.
        <span aria-hidden="true" className="size-6 shrink-0" />
      )}
    </li>
  );
}

/**
 * An agent session Radium has not opened yet. It reads like a Session Row: the Project tile when
 * its directory is a Project folder (otherwise the agent's icon), the title, time and agent name;
 * opening it creates the bound session, then opens it.
 */
function AgentSessionRow({
  title,
  untitled,
  updatedAt,
  agent,
  project,
  now,
  offline,
  opening,
  onOpen,
}: {
  title: string;
  untitled: boolean;
  updatedAt: number;
  agent: RowAgent;
  project: ProjectSummary | undefined;
  now: number;
  offline: boolean;
  opening: boolean;
  onOpen: () => void;
}) {
  return (
    <li className="group/session relative flex h-10 items-center gap-2.5 rounded-xl pr-1.5 pl-3 text-sm transition-colors hover:bg-accent">
      {opening ? (
        <Spinner className="size-4 shrink-0 text-muted-foreground" />
      ) : project ? (
        <ProjectGlyph project={project} />
      ) : (
        <AcpAgentIcon icon={agent.icon} name={agent.name} className="size-4" />
      )}
      {/* The overlay makes the whole Row open the session, like a Session Row's link. */}
      <button
        type="button"
        onClick={onOpen}
        disabled={opening}
        title={title}
        className="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
      >
        {untitled ? <span className="text-muted-foreground">{title}</span> : title}
      </button>
      <time
        dateTime={new Date(updatedAt).toISOString()}
        title={new Date(updatedAt).toLocaleString()}
        className="shrink-0 text-xs text-subtle-foreground tabular-nums"
      >
        {formatRelativeTime(updatedAt, now)}
      </time>
      <span className="max-w-32 truncate text-xs text-muted-foreground" title={agent.name}>
        {agent.name}
      </span>
      {offline ? <span className="shrink-0 text-xs text-muted-foreground">Offline</span> : null}
      {/* Keeps the time aligned with Rows that have a menu. */}
      <span aria-hidden="true" className="size-6 shrink-0" />
    </li>
  );
}

/**
 * Leading visual of a Row: a streaming session shows its RunState, a session in a Project shows
 * the Project tile, and otherwise the generated chat emoji (or a plain session icon).
 */
function SessionGlyph({
  session,
  project,
}: {
  session: HomeSession;
  project: ProjectSummary | undefined;
}) {
  if (session.activeStream) {
    return (
      <AgentStatus state="streaming" label="Generating" hideLabel className="w-4 justify-center" />
    );
  }

  if (project) {
    return <ProjectGlyph project={project} />;
  }

  if (session.emoji) {
    return (
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
        {session.emoji}
      </span>
    );
  }

  return <MessageSquareTextIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function SessionListSkeleton() {
  return (
    <div className="flex flex-col gap-1" aria-busy="true" aria-label="Loading sessions">
      <Skeleton className="mx-3 my-2 h-4 w-16" />
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex h-10 items-center gap-2.5 px-3">
          <Skeleton className="size-4 rounded-[3px]" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

/** Owner-only presence: unknown Workers count as offline once the Worker list has loaded. */
function isWorkerOffline(
  workers: readonly { workerId: string; status: string; lastSeenAt?: number }[] | undefined,
  workerId: string,
  now: number,
) {
  if (!workers || now === 0) return false;
  const worker = workers.find((item) => item.workerId === workerId);
  return !worker || worker.status !== "active" || !isWorkerOnline(worker.lastSeenAt, now);
}

function sessionTitle(session: HomeSession) {
  const title = session.title?.trim();
  if (title) return title;
  return session.activeStream ? "Generating title…" : "Untitled session";
}

/** Current time, refreshed every minute so relative times stay true while Home is open. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), minute);
    return () => window.clearInterval(interval);
  }, []);

  return now;
}
