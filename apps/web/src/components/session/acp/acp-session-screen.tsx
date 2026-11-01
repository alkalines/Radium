import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { UIMessage } from "ai";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { AcpInteractionAnswer } from "backend/src/acp/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { TabProjectHint } from "@/components/window/window-tabs";
import {
  Composer,
  ConversationVisibilityMenu,
  type ChatScope,
  type ComposerTextStore,
} from "../composer";
import { getMessageText } from "../message-parts";
import { RunInterruptionCard } from "../run-interruption";
import type { SessionTabHint } from "../session-screen";
import { SessionThread } from "../session-thread";
import { patchTabState, readTabState } from "../tab-state";
import { TodoPanel, useTodoTrayItems } from "../todo-list";
import { ContextUsage } from "../context-usage";
import { SessionWorkerControl } from "../session-context";
import { ToolsDialog } from "../tools-dialog";
import { AcpConfigControls, applyAcpDraft } from "./config-controls";
import { AcpElicitationPrompt } from "./elicitation-prompt";
import { AcpPermissionPrompt } from "./permission-prompt";
import { useAcpSession } from "./use-acp-session";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
function browserVisible() {
  return document.visibilityState === "visible";
}
function copyMessage(message: UIMessage) {
  const text = getMessageText(message);
  if (text) void navigator.clipboard?.writeText(text);
}

