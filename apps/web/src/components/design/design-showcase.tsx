import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import {
  CircleHelpIcon,
  HouseIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";

import { AgentStatus, type RunState } from "@/components/agentic/agent-status";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { spring, transitions } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  demoSessions,
  demoUser,
  demoWorkspaces,
  projectInitial,
  type DemoSession,
} from "./demo-data";
import { HomeScreen } from "./home-screen";
import { ProjectTile } from "./project-tile";
import { SessionScreen } from "./session-screen";
import { SettingsScreen } from "./settings-screen";
import { WorkspaceSwitcher } from "./workspace-switcher";

type SessionTab = {
  id: string;
  title: string;
  /** Present when the Tab was opened from Home; absent for a `New session`. */
  sessionId?: string;
};

type Screen = { kind: "home" } | { kind: "tab"; tabId: string } | { kind: "settings" };

type PersistedWindow = { tabs: SessionTab[]; screen: Screen; workspaceId: string };

// Open Tabs are client UI state, so they live in localStorage, never Convex (spec §4).
// Bump the version suffix when the persisted shape changes.
const storageKey = "radium.window.v2";

const activeRunStates = new Set<RunState>([
  "queued",
  "thinking",
  "streaming",
  "executing",
  "awaiting",
]);

function readPersistedWindow(): PersistedWindow | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as PersistedWindow) : null;
  } catch {
    return null;
  }
}

function writePersistedWindow(value: PersistedWindow) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); Tabs then last for the visit.
  }
}

function newTabId() {
  return `tab-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Living reference for `docs/Interface_Design.md`: a harness Window with durable session Tabs,
 * Home, Session, and Settings. Everything is simulated client-side.
 */
export function DesignShowcase() {
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const [lastFocused, setLastFocused] = useState<Screen>({ kind: "home" });
  const [isRestored, setIsRestored] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(demoWorkspaces[0].id);
  const workspace =
    demoWorkspaces.find((candidate) => candidate.id === workspaceId) ?? demoWorkspaces[0];

  // Restore after mount so server and client render the same initial markup.
  useEffect(() => {
    const persisted = readPersistedWindow();
    if (persisted) {
      // A Tab holds only IDs; drop any whose session no longer exists (spec §4).
      setTabs(
        persisted.tabs.filter(
          (tab) => !tab.sessionId || demoSessions.some((session) => session.id === tab.sessionId),
        ),
      );
      setScreen(persisted.screen.kind === "settings" ? { kind: "home" } : persisted.screen);
      if (demoWorkspaces.some((candidate) => candidate.id === persisted.workspaceId)) {
        setWorkspaceId(persisted.workspaceId);
      }
    }
    setIsRestored(true);
  }, []);

  useEffect(() => {
    if (isRestored) writePersistedWindow({ tabs, screen, workspaceId });
  }, [tabs, screen, workspaceId, isRestored]);

  function focus(next: Screen) {
    if (next.kind !== "settings") setLastFocused(next);
    setScreen(next);
  }

  function openNewSession() {
    const tab: SessionTab = { id: newTabId(), title: "New session" };
    setTabs((current) => [...current, tab]);
    focus({ kind: "tab", tabId: tab.id });
  }

  function openSession(session: DemoSession) {
    const existing = tabs.find((tab) => tab.sessionId === session.id);
    if (existing) {
      focus({ kind: "tab", tabId: existing.id });
      return;
    }

    const tab: SessionTab = {
      id: newTabId(),
      title: session.title,
      sessionId: session.id,
    };
    setTabs((current) => [...current, tab]);
    focus({ kind: "tab", tabId: tab.id });
  }

  function closeTab(tabId: string) {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    setTabs(remaining);

    if (screen.kind === "tab" && screen.tabId === tabId) {
      // Spec §4: focus the right neighbor, else the left one, else Home.
      const neighbor = remaining[index] ?? remaining[index - 1];
      focus(neighbor ? { kind: "tab", tabId: neighbor.id } : { kind: "home" });
    }
  }

  const handleRunStateChange = useCallback((tabId: string, state: RunState) => {
    setRunStates((current) =>
      current[tabId] === state ? current : { ...current, [tabId]: state },
    );
  }, []);

  const handleTitleChange = useCallback((tabId: string, prompt: string) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === tabId && !tab.sessionId ? { ...tab, title: prompt } : tab)),
    );
  }, []);

  const activeTabId = screen.kind === "tab" ? screen.tabId : null;

  return (
    <div
      data-design="harness"
      className="flex h-svh flex-col overflow-hidden bg-chrome text-sm text-foreground"
    >
      {/* Home sits flush with the Panel's left edge so, when open, its side continues the Panel. */}
      <header className="flex h-11 shrink-0 items-end gap-1 pr-3 pl-2">
        <StripTab isActive={screen.kind === "home"} flushStart className="px-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Home"
                aria-pressed={screen.kind === "home"}
                className="hover:bg-transparent"
                onClick={() => focus({ kind: "home" })}
              >
                <HouseIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent data-design="harness">Home</TooltipContent>
          </Tooltip>
        </StripTab>

        {/*
          pl-2 keeps the first Tab's left ear inside the scroll container; the negative margin
          cancels it and the header gap, so Home sits one Tab gap (2px) from the first Tab.
        */}
        <div
          role="tablist"
          aria-label="Open sessions"
          className="-ml-2.5 flex min-w-0 items-end gap-0.5 overflow-x-auto px-2 [scrollbar-width:none]"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const runState = runStates[tab.id] ?? "idle";
              const session = demoSessions.find((candidate) => candidate.id === tab.sessionId);
              const tabProjectInitial = session ? projectInitial(session.projectId) : undefined;

              return (
                <m.div
                  key={tab.id}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1, transition: spring.snap }}
                  exit={{ opacity: 0, scale: 0.98, transition: transitions.exit }}
                  transition={spring.snap}
                  className={cn(
                    stripTabClassName(isActive),
                    "group/tab w-56 min-w-28 shrink gap-1.5 pr-1.5 pl-3",
                    !isActive && "hover:bg-background/40 hover:text-muted-foreground",
                  )}
                >
                  {isActive ? <TabEars /> : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={tab.title}
                    onClick={() => focus({ kind: "tab", tabId: tab.id })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium outline-none after:absolute after:inset-0 after:rounded-t-[10px] focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
                  >
                    {/*
                      A working Tab shows its run state; otherwise its Project tile, or the
                      new-session icon until the Session has a Project.
                    */}
                    {activeRunStates.has(runState) ? (
                      <AgentStatus state={runState} hideLabel className="w-4 justify-center" />
                    ) : tabProjectInitial ? (
                      <ProjectTile initial={tabProjectInitial} />
                    ) : (
                      <SquarePenIcon className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{tab.title}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Close ${tab.title}`}
                    className={cn(
                      "relative size-5 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                      isActive && "opacity-100",
                    )}
                    onClick={() => closeTab(tab.id)}
                  >
                    <XIcon />
                  </Button>
                </m.div>
              );
            })}
          </AnimatePresence>
        </div>

        <div className="flex h-9 shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New session"
                className="text-muted-foreground"
                onClick={openNewSession}
              >
                <PlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent data-design="harness">New session</TooltipContent>
          </Tooltip>
        </div>

        <div className="ml-auto flex h-9 min-w-0 shrink items-center pr-1">
          <WorkspaceSwitcher
            variant="chip"
            workspace={workspace}
            onWorkspaceChange={(next) => setWorkspaceId(next.id)}
          />
        </div>

        <div className="flex h-9 shrink-0 items-center pl-1">
          <UserMenu onOpenSettings={() => focus({ kind: "settings" })} />
        </div>
      </header>

      {/* Screens switch instantly (spec §7.3); Tabs stay mounted so background runs keep going. */}
      {/* No border: the Panel and the active Tab share one surface, so the Tab reads as part of it. */}
      <main
        className={cn(
          "mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-[10px] bg-background",
          screen.kind === "home" && "rounded-tl-none",
        )}
      >
        {screen.kind === "home" ? (
          <HomeScreen
            workspace={workspace}
            onOpenSession={openSession}
            onNewSession={openNewSession}
          />
        ) : null}

        {screen.kind === "settings" ? (
          <SettingsScreen
            workspace={workspace}
            onWorkspaceChange={(next) => setWorkspaceId(next.id)}
            onBack={() => focus(lastFocused)}
          />
        ) : null}

        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" hidden={tab.id !== activeTabId} className="h-full">
            <SessionScreen
              tabId={tab.id}
              isActive={tab.id === activeTabId}
              workspace={workspace}
              restoredPrompt={demoSessions.find((session) => session.id === tab.sessionId)?.prompt}
              onRunStateChange={(state) => handleRunStateChange(tab.id, state)}
              onTitleChange={(prompt) => handleTitleChange(tab.id, prompt)}
            />
          </div>
        ))}
      </main>
    </div>
  );
}

