import { useState } from "react";
import {
  CircleHelpIcon,
  FolderPlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { demoProjects, demoSessions, type DemoSession, workspaceName } from "./demo-data";
import { ProjectTile } from "./project-tile";

const groupOrder: DemoSession["group"][] = ["Today", "Yesterday", "Older"];

/** Home screen: Projects column plus recency-grouped sessions (`docs/Interface_Design.md` §5.1). */
export function HomeScreen({
  onOpenSession,
  onNewSession,
  onOpenSettings,
}: {
  onOpenSession: (session: DemoSession) => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
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
    <div className="mx-auto grid h-full w-full max-w-260 gap-8 overflow-y-auto px-4 pt-12 pb-8 md:grid-cols-[240px_minmax(0,1fr)] md:px-10">
      <aside className="flex flex-col gap-6 md:pt-14">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-2">
            <span className="text-sm text-muted-foreground">Projects</span>
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
              className="flex h-8 items-center gap-2 rounded-md bg-accent px-2 text-sm"
            >
              <ProjectTile initial={project.initial} />
              <span className="truncate">{project.name}</span>
            </div>
          ))}
        </div>

        <nav className="flex flex-col gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground"
            onClick={onOpenSettings}
          >
            <SettingsIcon data-icon="inline-start" />
            Settings
          </Button>
          <Button variant="ghost" size="sm" className="justify-start text-muted-foreground">
            <CircleHelpIcon data-icon="inline-start" />
            Help
          </Button>
        </nav>
      </aside>

      <section className="flex min-w-0 flex-col gap-6">
        <InputGroup className="h-9 bg-card">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search sessions in ${workspaceName}`}
            aria-label="Search sessions"
          />
        </InputGroup>

        {groups.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No sessions match “{query}”.</p>
        ) : null}

        {groups.map((entry, groupIndex) => (
          <div key={entry.group} className="flex flex-col gap-1">
            <div className="flex h-8 items-center justify-between px-2">
              <span className="text-sm text-subtle-foreground">{entry.group}</span>
              {groupIndex === 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={onNewSession}
                >
                  <SquarePenIcon data-icon="inline-start" />
                  New session
                </Button>
              ) : null}
            </div>
            <ul className="flex flex-col">
              {entry.sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSession(session)}
                    className={cn(
                      "group/session flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors outline-none",
                      "hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30",
                    )}
                  >
                    <ProjectTile initial="A" />
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    <span className="shrink-0 text-xs text-subtle-foreground tabular-nums opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-visible/session:opacity-100">
                      {session.updated}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
