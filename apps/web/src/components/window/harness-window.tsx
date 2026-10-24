import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { HouseIcon, PlusIcon, SquarePenIcon, XIcon } from "lucide-react";

import type { Id } from "backend/convex/_generated/dataModel";
import { AgentStatus, type RunState } from "@/components/agentic/agent-status";
import { UserButton } from "@/components/auth/user/user-button";
import { StripTab, TabEars, stripTabClassName } from "@/components/harness/strip-tab";
import { SessionProjectTile } from "@/components/session/run-target-picker";
import { SessionScreen, type SessionTabHint } from "@/components/session/session-screen";
import { pruneTabStates, removeTabState } from "@/components/session/tab-state";
import { SettingsLayout } from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";
import { spring, transitions } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  newTabId,
  readPersistedTabs,
  type SessionTab,
  type TabProjectHint,
  writePersistedTabs,
} from "./window-tabs";

/** RunStates that replace a Tab's icon with its live status. */
const isWorkingRunState: Record<RunState, boolean> = {
  idle: false,
  queued: true,
  thinking: true,
  streaming: true,
  executing: true,
  awaiting: true,
  succeeded: false,
  failed: false,
  cancelled: false,
};

/**
 * The harness Window (`docs/Interface_Design.md` §4): the 44px Tab strip and the one Panel.
 *
 * The URL decides which screen owns the Panel (route `staticData.screen`). Open session Tabs are
 * client state persisted in localStorage; the Window keeps every open Tab's `SessionScreen`
 * mounted so a stream keeps running while another Tab or screen is shown, and the chat routes
 * themselves render nothing. Opening a session is plain navigation: visiting `/chat/$chatId`
 * focuses its Tab or appends one, and `/chat` (with a `draft` id) is a `New session` draft.
 */