/**
 * Shape shared by everything that can own the Panel (Home, session Tabs, Settings). The active one
 * takes the Panel's surface and rounded top, so it reads as the Panel growing up into the strip.
 */
function stripTabClassName(isActive: boolean) {
  return cn(
    "relative flex h-9 shrink-0 items-center rounded-t-[10px] transition-colors",
    isActive ? "bg-background text-foreground" : "text-subtle-foreground",
  );
}

function StripTab({
  isActive,
  flushStart = false,
  className,
  children,
}: {
  isActive: boolean;
  /** The item sits on the Panel's left edge: no left ear, and the Panel squares that corner. */
  flushStart?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(stripTabClassName(isActive), !isActive && "text-muted-foreground", className)}
    >
      {isActive ? <TabEars hideStart={flushStart} /> : null}
      {children}
    </div>
  );
}

/**
 * Concave corners at the active Tab's base that curve into the Panel's top edge. The mask cuts a
 * quarter circle out of a Panel-colored square; it shapes the surface and paints no gradient.
 */
function TabEars({ hideStart = false }: { hideStart?: boolean }) {
  return (
    <>
      {hideStart ? null : (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 -left-2 size-2 bg-background mask-[radial-gradient(circle_at_0_0,transparent_8px,black_8.5px)]"
        />
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -right-2 bottom-0 size-2 bg-background mask-[radial-gradient(circle_at_100%_0,transparent_8px,black_8.5px)]"
      />
    </>
  );
}

/** Account entry in the Tab strip: who is signed in, Settings, Help, and Sign out. */
function UserMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Account" className="rounded-full">
          <Avatar size="sm">
            <AvatarFallback>{demoUser.initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-design="harness" align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="text-sm font-medium text-foreground">{demoUser.name}</span>
          <span className="truncate text-xs font-normal">{demoUser.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onOpenSettings}>
            <SettingsIcon />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem>
            <CircleHelpIcon />
            Help
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