/** ACP content is followed only while this Radium Tab and its browser tab are both visible. */
export const AcpSessionScreen = memo(function AcpSessionScreen({
  tabId,
  chatId,
  isActive,
  pendingPrompt,
  onTabHint,
  onUnavailable,
}: {
  tabId: string;
  chatId: Id<"aisdk_chats">;
  isActive: boolean;
  pendingPrompt?: string;
  onTabHint: (tabId: string, hint: SessionTabHint) => void;
  onUnavailable: (tabId: string) => void;
}) {
  const pageVisible = useSyncExternalStore(subscribeVisibility, browserVisible, () => false);
  const isVisible = isActive && pageVisible;
  const acp = useAcpSession({ chatId, isVisible });
  const { session, timeline, messages, runState } = acp;
  const navigate = useNavigate();
  const { data: chatResult, error: chatError } = useQuery(
    convexQuery(api.aisdk.GetChat, { chatId }),
  );
  const chat = typeof chatResult === "string" ? undefined : chatResult;
  const unavailable = Boolean(chatError || acp.sessionError) || typeof chatResult === "string";
  const { data: projects } = useQuery(
    convexQuery(api.projects.list, chat ? { workspace: chat.workspace } : "skip"),
  );
  const setChatScope = useMutation(api.aisdk.SetChatScope);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const reportedUnavailable = useRef(false);
  useEffect(() => {
    if (!unavailable || reportedUnavailable.current) return;
    reportedUnavailable.current = true;
    onUnavailable(tabId);
  }, [onUnavailable, tabId, unavailable]);

  const selectedProject = projects?.find((project) => project._id === chat?.project);
  const projectKnown = chat !== undefined && (!chat.project || projects !== undefined);
  const projectHint = useMemo((): TabProjectHint | null | undefined => {
    if (!projectKnown) return undefined;
    if (!selectedProject) return null;
    return { name: selectedProject.name, color: selectedProject.color, icon: selectedProject.icon };
  }, [projectKnown, selectedProject]);
  useEffect(() => {
    onTabHint(tabId, { title: chat?.title, runState, project: projectHint });
  }, [chat?.title, onTabHint, projectHint, runState, tabId]);

  const textStore = useMemo<ComposerTextStore>(
    () => ({
      read: () => readTabState(tabId)?.text ?? "",
      write: (text) => patchTabState(tabId, { text: text || undefined }),
    }),
    [tabId],
  );
  const [hasOpened, setHasOpened] = useState(false);
  useEffect(() => {
    if (isVisible) setHasOpened(true);
  }, [isVisible]);
  const [pendingConsumed, setPendingConsumed] = useState(false);
  const hasUser = messages.some((message) => message.role === "user");
  useEffect(() => {
    if (hasUser || (session && session.status !== "starting" && messages.length > 0))
      setPendingConsumed(true);
  }, [hasUser, messages.length, session]);
  const visiblePendingPrompt = pendingConsumed || hasUser ? undefined : pendingPrompt;

  const submittedInteractions = useRef(new Set<string>());
  const [hiddenInteractions, setHiddenInteractions] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!isVisible) return;
    const ids = new Set(acp.interactions.map((interaction) => interaction._id));
    let changed = false;
    for (const id of submittedInteractions.current) {
      if (!ids.has(id as Id<"acp_interactions">)) {
        submittedInteractions.current.delete(id);
        changed = true;
      }
    }
    if (changed) setHiddenInteractions(new Set(submittedInteractions.current));
  }, [acp.interactions, isVisible]);
  const pendingInteractions = acp.interactions.filter(
    (interaction) => interaction.status === "pending" && !hiddenInteractions.has(interaction._id),
  );
  const currentInteraction = pendingInteractions[0];
  const answeringInteractions = useRef(new Set<string>());
  async function answer(interaction: Id<"acp_interactions">, response: AcpInteractionAnswer) {
    if (
      answeringInteractions.current.has(interaction) ||
      submittedInteractions.current.has(interaction)
    )
      return;
    answeringInteractions.current.add(interaction);
    try {
      if (await acp.answer(interaction, response)) {
        submittedInteractions.current.add(interaction);
        setHiddenInteractions(new Set(submittedInteractions.current));
      }
    } finally {
      answeringInteractions.current.delete(interaction);
    }
  }

  const config = session?.agent.sessionId
    ? session.config
    : applyAcpDraft(session?.config ?? session?.defaultConfig, session?.draft);
  const modelOption = config?.options.find((option) => option.category === "model");
  const modelName =
    modelOption?.type === "select"
      ? modelOption.choices.find((choice) => choice.value === modelOption.currentValue)?.name
      : undefined;
  const agentName = session?.agentName ?? session?.agent.agentId ?? chat?.agent?.agentId ?? "Agent";
  const workerName = acp.workerName ?? "Worker";
  const running =
    session?.status === "starting" ||
    session?.status === "running" ||
    session?.status === "awaiting";
  const ended = session?.status === "ended";
  const canSend = acp.workerOnline && (session?.status === "idle" || session?.status === "failed");
  const trayTodos = useTodoTrayItems(acp.todos);
  const [trayAttached, setTrayAttached] = useState(false);
  if (trayTodos && !trayAttached) setTrayAttached(true);
  const fork = acp.fork;
  const handleFork = useCallback(() => {
    void fork().then((newChatId) => {
      if (newChatId) return navigate({ to: "/chat/$chatId", params: { chatId: newChatId } });
    });
  }, [fork, navigate]);
  const canFork =
    session?.capabilities?.fork === true && import.meta.env.VITE_ACP_FORK === "true" && !ended;

  async function changeScope(scope: ChatScope) {
    if (!chat?.canManageScope || scopeSaving) return;
    setScopeSaving(true);
    try {
      await setChatScope({ chatId, scope });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update Session visibility.");
    } finally {
      setScopeSaving(false);
    }
  }

  if (unavailable)
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-md">
          <AlertTitle>Session unavailable</AlertTitle>
          <AlertDescription>This Session is no longer available to your account.</AlertDescription>
        </Alert>
      </div>
    );

  const hasContent = messages.length > 0 || visiblePendingPrompt !== undefined;
  const waitingForSnapshot = hasOpened && !timeline.hasSnapshot && !hasContent && !ended;
  return (
    <div className="relative flex h-full flex-col">
      <div className="relative flex h-11 shrink-0 items-center justify-end gap-1 px-3">
        {session?.usage ? (
          <div className="shrink-0 max-sm:hidden">
            <ContextUsage
              usage={{ totalTokens: session.usage.used }}
              maxTokens={session.usage.size}
              cost={session.usage.cost}
              costLabel="Agent cost"
            />
          </div>
        ) : null}
        {acp.workerKnown && !acp.workerOnline ? (
          <Badge variant="outline">Worker offline</Badge>
        ) : null}
        <SessionWorkerControl
          isFixed
          workerName={workerName}
          agent={{ protocol: "acp", name: agentName }}
        />
      </div>
      {waitingForSnapshot && isVisible ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          {acp.workerKnown && !acp.workerOnline ? (
            <p className="max-w-sm text-center text-sm text-muted-foreground">
              Content lives on {workerName}. It shows here when the Worker is online.
            </p>
          ) : session?.error && !running ? (
            <p className="max-w-sm text-center text-sm text-muted-foreground">{session.error}</p>
          ) : (
            <Spinner className="text-muted-foreground" />
          )}
        </div>
      ) : !hasOpened && !hasContent ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <SessionThread
          messages={messages}
          status={acp.chatStatus}
          pendingPrompt={visiblePendingPrompt}
          showChainOfThought
          agentName={agentName}
          modelLabel={modelName}
          onCopy={copyMessage}
          forkLatestOnly
          onFork={canFork ? handleFork : undefined}
          historyControl={
            timeline.hasMore ? (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={acp.isLoadingOlder || !acp.workerOnline}
                  onClick={() => void acp.loadOlder()}
                >
                  {acp.isLoadingOlder ? <Spinner /> : null}Load earlier messages
                </Button>
              </div>
            ) : undefined
          }
        />
      )}
      <div className="relative mx-auto flex w-full max-w-190 flex-col gap-2 px-4 pb-4">
        {session?.history === "resumed" ? (
          <p className="text-center text-xs text-muted-foreground">
            Earlier history is not available from this agent
          </p>
        ) : null}
        {ended ? (
          <Alert>
            <AlertTitle>This Session has ended</AlertTitle>
            <AlertDescription>
              This agent cannot reopen the Session. Its content is read-only.
            </AlertDescription>
          </Alert>
        ) : null}
        {acp.contentError ? (
          <Alert variant="destructive">
            <AlertTitle>Unable to load agent content</AlertTitle>
            <AlertDescription>{acp.contentError.message}</AlertDescription>
          </Alert>
        ) : null}
        {chat?.interruption && !running && !currentInteraction ? (
          <RunInterruptionCard
            interruption={chat.interruption}
            canRetry={false}
            shortcutsEnabled={isActive}
            onSwitchModel={() => setModelOpen(true)}
          />
        ) : null}
        <div
          data-tray={trayAttached ? "attached" : undefined}
          className="group/prompt-slot flex flex-col"
        >
          <AnimatePresence initial={false} onExitComplete={() => setTrayAttached(false)}>
            {trayTodos ? <TodoPanel key="todos" items={trayTodos} isRunning={running} /> : null}
          </AnimatePresence>
          {currentInteraction ? (
            <div key={currentInteraction._id} className="flex flex-col gap-1">
              {currentInteraction.request.kind === "permission" ? (
                <AcpPermissionPrompt
                  request={currentInteraction.request}
                  index={0}
                  total={pendingInteractions.length}
                  shortcutsEnabled={isActive}
                  onAnswer={(optionId) =>
                    void answer(currentInteraction._id, { kind: "permission", optionId })
                  }
                />
              ) : (
                <>
                  {pendingInteractions.length > 1 ? (
                    <p className="px-3 text-xs text-muted-foreground">
                      1 of {pendingInteractions.length}
                    </p>
                  ) : null}
                  <AcpElicitationPrompt
                    request={currentInteraction.request}
                    agentName={agentName}
                    shortcutsEnabled={isActive}
                    onAnswer={(response) => void answer(currentInteraction._id, response)}
                  />
                </>
              )}
            </div>
          ) : null}
          <div hidden={currentInteraction !== undefined}>
            <Composer
              layoutId={`composer-${tabId}`}
              workspace={chat?.workspace}
              autoFocus={isVisible}
              canSend={canSend}
              isRunning={running}
              onSubmit={({ text }) => acp.prompt(text)}
              onStop={() => void acp.cancel()}
              modelControl={
                <AcpConfigControls
                  config={config}
                  disabled={ended || !acp.workerOnline}
                  isOpen={modelOpen}
                  onOpenChange={setModelOpen}
                  onConfigChange={(id, value) => void acp.setConfig(id, value)}
                  onModeChange={(id) => void acp.setMode(id)}
                />
              }
              toolbarControls={<ToolsDialog disabledReason="The agent brings its own tools" />}
              commands={session?.commands}
              attachmentsDisabledReason="Attachments for agent Sessions are not supported yet."
              menuItems={
                <ConversationVisibilityMenu
                  scope={chat?.scope ?? "personal"}
                  isDraft={false}
                  canChange={chat?.canManageScope === true && !scopeSaving}
                  onChange={(scope) => void changeScope(scope)}
                />
              }
              textStore={textStore}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