export function HarnessWindow({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const shell = useRouterState({
    select: (state) => state.matches.findLast((match) => match.staticData.shell)?.staticData.shell,
  });
  const screen = useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.screen)?.staticData.screen,
  });
  const isWideSettings = useRouterState({
    select: (state) => state.matches.some((match) => match.staticData.settingsWidth === "wide"),
  });
  const pageTitle = useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.pageTitle)?.staticData.pageTitle,
  });
  const href = useRouterState({ select: (state) => state.location.href });
  const params = useParams({ strict: false });
  // Merged search of the matched chat route: `draft`/`project` on `/chat`, fork targets on
  // `/chat/$chatId`.
  const search: { draft?: string; project?: string; model?: string; provider?: string } = useSearch(
    { strict: false },
  );

  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [isRestored, setIsRestored] = useState(false);
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const [lastAppHref, setLastAppHref] = useState("/");

  const isSessionScreen = screen === "session";
  const routeChatId = isSessionScreen ? params.chatId : undefined;
  const routeDraftId = isSessionScreen && !routeChatId ? search.draft : undefined;

  // The Tab the URL points at. It may not be in `tabs` yet (first render, a link from elsewhere);
  // it renders anyway so server and client agree, and the effect below appends it.
  let activeTab: SessionTab | undefined;
  if (routeChatId) {
    activeTab = tabs.find((tab) => tab.chatId === routeChatId) ?? {
      id: `chat-${routeChatId}`,
      chatId: routeChatId,
    };
  } else if (routeDraftId) {
    activeTab = tabs.find((tab) => tab.id === routeDraftId) ?? { id: routeDraftId };
  }
  const isActiveTabOpen = activeTab ? tabs.some((tab) => tab.id === activeTab.id) : true;
  const panelTabs = activeTab && !isActiveTabOpen ? [...tabs, activeTab] : tabs;

  // Restore after mount so server and client render the same initial markup. Per-Tab snapshots of
  // Tabs that no longer exist (closed elsewhere, an unreadable Tab list) are dropped here.
  useEffect(() => {
    const persisted = readPersistedTabs();
    const openTabIds = persisted.map((tab) => tab.id);
    if (activeTab) openTabIds.push(activeTab.id);
    pruneTabStates(openTabIds);

    setTabs((current) => [
      ...persisted,
      ...current.filter((tab) => !persisted.some((stored) => stored.id === tab.id)),
    ]);
    setIsRestored(true);
    // Mount-only: later Tab changes are persisted by the effect below; `activeTab` is read once.
  }, []);

  useEffect(() => {
    if (isRestored) writePersistedTabs(tabs);
  }, [tabs, isRestored]);

  useEffect(() => {
    if (!isRestored || !activeTab || isActiveTabOpen) return;
    const tab = activeTab;
    setTabs((current) =>
      current.some((item) => item.id === tab.id) ? current : [...current, tab],
    );
  }, [activeTab, isActiveTabOpen, isRestored]);

  // `/chat` without a draft id is a request for a new draft; give it an id so it is addressable.
  useEffect(() => {
    if (!isSessionScreen || routeChatId || routeDraftId) return;
    void navigate({ to: "/chat", search: { draft: newTabId() }, replace: true });
  }, [isSessionScreen, navigate, routeChatId, routeDraftId]);

  // `Back to app` in Settings returns to the previously focused Tab or Home (spec §4).
  useEffect(() => {
    if (screen === "home" || isSessionScreen) setLastAppHref(href);
  }, [href, isSessionScreen, screen]);

  const activeTitle = activeTab ? tabTitle(activeTab) : pageTitle;
  useEffect(() => {
    document.title = activeTitle ? `${activeTitle} · Radium` : "Radium";
  }, [activeTitle]);

  function openNewSession() {
    void navigate({ to: "/chat", search: { draft: newTabId() } });
  }

  function focusTab(tab: SessionTab) {
    if (tab.chatId) {
      void navigate({ to: "/chat/$chatId", params: { chatId: tab.chatId } });
      return;
    }
    void navigate({ to: "/chat", search: { draft: tab.id } });
  }

  const removeTab = useCallback((tabId: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
    setRunStates((current) => {
      const { [tabId]: _removed, ...rest } = current;
      return rest;
    });
    // A closed or unavailable Tab's draft text and choices must not outlive it.
    removeTabState(tabId);
  }, []);

  function closeTab(tabId: string) {
    if (activeTab?.id !== tabId) {
      removeTab(tabId);
      return;
    }

    // Spec §4: focus the right neighbor, else the left one, else Home. Remove the Tab only after
    // navigating away, or the URL would still point at it and re-open it.
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    const neighbor = remaining[index] ?? remaining[index - 1];
    const leave = neighbor
      ? navigate(
          neighbor.chatId
            ? { to: "/chat/$chatId", params: { chatId: neighbor.chatId } }
            : { to: "/chat", search: { draft: neighbor.id } },
        )
      : navigate({ to: "/" });
    void leave.then(() => removeTab(tabId));
  }

  // The per-Tab callbacks below take the Tab id and keep one identity, so the memoized
  // `SessionScreen`s skip re-rendering on navigation unless their own props changed.
  // Callers report on every change; return the same state when nothing differs so a re-render
  // never feeds back into another report.
  const handleTabHint = useCallback((tabId: string, hint: SessionTabHint) => {
    setTabs((current) => {
      const tab = current.find((item) => item.id === tabId);
      if (!tab) return current;

      // A chat that is still loading reports no title or Project; keep the persisted hints.
      const title = hint.title ?? tab.title;
      let project = tab.project;
      if (hint.project !== undefined) project = hint.project ?? undefined;
      const isSameProject =
        tab.project?.name === project?.name &&
        tab.project?.color === project?.color &&
        tab.project?.icon === project?.icon;
      if (tab.title === title && isSameProject) return current;

      return current.map((item) => (item.id === tabId ? { ...item, title, project } : item));
    });
    setRunStates((current) =>
      current[tabId] === hint.runState ? current : { ...current, [tabId]: hint.runState },
    );
  }, []);

  const handleCreated = useCallback(
    (tabId: string, chatId: Id<"aisdk_chats">) => {
      // Keep the Tab id so the same SessionScreen stays mounted while the URL moves to the chat.
      setTabs((current) => {
        if (!current.some((tab) => tab.id === tabId)) return [...current, { id: tabId, chatId }];
        return current.map((tab) => (tab.id === tabId ? { ...tab, chatId } : tab));
      });
      void navigate({ to: "/chat/$chatId", params: { chatId }, replace: true });
    },
    [navigate],
  );

  // Read at call time so `handleUnavailable` does not change identity on every navigation.
  const activeTabIdRef = useRef(activeTab?.id);
  useLayoutEffect(() => {
    activeTabIdRef.current = activeTab?.id;
  });
  const handleUnavailable = useCallback(
    (tabId: string) => {
      // A Tab whose session no longer exists or is no longer accessible is dropped (spec §4).
      if (activeTabIdRef.current === tabId) {
        void navigate({ to: "/" }).then(() => removeTab(tabId));
        return;
      }
      removeTab(tabId);
    },
    [navigate, removeTab],
  );

  if (shell === "bare") return children;

  const activeTabId = isSessionScreen ? activeTab?.id : undefined;
  const requestedSearch: typeof search = isSessionScreen ? search : {};

  return (
    <div
      data-slot="harness-window"
      className="flex h-svh flex-col overflow-hidden bg-chrome text-sm text-foreground"
    >
      {/* Home sits flush with the Panel's left edge so, when open, its side continues the Panel. */}
      <header className="flex h-11 shrink-0 items-end gap-1 pr-3 pl-2">
        <StripTab isActive={screen === "home"} flushStart className="px-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Home"
                aria-pressed={screen === "home"}
                className="hover:bg-transparent"
                onClick={() => void navigate({ to: "/" })}
              >
                <HouseIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Home</TooltipContent>
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
            {panelTabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const title = tabTitle(tab);

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
                    title={title}
                    onClick={() => focusTab(tab)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium outline-none after:absolute after:inset-0 after:rounded-t-[10px] focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
                  >
                    <TabIcon runState={runStates[tab.id] ?? "idle"} project={tab.project} />
                    <span className="truncate">{title}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Close ${title}`}
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
            <TooltipContent>New session</TooltipContent>
          </Tooltip>
        </div>

        <div className="ml-auto flex h-9 min-w-0 shrink items-center pr-1">
          <WorkspaceSwitcher variant="chip" />
        </div>

        <div className="flex h-9 shrink-0 items-center pl-1">
          {/* Better Auth UI account menu: profile, Settings, theme, account switching, sign out. */}
          <UserButton size="icon" align="end" avatarClassName="size-6 text-[11px]" />
        </div>
      </header>

      {/* Screens switch instantly (spec §7.3); Tabs stay mounted so background runs keep going. */}
      {/* No border: the Panel and the active Tab share one surface, so the Tab reads as part of it. */}
      <main
        className={cn(
          "relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-[10px] bg-background",
          screen === "home" && "rounded-tl-none",
        )}
      >
        {screen === "settings" ? (
          <SettingsLayout wide={isWideSettings} backHref={lastAppHref}>
            {children}
          </SettingsLayout>
        ) : (
          children
        )}

        {panelTabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          return (
            <div key={tab.id} role="tabpanel" hidden={!isActive} className="h-full">
              <SessionScreen
                tabId={tab.id}
                chatId={tab.chatId as Id<"aisdk_chats"> | undefined}
                isActive={isActive}
                requestedModel={isActive ? requestedSearch.model : undefined}
                requestedProvider={isActive ? requestedSearch.provider : undefined}
                requestedProject={isActive ? requestedSearch.project : undefined}
                onTabHint={handleTabHint}
                onCreated={handleCreated}
                onUnavailable={handleUnavailable}
              />
            </div>
          );
        })}
      </main>
    </div>
  );
}

function tabTitle(tab: SessionTab) {
  if (tab.title) return tab.title;
  return tab.chatId ? "Untitled session" : "New session";
}

/**
 * A working Tab shows its RunState; otherwise it shows its Project tile, or the new-session icon
 * without a Project (spec §2).
 */
function TabIcon({ runState, project }: { runState: RunState; project?: TabProjectHint }) {
  if (isWorkingRunState[runState]) {
    return <AgentStatus state={runState} hideLabel className="w-4 justify-center" />;
  }
  if (project) return <SessionProjectTile project={project} />;

  return <SquarePenIcon className="size-3.5 shrink-0" />;
}
