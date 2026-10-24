import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { HouseIcon, PlusIcon, SquarePenIcon, XIcon } from "lucide-react";

import { AgentStatus, type RunState } from "@/components/agentic/agent-status";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { spring, transitions } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { demoSessions, type DemoSession } from "./demo-data";
import { HomeScreen } from "./home-screen";
import { SessionScreen } from "./session-screen";
import { SettingsScreen } from "./settings-screen";

type SessionTab = {
  id: string;
  title: string;
  /** Present when the Tab was opened from Home; absent for a `New session`. */
  sessionId?: string;
};

type Screen = { kind: "home" } | { kind: "tab"; tabId: string } | { kind: "settings" };

type PersistedWindow = { tabs: SessionTab[]; screen: Screen };

// Open Tabs are client UI state, so they live in localStorage, never Convex (spec §4).
// Bump the version suffix when the persisted shape changes.
const storageKey = "radium.window.v1";

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
    }
    setIsRestored(true);
  }, []);

  useEffect(() => {
    if (isRestored) writePersistedWindow({ tabs, screen });
  }, [tabs, screen, isRestored]);

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
    <div data-design="harness" className="flex h-svh flex-col overflow-hidden text-sm">
      <header className="flex h-11 shrink-0 items-center gap-1 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Home"
              aria-pressed={screen.kind === "home"}
              className={cn(
                "text-muted-foreground",
                screen.kind === "home" && "bg-accent text-foreground",
              )}
              onClick={() => focus({ kind: "home" })}
            >
              <HouseIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Home</TooltipContent>
        </Tooltip>

        <div
          role="tablist"
          aria-label="Open sessions"
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const runState = runStates[tab.id] ?? "idle";

              return (
                <m.div
                  key={tab.id}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1, transition: spring.snap }}
                  exit={{ opacity: 0, scale: 0.98, transition: transitions.exit }}
                  transition={spring.snap}
                  className={cn(
                    "group/tab relative flex h-7 w-56 min-w-28 shrink items-center gap-1.5 rounded-md pr-1 pl-2 transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-subtle-foreground hover:bg-accent/50 hover:text-muted-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={tab.title}
                    onClick={() => focus({ kind: "tab", tabId: tab.id })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
                  >
                    {/* A working background Tab shows its run state instead of the static icon. */}
                    {activeRunStates.has(runState) ? (
                      <AgentStatus state={runState} hideLabel className="w-3.5 justify-center" />
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
          <TooltipContent>New session</TooltipContent>
        </Tooltip>
      </header>

      {/* Screens switch instantly (spec §7.3); Tabs stay mounted so background runs keep going. */}
      <main className="mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-[10px] border bg-background">
        {screen.kind === "home" ? (
          <HomeScreen
            onOpenSession={openSession}
            onNewSession={openNewSession}
            onOpenSettings={() => focus({ kind: "settings" })}
          />
        ) : null}

        {screen.kind === "settings" ? <SettingsScreen onBack={() => focus(lastFocused)} /> : null}

        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" hidden={tab.id !== activeTabId} className="h-full">
            <SessionScreen
              tabId={tab.id}
              isActive={tab.id === activeTabId}
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
