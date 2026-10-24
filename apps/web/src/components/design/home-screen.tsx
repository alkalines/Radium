import { useState } from "react";
import {
  FolderInputIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  demoProjects,
  demoSessions,
  projectInitial,
  type DemoSession,
  type DemoWorkspace,
} from "./demo-data";
import { ProjectTile } from "@/components/harness/project-tile";

const groupOrder: DemoSession["group"][] = ["Today", "Yesterday", "Older"];

/**
 * Home screen (`docs/Interface_Design.md` §5.1): a side column with search and Projects, and the
 * workspace's sessions grouped by recency as plain Rows on the Panel.
 */
export function HomeScreen({
  workspace,
  onOpenSession,
  onNewSession,
}: {
  workspace: DemoWorkspace;
  onOpenSession: (session: DemoSession) => void;
  onNewSession: () => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matches = demoSessions.filter((session) =>
    session.title.toLowerCase().includes(normalizedQuery),
  );
  const groups = groupOrder
    .map((group) => ({ group, sessions: matches.filter((session) => session.group === group) }))
    .filter((entry) => entry.sessions.length > 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-260 gap-8 px-4 pt-12 pb-8 md:grid-cols-[240px_minmax(0,1fr)] md:px-10">
        <aside className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onNewSession}
              className="flex h-8 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              <SquarePenIcon className="size-4" />
              New session
            </button>
            <InputGroup className="h-8 rounded-xl border-border bg-card">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${workspace.name}`}
                aria-label={`Search sessions in ${workspace.name}`}
              />
            </InputGroup>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex h-8 items-center justify-between pr-1 pl-3">
              <span className="text-sm text-subtle-foreground">Projects</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Disabled buttons do not fire pointer events; the span keeps the tooltip reachable. */}
                  <span tabIndex={0}>
                    <Button variant="ghost" size="icon-xs" disabled aria-label="New project">
                      <FolderPlusIcon />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Projects are planned</TooltipContent>
              </Tooltip>
            </div>
            {demoProjects.map((project) => (
              <div
                key={project.id}
                className="flex h-8 items-center gap-2 rounded-xl px-3 text-sm text-muted-foreground"
              >
                <ProjectTile initial={project.initial} />
                <span className="truncate">{project.name}</span>
              </div>
            ))}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col gap-6">
          {groups.length === 0 ? (
            <p className="px-3 text-sm text-muted-foreground">No sessions match “{query}”.</p>
          ) : null}

          {groups.map((entry) => (
            <div key={entry.group} className="flex flex-col gap-1">
              <h2 className="flex h-8 items-center px-3 text-sm font-normal text-subtle-foreground">
                {entry.group}
              </h2>
              {/* Rows sit directly on the Panel; only the hovered or menu-open Row gets a surface. */}
              <ul className="flex flex-col">
                {entry.sessions.map((session) => (
                  <li
                    key={session.id}
                    className="group/session relative flex h-10 items-center gap-2.5 rounded-xl pr-1.5 pl-3 text-sm transition-colors hover:bg-accent has-data-[state=open]:bg-accent"
                  >
                    <ProjectTile initial={projectInitial(session.projectId)} />
                    {/* The overlay makes the whole Row open the session; the menu sits above it. */}
                    <button
                      type="button"
                      onClick={() => onOpenSession(session)}
                      className="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
                    >
                      {session.title}
                    </button>
                    <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                      {session.updated}
                    </span>
                    <SessionMenu title={session.title} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** Row actions; revealed on hover or focus so the list stays quiet. Demo actions are inert. */
function SessionMenu({ title }: { title: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`${title} actions`}
          className="relative opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <FolderInputIcon />
            Move to project
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
