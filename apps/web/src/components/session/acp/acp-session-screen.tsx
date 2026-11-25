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
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { ArchiveXIcon, KeyRoundIcon, ServerOffIcon } from "lucide-react";
import { toast } from "sonner";
import type { Id } from "backend/convex/_generated/dataModel";
import type { AcpInteractionAnswer } from "contracts/acp/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { modelDisplayName } from "@/components/models/model-options";
import type { TabProjectHint } from "@/components/window/window-tabs";
import { IssueGatewayKeyButton } from "@/components/workspaces/worker-management";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
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
import { AcpConfigControls, acpModelConfig, applyAcpDraft } from "./config-controls";
import { AcpElicitationPrompt } from "./elicitation-prompt";
import { AcpPermissionPrompt } from "./permission-prompt";
import { useAcpSession } from "./use-acp-session";
import { AcpSessionFolder } from "./session-folder";
import { repairAcpBinding } from "./acp-crypto";
import { openTitle } from "@/lib/crypto/chat-content";
import { useDecryptedNames } from "@/lib/crypto/use-decrypted-names";
import { openHistoricalChat } from "@/lib/crypto/legacy-chat";
import { changeChatScope, ensureChatKeys } from "@/lib/crypto/chat-keys";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { authClient } from "@/lib/auth-client";
import { useTrpc } from "@/lib/trpc";
import { isTrpcRefusal, retryTransient } from "@/lib/trpc-error";

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
  const { workspaces } = useWorkspace();
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const { data: chatData, error: chatError } = useQuery(
    trpc.chats.get.queryOptions({ chatId }, { retry: retryTransient }),
  );
  const chat = useMemo(
    () => chatData && { ...chatData, workspace: chatData.workspace as Id<"workspaces"> },
    [chatData],
  );
  const keyStatus = useKeyStatus();
  useEffect(() => {
    if (!isVisible || keyStatus.state !== "unlocked") return;
    void ensureChatKeys(chatId).catch(() => {
      toast.error("Could not verify this Session's encryption keys.");
    });
  }, [chatId, isVisible, keyStatus]);
  // A keyed chat without a binding (created before the workspace had keys) is bound by its creator
  // once it has chat keys; the Worker refuses to run it until then.
  const repairedBinding = useRef<string>(undefined);
  const needsBinding = acp.signed && session?.e2eeId != null && session.binding === null;
  const legacyNeedsImport = needsBinding && Boolean(session?.agent.sessionId);
  useEffect(() => {
    if (!isVisible || keyStatus.state !== "unlocked" || !needsBinding || legacyNeedsImport) return;
    if (repairedBinding.current === chatId) return;
    repairedBinding.current = chatId;
    void repairAcpBinding(chatId).catch(() => {
      toast.error("Could not bind this Session to its Worker.");
    });
  }, [chatId, isVisible, keyStatus, needsBinding, legacyNeedsImport]);
  // A refusal is final; a network failure only counts while nothing has loaded yet.
  const unavailable =
    (chatError !== null && (isTrpcRefusal(chatError) || chat === undefined)) ||
    Boolean(acp.sessionError);
  const { data: projectsData } = useQuery(
    trpc.projects.list.queryOptions(chat ? { workspace: chat.workspace } : skipToken),
  );
  // The React Query cache keeps ciphertext; only these local rows carry decrypted names. A stable
  // array keeps the hook from re-opening names on every render.
  const projectRows = useMemo(() => projectsData ?? [], [projectsData]);
  const projects = useDecryptedNames(projectRows, "projects", chat?.workspace);
  // Radium's estimate of the recorded turns; fetched only while the Session is on screen and
  // refetched when a turn ends.
  const { data: estimate } = useQuery(
    trpc.usage.getChatCost.queryOptions(isVisible ? { chat: chatId } : skipToken),
  );
  // Same workspace preference as built-in Sessions, so both threads render steps alike.
  const { data: chainOfThoughtEnabled = true } = useQuery(
    trpc.chatroom.getChainOfThoughtEnabled.queryOptions(
      chat ? { workspace: chat.workspace } : skipToken,
    ),
  );
  const { mutateAsync: setChatScope } = useMutation(trpc.chats.setScope.mutationOptions());
  const { data: keyState } = useQuery(trpc.e2ee.chatKeys.queryOptions({ chatId }));
  const { data: workspaceKeyState } = useQuery(
    trpc.e2ee.workspaceKeyState.queryOptions(chat ? { workspace: chat.workspace } : skipToken),
  );
  const { data: memberNames } = useQuery(
    trpc.e2ee.identityNames.queryOptions(
      workspaceKeyState
        ? { userIds: workspaceKeyState.members.map((member) => member.userId) }
        : skipToken,
    ),
  );
  const { data: authSession } = authClient.useSession();
  const [scopeSaving, setScopeSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const reportedUnavailable = useRef(false);
  useEffect(() => {
    if (!unavailable || reportedUnavailable.current) return;
    reportedUnavailable.current = true;
    onUnavailable(tabId);
  }, [onUnavailable, tabId, unavailable]);

  const selectedProject = projects.find((project) => project.id === chat?.project);
  const projectKnown = chat !== undefined && (!chat.project || projectsData !== undefined);
  const projectHint = useMemo((): TabProjectHint | null | undefined => {
    if (!projectKnown) return undefined;
    if (!selectedProject) return null;
    return {
      name: selectedProject.name,
      color: selectedProject.color ?? undefined,
      icon: selectedProject.icon ?? undefined,
    };
  }, [projectKnown, selectedProject]);
  // Keyed Sessions carry a sealed title (like built-in chats); legacy ones a plaintext title.
  const [openedTitle, setOpenedTitle] = useState<{ box: string; title: string }>();
  useEffect(() => {
    const sealed = chat?.sealedTitle;
    if (!chat?.e2eeId || !sealed) return;
    let cancelled = false;
    openTitle(sealed, { chatId, workspaceId: chat.workspace, e2eeId: chat.e2eeId }).then(
      ({ title }) => {
        if (!cancelled) setOpenedTitle({ box: sealed.box, title });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [chat?.e2eeId, chat?.sealedTitle, chat?.workspace, chatId, keyStatus]);
  // A migrated Session's former plaintext title lives in the chat sidecar. It is read only while
  // the chat has no sealed or plaintext title of its own, and never written back.
  const [historicalTitle, setHistoricalTitle] = useState<string>();
  const historicalSource = chat && !chat.sealedTitle && !chat.title ? chat.legacyContent : undefined;
  const historicalWorkspace = chat?.workspace;
  useEffect(() => {
    if (!historicalSource || !historicalWorkspace) {
      setHistoricalTitle((current) => (current === undefined ? current : undefined));
      return;
    }
    let cancelled = false;
    openHistoricalChat(
      {
        chatId,
        workspaceId: historicalWorkspace,
        legacyContent: historicalSource,
        wants: { title: true, queue: false },
      },
      [],
    ).then(
      (opened) => {
        if (!cancelled) setHistoricalTitle(opened.title?.title);
      },
      // Locked keys and recovery custody leave the Session untitled.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, historicalSource, historicalWorkspace, keyStatus]);
  const tabTitle = chat?.sealedTitle
    ? openedTitle?.box === chat.sealedTitle.box
      ? openedTitle.title
      : undefined
    : (chat?.title ?? historicalTitle);
  useEffect(() => {
    onTabHint(tabId, { title: tabTitle, runState, project: projectHint });
  }, [onTabHint, projectHint, runState, tabId, tabTitle]);

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

  const config = acp.signed
    ? (acp.timeline.session.config ?? session?.defaultConfig)
    : session?.agent.sessionId
      ? session.config
      : applyAcpDraft(session?.config ?? session?.defaultConfig, session?.draft);
  // Same `Lab: Model` label as built-in turns, without the agent's routing-provider prefix.
  const { models: modelOptions, selectedModel } = useMemo(() => acpModelConfig(config), [config]);
  const currentModel = modelOptions.find((option) => option.slug === selectedModel);
  const modelName = currentModel ? modelDisplayName(currentModel) : undefined;
  const agentName = session?.agentName ?? session?.agent.agentId ?? chat?.agent?.agentId ?? "Agent";
  const workerName = acp.workerName ?? "Worker";
  const running =
    session?.status === "starting" ||
    session?.status === "running" ||
    session?.status === "awaiting";
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: trpc.usage.getChatCost.pathKey() });
    }
    wasRunning.current = running;
  }, [running, queryClient, trpc]);
  const ended = session?.status === "ended";
  // A Gateway session runs only while its Worker holds an active Gateway key.
  const gatewayAccess = session?.gateway?.access;
  const gatewayBlocked = gatewayAccess !== undefined && gatewayAccess !== "active";
  const isOwner = workspaces.some(
    (candidate) => candidate.id === chat?.workspace && candidate.role === "owner",
  );
  const canSend =
    acp.workerOnline &&
    !gatewayBlocked &&
    !needsBinding &&
    (session?.status === "idle" || session?.status === "failed");
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
    session?.capabilities?.fork === true &&
    import.meta.env.VITE_ACP_FORK === "true" &&
    !ended &&
    acp.workerOnline;

  async function changeScope(scope: ChatScope, members: string[] = keyState?.members ?? []) {
    if (!chat?.canManageScope || scopeSaving) return;
    setScopeSaving(true);
    try {
      if (chat.e2eeId && session) {
        // A signed keyed Session's binding names its audience and would have to be re-signed with
        // the key change; `chats.setScope` carries no ACP binding yet (ACP slice).
        if (acp.signed) {
          throw new Error("Visibility of this encrypted agent Session cannot be changed yet.");
        }
        await changeChatScope({
          chatId,
          scope,
          members: scope === "shared" ? members : undefined,
        });
      } else {
        await setChatScope({ chatId, scope });
      }
      await queryClient.invalidateQueries({ queryKey: trpc.chats.pathKey() });
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
  // A snapshot can hold no message (one oversized item); its history is then the first content.
  const waitingForSnapshot =
    hasOpened && (!timeline.hasSnapshot || acp.loadingHistory) && !hasContent && !ended;
  const offline = acp.workerKnown && !acp.workerOnline;
  const lastSeen = acp.workerLastSeenAt
    ? `Last seen ${formatLastSeen(acp.workerLastSeenAt)}.`
    : undefined;
  // Frames carry each `usage_update` as it happens; the session row only updates at turn end.
  const contextUsage = timeline.session.usage ?? session?.usage;
  const turnUsage = session?.turnUsage;
  return (
    <AcpSessionFolder value={session?.agent.cwd}>
      <div className="relative flex h-full flex-col">
        <div className="relative flex h-11 shrink-0 items-center justify-end gap-1 px-3">
          {contextUsage ? (
            <div className="shrink-0 max-sm:hidden">
              <ContextUsage
                usage={{
                  totalTokens: contextUsage.used,
                  ...(turnUsage
                    ? {
                        inputTokens: turnUsage.inputTokens,
                        outputTokens: turnUsage.outputTokens,
                        inputTokenDetails: {
                          noCacheTokens: undefined,
                          cacheReadTokens: turnUsage.cachedReadTokens,
                          cacheWriteTokens: turnUsage.cachedWriteTokens,
                        },
                        outputTokenDetails: {
                          textTokens: undefined,
                          reasoningTokens: turnUsage.thoughtTokens,
                        },
                      }
                    : {}),
                }}
                breakdownLabel="Last turn"
                maxTokens={contextUsage.size}
                // Radium's list-price estimate always shows; the agent's own figure sits beside it
                // (subscriptions report 0 or a discount).
                sessionCost={estimate ?? undefined}
                cost={contextUsage.cost}
              />
            </div>
          ) : null}
          <SessionWorkerControl
            isFixed
            workerName={workerName}
            agent={{
              protocol: "acp",
              name: session?.profile === "gateway" ? `${agentName} · Gateway` : agentName,
            }}
          />
        </div>
        {legacyNeedsImport ? (
          <Alert className="mx-4 w-auto">
            <AlertTitle>Legacy agent Session needs authorization</AlertTitle>
            {isOwner && chat?.canManageScope ? (
              <AlertDescription>
                This Session was started before encryption, so its Worker runs it only after you
                confirm it is yours.
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={authorizing || keyStatus.state !== "unlocked"}
                  onClick={() => {
                    setAuthorizing(true);
                    repairAcpBinding(chatId, { authorizeSession: true })
                      .catch(() => toast.error("Could not authorize this Session."))
                      .finally(() => setAuthorizing(false));
                  }}
                >
                  {authorizing ? <Spinner /> : <KeyRoundIcon />}
                  {keyStatus.state === "unlocked" ? "Authorize Session" : "Unlock to authorize"}
                </Button>
              </AlertDescription>
            ) : (
              <AlertDescription>
                This older Session can be authorized only by the workspace owner, and only if they
                started it. Otherwise, start a new Session.
              </AlertDescription>
            )}
          </Alert>
        ) : null}
        {offline && !hasContent && isVisible ? (
          <Empty className="min-h-0 flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerOffIcon />
              </EmptyMedia>
              <EmptyTitle>{workerName} is offline</EmptyTitle>
              <EmptyDescription>
                The conversation lives on {workerName} and shows here when it is online. {lastSeen}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : waitingForSnapshot && isVisible ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            {acp.errorMessage && !running ? (
              <p className="max-w-sm text-center text-sm text-muted-foreground">
                {acp.errorMessage}
              </p>
            ) : (
              <Spinner className="text-muted-foreground" />
            )}
          </div>
        ) : ended && !hasContent ? (
          <Empty className="min-h-0 flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ArchiveXIcon />
              </EmptyMedia>
              <EmptyTitle>{agentName} no longer has this session</EmptyTitle>
              <EmptyDescription>
                The conversation lives in the agent on {workerName}, and the agent can no longer
                open it, so it cannot continue here.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => void navigate({ to: "/chat" })}>
                Start a new session
              </Button>
            </EmptyContent>
          </Empty>
        ) : !hasOpened && !hasContent ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <SessionThread
            messages={messages}
            status={acp.chatStatus}
            pendingPrompt={visiblePendingPrompt}
            showChainOfThought={chainOfThoughtEnabled}
            agentName={agentName}
            modelLabel={modelName}
            onCopy={copyMessage}
            forkLatestOnly
            onFork={canFork ? handleFork : undefined}
            historyControl={
              acp.loadingHistory ? (
                <div className="flex justify-center py-1">
                  <Spinner className="text-muted-foreground" />
                </div>
              ) : timeline.hasMore && acp.historyFailed ? (
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!acp.workerOnline}
                    onClick={() => void acp.loadOlder()}
                  >
                    Retry loading earlier messages
                  </Button>
                </div>
              ) : undefined
            }
          />
        )}
        <div className="relative mx-auto flex w-full max-w-190 flex-col gap-2 px-4 pb-4">
          {offline ? (
            <Alert>
              <ServerOffIcon />
              <AlertTitle>{workerName} is offline</AlertTitle>
              <AlertDescription>
                {running
                  ? "The turn continues if the Worker reconnects, but fails if it restarted."
                  : "This Session continues when the Worker is back."}{" "}
                {lastSeen}
              </AlertDescription>
            </Alert>
          ) : null}
          {gatewayBlocked && !ended ? (
            <Alert>
              <KeyRoundIcon />
              <AlertTitle>
                {gatewayAccess === "missing"
                  ? "Gateway key deleted"
                  : gatewayAccess === "pending"
                    ? "Waiting for the Gateway key"
                    : "Gateway access is off"}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {gatewayAccess === "missing"
                    ? `${workerName}'s Gateway key was deleted, so this Gateway session cannot run.`
                    : gatewayAccess === "pending"
                      ? `${workerName} creates its new Gateway key when it is online; this session continues once it has one.`
                      : `Gateway access is off on ${workerName}, so this Gateway session cannot run.`}{" "}
                  {isOwner
                    ? gatewayAccess === "off"
                      ? "Turn it on in Settings → Workers."
                      : null
                    : gatewayAccess === "missing"
                      ? "Ask the workspace owner to issue a new key."
                      : gatewayAccess === "off"
                        ? "Ask the workspace owner to turn Gateway access on."
                        : null}
                </p>
                {isOwner && gatewayAccess === "missing" && chat?.agent ? (
                  <div className="mt-2">
                    <IssueGatewayKeyButton
                      workspace={chat.workspace}
                      workerId={chat.agent.worker}
                    />
                  </div>
                ) : isOwner && gatewayAccess === "off" ? (
                  <Button size="sm" variant="outline" className="mt-2" asChild>
                    <Link to="/chatroom/$section" params={{ section: "workers" }}>
                      Open Workers
                    </Link>
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {session?.history === "resumed" ? (
            <p className="text-center text-xs text-muted-foreground">
              Earlier history is not available from this agent
            </p>
          ) : null}
          {ended && hasContent ? (
            <Alert>
              <ArchiveXIcon />
              <AlertTitle>{agentName} can no longer continue this session</AlertTitle>
              <AlertDescription>
                <p>Start a new session to keep working.</p>
                <Button size="sm" className="mt-2" onClick={() => void navigate({ to: "/chat" })}>
                  Start a new session
                </Button>
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
            <div hidden={currentInteraction !== undefined || ended}>
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
                    agentId={session?.agent.agentId}
                    config={config}
                    defaults={session?.defaultConfig}
                    disabled={ended || !acp.workerOnline}
                    isOpen={modelOpen}
                    onOpenChange={setModelOpen}
                    onConfigChange={(id, value) => void acp.setConfig(id, value)}
                    onModeChange={(id) => void acp.setMode(id)}
                  />
                }
                toolbarControls={<ToolsDialog disabledReason="The agent brings its own tools" />}
                commands={acp.signed ? timeline.session.commands : session?.commands}
                attachmentsDisabledReason="Attachments for agent Sessions are not supported yet."
                menuItems={
                  <ConversationVisibilityMenu
                    scope={chat?.scope ?? "personal"}
                    isDraft={false}
                    allowShared={acp.signed}
                    members={keyState?.members ?? []}
                    availableMembers={(workspaceKeyState?.members ?? [])
                      .filter((member) => member.userId !== authSession?.user.id)
                      .map((member) => ({
                        id: member.userId,
                        name:
                          memberNames?.find((entry) => entry.userId === member.userId)?.name ??
                          "Unknown member",
                      }))}
                    onMembersChange={(members) => void changeScope("shared", members)}
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
    </AcpSessionFolder>
  );
});

function formatLastSeen(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const;
  for (const [unit, size] of units) {
    if (seconds >= size)
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        -Math.floor(seconds / size),
        unit,
      );
  }
  return "just now";
}
