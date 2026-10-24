import { useEffect, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import {
  FolderMinusIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  RotateCcwIcon,
  SquarePenIcon,
} from "lucide-react";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { AgentStatus } from "@/components/agentic/agent-status";
import { ProjectActionsMenu } from "@/components/projects/project-actions-menu";
import { ProjectDialog } from "@/components/projects/project-dialog";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { newTabId } from "@/components/window/window-tabs";
import { SessionActionsMenu } from "./session-actions-menu";

type ChatList = Exclude<FunctionReturnType<typeof api.aisdk.ListChats>, string>;
type HomeSession = ChatList[number];

type SessionGroup = { label: string; sessions: HomeSession[] };

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const week = 7 * day;

/**
 * A Home session filter, remembered with the workspace it was picked in. `project: null` is the
 * `No project` filter (sessions outside every Project).
 */
type ProjectSelection = { workspace: Id<"workspaces">; project: Id<"projects"> | null };

/**
 * Home (`docs/Interface_Design.md` §5.1): a side column with `New session`, a small search, and
 * the workspace's Projects, plus its sessions grouped by recency as plain Rows on the Panel.
 * Selecting a Project, or `No project`, filters the list (selecting it again, or `All sessions`,
 * clears the filter). Opening a Row navigates to its session, which focuses or appends its Tab.
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
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const now = useMinuteClock();

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

  const { data: chats, error: chatsError } = useQuery(
    convexQuery(
      api.aisdk.ListChats,
      workspaceId ? { workspace: workspaceId, project: projectFilter } : "skip",
    ),
  );

  const isOwner = workspace?.role === "owner";
  const workspaceName = workspace?.name ?? "workspace";
  const normalizedQuery = query.trim().toLowerCase();
  const sessions = Array.isArray(chats) ? chats : [];
  const matches = sessions.filter((session) =>
    sessionTitle(session).toLowerCase().includes(normalizedQuery),
  );
  const groups = groupByRecency(matches, now);
  const projectsById = new Map(projects.map((project) => [project._id, project]));

  /** Starts a draft Tab; with `project`, the Session screen seeds the draft's Project from it. */
  function openNewSession(project?: Id<"projects">) {
    void navigate({ to: "/chat", search: { draft: newTabId(), project } });
  }

  /** Selects a Project (or `null`, No project); selecting the current filter again clears it. */
  function toggleProject(project: Id<"projects"> | null) {
    if (!workspaceId || (projectFilter !== undefined && projectFilter === project)) {
      setProjectSelection(null);
      return;
    }
    setProjectSelection({ workspace: workspaceId, project });
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
  } else if (chatsError || typeof chats === "string") {
    content = (
      <Alert>
        <AlertTitle>Sessions unavailable</AlertTitle>
        <AlertDescription>
          This workspace is no longer available to your account. Choose another workspace from the
          Tab strip.
        </AlertDescription>
      </Alert>
    );
  } else if (isWorkspaceLoading || isProvisioning || !workspaceId || chats === undefined) {
    content = <SessionListSkeleton />;
  } else if (sessions.length === 0 && selectedProject) {
    content = (
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
  } else if (sessions.length === 0 && isNoProjectSelected) {
    content = (
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
  } else if (sessions.length === 0) {
    content = (
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
  } else if (groups.length === 0) {
    content = <p className="px-3 text-sm text-muted-foreground">No sessions match “{query}”.</p>;
  } else {
    content = groups.map((group) => (
      <div key={group.label} className="flex flex-col gap-1">
        <h2 className="flex h-8 items-center px-3 text-sm font-normal text-subtle-foreground">
          {group.label}
        </h2>
        {/* Rows sit directly on the Panel; only the hovered or menu-open Row gets a surface. */}
        <ul className="flex flex-col">
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              project={session.project ? projectsById.get(session.project) : undefined}
              projects={projects}
              now={now}
            />
          ))}
        </ul>
      </div>
    ));
  }

  let projectList;
  if (projectsError || typeof projectsData === "string") {
    projectList = <p className="px-3 text-sm text-muted-foreground">Projects unavailable</p>;
  } else if (projectsData !== undefined && projects.length === 0) {
    projectList = <p className="px-3 text-sm text-muted-foreground">No projects yet</p>;
  } else if (projects.length > 0) {
    projectList = (
      <>
        <SideColumnItem
          isActive={projectFilter === undefined}
          onClick={() => setProjectSelection(null)}
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

          {workspaceId ? (
            <ProjectDialog
              open={isCreateProjectOpen}
              onOpenChange={setIsCreateProjectOpen}
              workspaceId={workspaceId}
              isOwner={isOwner}
              onCreated={(project) => setProjectSelection({ workspace: workspaceId, project })}
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
      {content}
    </SideColumnLayout>
  );
}

function SessionRow({
  session,
  project,
  projects,
  now,
}: {
  session: HomeSession;
  /** The session's Project, when it has one and it is in the list. */
  project: ProjectSummary | undefined;
  projects: ProjectSummary[];
  now: number;
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

function sessionTitle(session: HomeSession) {
  const title = session.title?.trim();
  if (title) return title;
  return session.activeStream ? "Generating title…" : "Untitled session";
}

/** Pinned first (the backend sorts them first), then Today / Yesterday / Older by local day. */
function groupByRecency(sessions: HomeSession[], now: number): SessionGroup[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - day;
  const groups: SessionGroup[] = [
    { label: "Pinned", sessions: [] },
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Older", sessions: [] },
  ];

  for (const session of sessions) {
    if (session.pinnedAt) {
      groups[0].sessions.push(session);
    } else if (session.lastInteractionAt >= startOfToday) {
      groups[1].sessions.push(session);
    } else if (session.lastInteractionAt >= startOfYesterday) {
      groups[2].sessions.push(session);
    } else {
      groups[3].sessions.push(session);
    }
  }

  return groups.filter((group) => group.sessions.length > 0);
}

/** Compact age (`now`, `12m`, `2h`, `3d`, `2w`), then a short date once older than a month. */
function formatRelativeTime(timestamp: number, now: number) {
  const age = Math.max(0, now - timestamp);

  if (age < minute) return "now";
  if (age < hour) return `${Math.floor(age / minute)}m`;
  if (age < day) return `${Math.floor(age / hour)}h`;
  if (age < week) return `${Math.floor(age / day)}d`;
  if (age < 5 * week) return `${Math.floor(age / week)}w`;

  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
