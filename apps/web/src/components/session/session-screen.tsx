import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DefaultChatTransport, type ChatStatus, type FileUIPart, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { RotateCcwIcon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatInterruption } from "backend/src/chatroom/interruption";
import type { ToolSelection } from "backend/src/chatroom/tools";
import type { ChatWorkerSelection } from "backend/src/worker/chat-config";
import { isWorkerOnline } from "backend/src/worker/presence";
import type { RunState } from "@/components/agentic/agent-status";
import { RadiumWordmark } from "@/components/agentic/radium-wordmark";
import { SessionAmbient } from "@/components/agentic/session-ambient";
import {
  inferenceModeTier,
  validInferenceMode,
  validServiceTier,
} from "@/components/models/model-options";
import { ContextUsage } from "@/components/session/context-usage";
import {
  getLastMessageModel,
  getLastMessageProvider,
  getMessageFiles,
  getMessageText,
  getPendingApprovals,
  getPendingQuestions,
  getToolContinuationKey,
  getUsageMetadata,
  withoutUnfinishedStep,
} from "@/components/session/message-parts";
import { SessionThread } from "@/components/session/session-thread";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { TabProjectHint } from "@/components/window/window-tabs";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { authClient } from "@/lib/auth-client";
import { variants } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { builtInAgent, sessionAgentById, type SessionAgent, type SessionProject } from "./agents";
import { ApprovalPrompt } from "./approval-gate";
import { QUESTION_DISMISSED_MESSAGE, QuestionPrompt } from "./question-prompt";
import { RunInterruptionCard } from "./run-interruption";
import { TodoPanel, useTodoTrayItems } from "./todo-list";
import { getLatestTodos } from "./tool-parts";
import {
  Composer,
  ConversationVisibilityMenu,
  type ChatScope,
  type ComposerDraft,
  type ComposerHandle,
  type ComposerMessage,
  type ComposerTextStore,
} from "./composer";
import { ModelPicker, validReasoningEffort } from "./model-picker";
import { SessionContext, SessionWorkerControl } from "./session-context";
import { patchTabState, readTabState, type DraftTabSnapshot } from "./tab-state";
import { workerToolsFor } from "@/components/chatroom/tool-catalog";
import { ToolsDialog } from "./tools-dialog";

/**
 * A user turn the Session reverted to: the messages as they were before (restorable until the next
 * send) and the Composer draft the revert replaced.
 */
type PendingRevert = { messages: UIMessage[]; draft: ComposerDraft };

/**
 * Display hints a Session reports to its Tab in the Tab strip. `project` is `null` without a
 * Project and `undefined` while it is not known yet (the Tab keeps its persisted hint).
 */
export type SessionTabHint = {
  title?: string;
  runState: RunState;
  project?: TabProjectHint | null;
};

/**
 * One Session Tab: the empty draft (New session) and the active conversation in one tree, so the
 * Composer stays mounted (draft text and model choice survive) and docks through a shared
 * `layoutId` when the first message is sent (`docs/Interface_Design.md` §5.3).
 *
 * - Draft (`chatId` undefined): wordmark, ambient glow, Composer, and Project line, centered.
 *   Submitting persists the chat with `api.aisdk.CreateChat` (prompt in `messages_queue`) and calls
 *   `onCreated`; the prompt stays visible as a pending turn until the chat's messages arrive, and
 *   the draft's own choices stay on screen until the created chat loads.
 * - Saved: subscribes to `api.aisdk.GetChat` metadata for every mounted Tab. Content from
 *   `api.aisdk.GetChatMessages` is subscribed only after the Tab is first active, then stays live
 *   until unmount. It seeds `useChat` before sending a queued prompt once, then streams turns from
 *   `POST /api/aisdk/chat` on the Convex site. Either query failing or losing access shows an inline
 *   notice and calls `onUnavailable` once.
 * - A pending tool approval, then a pending `question` call, takes the Composer's place
 *   (`ApprovalPrompt`, `QuestionPrompt`) until it is answered. The latest `todo_write` list docks
 *   above that slot while it has open items or the run is working.
 * - Reverting to a user turn drops it and everything after it, puts its text and files back in
 *   the Composer, and offers a Restore card until the next send makes the revert durable.
 * - A turn that stopped short (Stop, a reload mid-reply, a request error) shows
 *   `RunInterruptionCard` above the prompt; its Retry continues the turn after the last completed
 *   step (`withoutUnfinishedStep`), unlike the assistant footer's Regenerate.
 *
 * The Window keeps every open Tab mounted, so streams continue in background Tabs without loading
 * content for restored Tabs that have never been opened. `isActive` also gates autofocus and the
 * approval, question, and Retry shortcuts. The Worker and context usage sit in the Panel's top-right
 * corner. `onTabHint` reports title, RunState, and Project on change.
 * The callbacks take the Tab id so the Window can pass the same functions to every Tab: the
 * screen is memoized, and with stable props a navigation re-renders only the Tabs whose
 * `isActive` (or requested model/Project) changed.
 *
 * Per-Tab state: what Convex cannot give back (Composer text, model/provider/reasoning choices,
 * the agent, and a draft's workspace, visibility, Worker, Project, and tool override) is kept in
 * the Tab's snapshot (`tab-state.ts`), keyed strictly by `tabId`. It is restored once after mount
 * and rewritten on change; it never writes workspace or user defaults. Saved chats take
 * visibility, Worker, Project, and tools from Convex, never from the snapshot, and never change
 * Project here (that is a confirmed Home action).
 *
 * The client never sends a Worker directory: the backend derives it from the Project folder or the
 * Worker's temp directory.
 */
export const SessionScreen = memo(function SessionScreen({
  tabId,
  chatId,
  isActive,
  requestedModel,
  requestedProvider,
  requestedProject,
  onTabHint,
  onCreated,
  onUnavailable,
}: {
  tabId: string;
  chatId?: Id<"aisdk_chats">;
  isActive: boolean;
  requestedModel?: string;
  requestedProvider?: string;
  /** Project id a new draft starts in (`/chat?project=`); ignored when the Tab restores choices. */
  requestedProject?: string;
  onTabHint: (tabId: string, hint: SessionTabHint) => void;
  onCreated: (tabId: string, chatId: Id<"aisdk_chats">) => void;
  onUnavailable: (tabId: string) => void;
}) {
  const navigate = useNavigate();
  const { workspaceId, workspaces } = useWorkspace();
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const { data: chatResult, error: chatError } = useQuery(
    convexQuery(api.aisdk.GetChat, chatId ? { chatId } : "skip"),
  );
  const chat = typeof chatResult === "string" ? undefined : chatResult;
  // Restored Tabs need only metadata until opened; keep content live after the first activation.
  const [openedChatId, setOpenedChatId] = useState(isActive ? chatId : undefined);
  if (isActive && chatId && openedChatId !== chatId) setOpenedChatId(chatId);
  const isContentEnabled = chatId !== undefined && (isActive || openedChatId === chatId);
  const {
    data: chatContent,
    error: chatContentError,
    isPending: isChatContentPending,
  } = useQuery(convexQuery(api.aisdk.GetChatMessages, isContentEnabled ? { chatId } : "skip"));
  const isChatUnavailable =
    Boolean(chatError) || Boolean(chatContentError) || typeof chatResult === "string";

  const createChat = useMutation(api.aisdk.CreateChat);
  const forkChat = useMutation(api.aisdk.ForkChat);
  const setChatScope = useMutation(api.aisdk.SetChatScope);
  const setChatWorker = useMutation(api.aisdk.SetChatWorker);

  // An existing chat's settings belong to its own workspace; a draft uses the current one.
  const settingsWorkspaceId = chat?.workspace ?? workspaceId;
  const isOwner = workspaces.some(
    (candidate) => candidate._id === settingsWorkspaceId && candidate.role === "owner",
  );
  const signedIn = userInfo !== undefined && typeof userInfo !== "string";

  const [modelOverride, setModelOverride] = useState(requestedModel);
  const [providerOverride, setProviderOverride] = useState(requestedProvider);
  const [serviceTier, setServiceTier] = useState<string>();
  const [inferenceMode, setInferenceMode] = useState<string>();
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [reasoningBudget, setReasoningBudget] = useState<number>();
  const [choiceWorkspaceId, setChoiceWorkspaceId] = useState<string | undefined>(
    settingsWorkspaceId,
  );
  const [draftScope, setDraftScope] = useState<ChatScope>("personal");
  const [draftWorker, setDraftWorker] = useState<ChatWorkerSelection | null>(null);
  const [draftProject, setDraftProject] = useState<string | null>(null);
  const [draftTools, setDraftTools] = useState<ToolSelection | null>(null);
  const [agent, setAgent] = useState<SessionAgent>(builtInAgent);
  const [isTabStateRestored, setIsTabStateRestored] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);
  const [createdChatId, setCreatedChatId] = useState<string>();
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingRevert, setPendingRevert] = useState<PendingRevert | null>(null);
  const [isScopeSaving, setIsScopeSaving] = useState(false);
  const [isWorkerSaving, setIsWorkerSaving] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);

  // The chat this Tab's draft just created keeps showing the draft's own choices (Project, Worker,
  // tools, model) until Convex returns it, so sending never flashes a loading state in between.
  const isLoadingCreatedChat =
    chatId !== undefined && chatId === createdChatId && chat === undefined && !isChatUnavailable;
  const usesDraftChoices = chatId === undefined || isLoadingCreatedChat;

  const {
    data: models,
    error: modelsError,
    isFetching: modelsFetching,
  } = useQuery(
    convexQuery(
      api.models.availableModels,
      settingsWorkspaceId ? { workspace: settingsWorkspaceId } : "skip",
    ),
  );
  const defaultModelQuery = useQuery(
    convexQuery(
      api.chatroom.getModelDefault,
      signedIn && settingsWorkspaceId ? { workspace: settingsWorkspaceId } : "skip",
    ),
  );
  const { data: chainOfThoughtEnabled = true } = useQuery(
    convexQuery(
      api.chatroom.getChainOfThoughtEnabled,
      signedIn && settingsWorkspaceId ? { workspace: settingsWorkspaceId } : "skip",
    ),
  );
  const { data: projects } = useQuery(
    convexQuery(
      api.projects.list,
      signedIn && settingsWorkspaceId ? { workspace: settingsWorkspaceId } : "skip",
    ),
  );
  const { data: workerToolDefaults } = useQuery(
    convexQuery(
      api.chatroom.getWorkerToolDefaults,
      signedIn && settingsWorkspaceId ? { workspace: settingsWorkspaceId } : "skip",
    ),
  );
  // Owner-only; the same query the Session context uses, so it is fetched once.
  const { data: workers, error: workersError } = useQuery(
    convexQuery(
      api.workers.list,
      isOwner && settingsWorkspaceId ? { workspace: settingsWorkspaceId } : "skip",
    ),
  );

  // Restore this Tab's snapshot once, after mount, so server and client render the same markup.
  // A `/chat?project=` request only seeds a draft that had no saved choices.
  const restoredTabId = useRef<string>(undefined);
  const seedProjectId = useRef(requestedProject);
  useEffect(() => {
    if (restoredTabId.current === tabId) return;
    restoredTabId.current = tabId;

    const snapshot = readTabState(tabId);
    if (snapshot) {
      if (snapshot.model) setModelOverride(snapshot.model);
      if (snapshot.provider) setProviderOverride(snapshot.provider);
      if (snapshot.serviceTier) setServiceTier(snapshot.serviceTier);
      if (snapshot.inferenceMode) setInferenceMode(snapshot.inferenceMode);
      if (snapshot.reasoningEffort) setReasoningEffort(snapshot.reasoningEffort);
      if (snapshot.reasoningBudget) setReasoningBudget(snapshot.reasoningBudget);
      if (snapshot.agentId) setAgent(sessionAgentById(snapshot.agentId));
    }
    if (chatId === undefined && snapshot?.draft) {
      const draft = snapshot.draft;
      seedProjectId.current = undefined;
      setChoiceWorkspaceId(draft.workspaceId);
      setDraftScope(draft.scope);
      setDraftWorker(draft.worker);
      setDraftProject(draft.project);
      setDraftTools(draft.tools);
    }
    setIsTabStateRestored(true);
  }, [chatId, tabId]);

  // Model, Worker, Project, and tool choices of a draft belong to a workspace; discard them as it
  // changes. An unknown current workspace (still loading) is not a change: restored choices wait.
  const choicesAreStale =
    chatId === undefined &&
    settingsWorkspaceId !== undefined &&
    choiceWorkspaceId !== settingsWorkspaceId;
  useEffect(() => {
    if (!choicesAreStale) return;
    setChoiceWorkspaceId(settingsWorkspaceId);
    setModelOverride(undefined);
    setProviderOverride(undefined);
    setServiceTier(undefined);
    setInferenceMode(undefined);
    setDraftWorker(null);
    setDraftProject(null);
    setDraftTools(null);
  }, [choicesAreStale, settingsWorkspaceId]);

  // Persist on change, never before the restore (that would overwrite the snapshot with defaults).
  useEffect(() => {
    if (!isTabStateRestored) return;

    let draft: DraftTabSnapshot | undefined;
    if (chatId === undefined && choiceWorkspaceId !== undefined && !choicesAreStale) {
      draft = {
        workspaceId: choiceWorkspaceId,
        scope: draftScope,
        worker: draftWorker,
        project: draftProject,
        tools: draftTools,
      };
    }
    patchTabState(tabId, {
      model: modelOverride,
      provider: providerOverride,
      serviceTier,
      inferenceMode,
      reasoningEffort,
      reasoningBudget,
      agentId: agent.id,
      draft,
    });
  }, [
    agent.id,
    chatId,
    choiceWorkspaceId,
    choicesAreStale,
    draftProject,
    draftScope,
    draftTools,
    draftWorker,
    isTabStateRestored,
    modelOverride,
    providerOverride,
    serviceTier,
    inferenceMode,
    reasoningBudget,
    reasoningEffort,
    tabId,
  ]);

  // The Composer writes its text straight to the snapshot on every change, so typing re-renders
  // only the Composer instead of this whole screen; the write is a small synchronous localStorage
  // update, which also means a reload right after typing keeps the text.
  const composerTextStore = useMemo<ComposerTextStore>(
    () => ({
      read: () => readTabState(tabId)?.text ?? "",
      write: (text) => patchTabState(tabId, { text: text || undefined }),
    }),
    [tabId],
  );

  // Saved chats read their Project from Convex; a draft's Project must exist in its workspace.
  let projectId: string | null = chat?.project ?? null;
  if (usesDraftChoices) projectId = choicesAreStale ? null : draftProject;
  const selectedProject = projects?.find((candidate) => candidate._id === projectId) ?? null;

  // A draft's Project can disappear (deleted, or never in this workspace after a restore).
  useEffect(() => {
    if (chatId || !draftProject || !projects || choicesAreStale) return;
    if (projects.some((candidate) => candidate._id === draftProject)) return;
    setDraftProject(null);
  }, [chatId, choicesAreStale, draftProject, projects]);

  /**
   * Puts the draft in a Project. For owners, the Project also picks the draft's Worker: its only
   * Worker folder, else its default Worker, and only while that Worker is online; otherwise the
   * draft runs on no Worker. Tools already chosen are kept and merged with the Worker tool
   * defaults. `No project` leaves the Worker as it is.
   */
  const selectDraftProject = useCallback(
    (project: SessionProject | null) => {
      setDraftProject(project?._id ?? null);
      if (!project || !isOwner) return;

      const folders = project.folders ?? [];
      const candidateId = folders.length === 1 ? folders[0]?.workerId : project.defaultWorkerId;
      const candidate = workers?.find(
        (worker) => worker.workerId === candidateId && worker.status === "active",
      );
      const isOnline = candidate !== undefined && isWorkerOnline(candidate.lastSeenAt, Date.now());

      setDraftWorker((current) => {
        const chosenTools = current?.tools ?? [];
        if (candidate && isOnline) {
          return {
            workerId: candidate.workerId,
            tools: workerToolsFor(workerToolDefaults ?? [], chosenTools),
          };
        }
        // No Worker: keep the tools chosen so far as a Worker-less selection.
        return chosenTools.length > 0 ? { tools: chosenTools } : null;
      });
    },
    [isOwner, workerToolDefaults, workers],
  );

  // Apply a `/chat?project=` request once the Projects (and, for owners, the Workers and Worker
  // tool defaults the automatic Worker needs) have loaded for the draft's workspace.
  useEffect(() => {
    const requested = seedProjectId.current;
    if (!requested || chatId || !isTabStateRestored || choicesAreStale || !projects) return;
    if (isOwner && workerToolDefaults === undefined) return;
    if (isOwner && workers === undefined && !workersError) return;
    seedProjectId.current = undefined;
    const project = projects.find((candidate) => candidate._id === requested);
    if (project) selectDraftProject(project);
  }, [
    chatId,
    choicesAreStale,
    isOwner,
    isTabStateRestored,
    projects,
    selectDraftProject,
    workerToolDefaults,
    workers,
    workersError,
  ]);

  // A draft's explicit model can disappear from the refreshed list (e.g. provider disabled).
  useEffect(() => {
    if (chatId || !modelOverride || !models || modelsFetching || choicesAreStale) return;
    if (models.some((candidate) => candidate.slug === modelOverride)) return;
    setModelOverride(undefined);
    setProviderOverride(undefined);
  }, [chatId, choicesAreStale, modelOverride, models, modelsFetching]);

  // Resolution order: explicit choice, this chat's last model, its queued model, the user's saved
  // default, then the first available model.
  const explicitModel = choicesAreStale ? undefined : modelOverride;
  const explicitProvider = choicesAreStale ? undefined : providerOverride;
  const persistedMessages = chatContent?.messages as UIMessage[] | undefined;
  const chatModel = persistedMessages ? getLastMessageModel(persistedMessages) : undefined;
  const chatProvider = persistedMessages ? getLastMessageProvider(persistedMessages) : undefined;
  const queuedModel = chat?.messages_queue?.model;
  const queuedProvider = chat?.messages_queue?.provider;
  const hasModels = Boolean(models?.length);
  const isModelListLoading =
    models === undefined || (chatId === undefined && (modelsFetching || choicesAreStale));
  const isWaitingForChat =
    chatId !== undefined &&
    !isChatUnavailable &&
    !isLoadingCreatedChat &&
    (chatResult === undefined || (isContentEnabled && isChatContentPending));
  const isWaitingForDefault =
    !(chatModel || queuedModel) &&
    (userInfo === undefined || (signedIn && defaultModelQuery.isPending));
  const isModelLoading =
    isModelListLoading ||
    (hasModels && !explicitModel && (isWaitingForChat || isWaitingForDefault));
  const defaultModel = defaultModelQuery.data;
  const availableDefaultModel = models?.some((candidate) => candidate.slug === defaultModel)
    ? defaultModel
    : undefined;
  let fallbackModel: string | undefined;
  if (!isModelLoading) fallbackModel = availableDefaultModel ?? models?.[0]?.slug;
  const selectedModel = explicitModel ?? chatModel ?? queuedModel ?? fallbackModel;
  const selectedModelData = models?.find((candidate) => candidate.slug === selectedModel);
  const preferredProvider = explicitProvider ?? chatProvider ?? queuedProvider;
  const selectedProvider = selectedModelData?.providers.some(
    (provider) => provider.id === preferredProvider,
  )
    ? preferredProvider
    : selectedModelData?.providers[0]?.id;
  const selectedTier = validServiceTier(selectedModelData, selectedProvider, serviceTier);
  const selectedMode = validInferenceMode(selectedModelData, selectedProvider, inferenceMode);
  const modeTier = inferenceModeTier(
    selectedModelData?.providers
      .find((provider) => provider.id === selectedProvider)
      ?.inference_modes?.find((mode) => mode.id === selectedMode),
  );
  const effectiveMode = selectedTier && modeTier ? undefined : selectedMode;
  useEffect(() => {
    if (!isModelLoading && serviceTier && !selectedTier) setServiceTier(undefined);
  }, [isModelLoading, selectedTier, serviceTier]);
  useEffect(() => {
    if (!isModelLoading && inferenceMode && !effectiveMode) setInferenceMode(undefined);
  }, [isModelLoading, inferenceMode, effectiveMode]);
  const selectedEffort = validReasoningEffort(selectedModelData, reasoningEffort);
  const selectedBudget =
    selectedModelData?.features?.reasoning_budget && reasoningBudget ? reasoningBudget : undefined;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: getAiSdkChatApi(),
        body: {
          chatId,
          model: selectedModel,
          provider: selectedProvider,
          serviceTier: selectedTier,
          inferenceMode: effectiveMode,
          reasoningEffort: selectedEffort,
          reasoningBudget: selectedBudget,
        },
        headers: getConvexAuthHeaders,
        // Approval continuations and retries carry no per-call body: fall back to the model and
        // provider recorded on the latest assistant turn.
        prepareSendMessagesRequest({ api: requestApi, body, credentials, headers, id, messages }) {
          return {
            api: requestApi,
            body: {
              ...body,
              chatId,
              id,
              messages,
              model: body?.model ?? getLastMessageModel(messages),
              provider: body?.provider ?? getLastMessageProvider(messages),
            },
            credentials,
            headers,
          };
        },
        credentials: "include",
      }),
    [
      chatId,
      selectedBudget,
      selectedEffort,
      selectedModel,
      selectedProvider,
      selectedTier,
      effectiveMode,
    ],
  );

  // Prevent duplicate sends if the SDK rechecks an answered step before it settles.
  const submittedToolContinuations = useRef(new Set<string>());
  const {
    addToolApprovalResponse,
    addToolOutput,
    clearError,
    error,
    messages,
    regenerate,
    sendMessage,
    setMessages,
    status,
    stop,
  } = useChat({
    id: chatId,
    transport,
    sendAutomaticallyWhen: ({ messages: nextMessages }) => {
      const continuationKey = getToolContinuationKey(nextMessages);
      if (!continuationKey || submittedToolContinuations.current.has(continuationKey)) {
        return false;
      }
      submittedToolContinuations.current.add(continuationKey);
      return true;
    },
  });

  // Seed useChat once per chat from persisted messages; later query updates must not overwrite
  // its live state. A chat opened while a request runs elsewhere (another Tab, or this page before
  // a reload) seeds again once that request ends, because the backend saves the turn only then.
  // Starting a request here first gives up on it: this Tab's history wins.
  const [seededChatId, setSeededChatId] = useState<string>();
  const seededMidRequest = useRef(false);
  useEffect(() => {
    if (!chatContent || !chatId) return;
    if (seededChatId !== chatId) {
      seededMidRequest.current = chatContent.activeStream;
      setMessages(chatContent.messages as UIMessage[]);
      setSeededChatId(chatId);
      return;
    }
    if (!seededMidRequest.current) return;
    if (status !== "ready") {
      seededMidRequest.current = false;
      return;
    }
    if (chatContent.activeStream) return;
    seededMidRequest.current = false;
    setMessages(chatContent.messages as UIMessage[]);
  }, [chatContent, chatId, seededChatId, setMessages, status]);

  // The todo tray shows the latest list while it has open items; a finished one sinks back. The
  // prompt slot stays squared under it until its exit animation finishes.
  const trayTodos = useTodoTrayItems(getLatestTodos(messages));
  const [isTrayAttached, setIsTrayAttached] = useState(trayTodos !== undefined);
  if (trayTodos && !isTrayAttached) setIsTrayAttached(true);

  // Wait for the seeded render so forks send their history with the queued prompt. Mark before
  // sending so Convex updates or status changes cannot replay the queued turn.
  const sentQueueChatId = useRef<string>(undefined);
  useEffect(() => {
    const queue = chat?.messages_queue;
    if (
      !chatId ||
      seededChatId !== chatId ||
      !queue ||
      status !== "ready" ||
      sentQueueChatId.current === chatId
    ) {
      return;
    }
    sentQueueChatId.current = chatId;
    void sendMessage(
      { text: queue.text, files: queue.files.filter(hasFileUrl) },
      {
        body: {
          chatId,
          model: queue.model,
          provider: queue.provider,
          serviceTier: queue.serviceTier,
          inferenceMode: queue.inferenceMode,
          reasoningBudget: queue.reasoningBudget,
          reasoningEffort: queue.reasoningEffort,
        },
      },
    );
  }, [chat?.messages_queue, chatId, seededChatId, sendMessage, status]);

  const reportedUnavailable = useRef(false);
  useEffect(() => {
    if (!isChatUnavailable || reportedUnavailable.current) return;
    reportedUnavailable.current = true;
    onUnavailable(tabId);
  }, [isChatUnavailable, onUnavailable, tabId]);

  // Once the conversation has had messages, an empty list means every turn was reverted: the
  // first submitted or queued prompt must not come back as a pending turn that blocks sending.
  const [hasHadMessages, setHasHadMessages] = useState(false);
  if (!hasHadMessages && messages.length > 0) setHasHadMessages(true);

  // The submitted or queued prompt shows as the user turn until the conversation has messages.
  let visiblePendingPrompt: string | undefined;
  if (messages.length === 0 && !hasHadMessages) {
    visiblePendingPrompt = pendingPrompt ?? chat?.messages_queue?.text;
  }
  const isStarting = isCreating || visiblePendingPrompt !== undefined;
  const isEmpty = chatId === undefined && pendingPrompt === undefined;

  // The turn that stopped short: this browser's request error first (it may never have reached
  // the backend), else how the backend recorded the last request ending, which survives a reload.
  let interruption: ChatInterruption | undefined;
  if (error) {
    interruption = { kind: "failed", message: error.message };
  } else if (chat?.interruption && !chat.activeStream) {
    interruption = chat.interruption;
  }
  const runState = sessionRunState(
    status,
    messages,
    isStarting,
    interruption,
    chat?.activeStream === true,
  );

  const submittedTitle = pendingPrompt?.split("\n")[0]?.trim() || undefined;
  const title = chat?.title ?? submittedTitle;

  // `undefined` while a saved chat or the Projects list is still loading, so the Tab keeps its hint.
  const isProjectKnown =
    (usesDraftChoices || chat !== undefined) && (projectId === null || projects !== undefined);
  const projectHint = useMemo((): TabProjectHint | null | undefined => {
    if (!isProjectKnown) return undefined;
    if (!selectedProject) return null;
    return { name: selectedProject.name, color: selectedProject.color, icon: selectedProject.icon };
  }, [isProjectKnown, selectedProject]);
  useEffect(() => {
    onTabHint(tabId, { title, runState, project: projectHint });
  }, [onTabHint, projectHint, runState, tabId, title]);

  /** Send body for one model, omitting reasoning options it does not support. */
  const buildSendBody = useCallback(
    (modelSlug: string) => {
      const modelData = models?.find((candidate) => candidate.slug === modelSlug);
      return {
        chatId,
        model: modelSlug,
        provider: selectedProvider,
        serviceTier: validServiceTier(modelData, selectedProvider, serviceTier),
        inferenceMode: validInferenceMode(modelData, selectedProvider, effectiveMode),
        reasoningEffort: validReasoningEffort(modelData, reasoningEffort),
        reasoningBudget:
          modelData?.features?.reasoning_budget && reasoningBudget ? reasoningBudget : undefined,
      };
    },
    [
      chatId,
      models,
      reasoningBudget,
      reasoningEffort,
      selectedProvider,
      serviceTier,
      effectiveMode,
    ],
  );

  async function submitDraft({ text, files }: ComposerMessage) {
    if (!text && files.length === 0) return;
    if (!settingsWorkspaceId || !selectedModel || !selectedModelData) {
      setCreateError("Your account is not ready for chat yet.");
      throw new Error("Chat is not ready.");
    }

    const workerSelection = isOwner && !choicesAreStale ? withoutDirectory(draftWorker) : null;
    const toolOverride = choicesAreStale ? null : draftTools;
    setCreateError(null);
    setIsCreating(true);
    setPendingPrompt(text);
    try {
      const createdChatId = await createChat({
        workspace: settingsWorkspaceId,
        scope: draftScope,
        ...(workerSelection ? { worker: workerSelection } : {}),
        ...(selectedProject ? { project: selectedProject._id } : {}),
        // Only a draft whose tools were changed carries an override; otherwise the chat follows
        // the workspace defaults. MCP server ids round-trip as strings and Convex narrows them.
        ...(toolOverride
          ? {
              tools: {
                builtinToolSets: toolOverride.builtinToolSets,
                mcpServers: toolOverride.mcpServers as Id<"mcp_servers">[],
              },
            }
          : {}),
        messages_queue: {
          text,
          files,
          model: selectedModel,
          ...(selectedProvider ? { provider: selectedProvider } : {}),
          ...(selectedTier ? { serviceTier: selectedTier } : {}),
          ...(effectiveMode ? { inferenceMode: effectiveMode } : {}),
          ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
          ...(selectedBudget ? { reasoningBudget: selectedBudget } : {}),
          webSearch: false,
        },
      });
      setCreatedChatId(createdChatId);
      onCreated(tabId, createdChatId);
    } catch (caughtError) {
      setPendingPrompt(undefined);
      setCreateError(caughtError instanceof Error ? caughtError.message : "Something went wrong.");
      throw caughtError;
    } finally {
      setIsCreating(false);
    }
  }

  function submitTurn({ text, files }: ComposerMessage) {
    if ((!text && files.length === 0) || !selectedModel) return;
    // Sending makes a revert durable: the request carries the shortened history.
    setPendingRevert(null);
    void sendMessage({ text, files }, { body: buildSendBody(selectedModel) });
  }

  function handleRegenerate(message: UIMessage) {
    if (!selectedModel) return;
    setPendingRevert(null);
    void regenerate({ messageId: message.id, body: buildSendBody(selectedModel) });
  }

  /**
   * Retry from the interruption card: the stopped turn continues instead of starting over. Its
   * unfinished step is dropped and the conversation is resent without a new user message, so the
   * reply picks up after its last completed step, with the model selected now.
   */
  function continueInterruptedTurn() {
    if (!selectedModel || status === "submitted" || status === "streaming") return;
    setMessages(withoutUnfinishedStep(messages));
    void sendMessage(undefined, { body: buildSendBody(selectedModel) });
  }

  /**
   * Reverts to a user turn: it and every later message leave the thread, and its text and files
   * replace the Composer draft. Nothing is persisted until the next send, so the first revert's
   * snapshot (messages and the draft it replaced) stays restorable across further reverts.
   */
  async function handleRevert(message: UIMessage) {
    if (status === "submitted" || status === "streaming") return;
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    if (index === -1) return;

    const files = await Promise.all(getMessageFiles(message).map(toComposerFile));
    const replacedDraft = composerRef.current?.swapDraft({
      text: getMessageText(message),
      files: files.filter((file) => file !== null),
    });
    setPendingRevert(
      (current) => current ?? { messages, draft: replacedDraft ?? { text: "", files: [] } },
    );
    setMessages(messages.slice(0, index));
    clearError();
  }

  function restoreRevert() {
    if (!pendingRevert) return;
    setMessages(pendingRevert.messages);
    composerRef.current?.swapDraft(pendingRevert.draft);
    setPendingRevert(null);
  }

  /**
   * Forks into a fresh chat and opens it. A user turn forks with the prior history and re-queues
   * that turn for the chosen model; an assistant turn forks the conversation up to and including
   * it, and the chosen model is preselected for the next turn.
   */
  async function handleFork(message: UIMessage, forkModel: string) {
    if (!settingsWorkspaceId) return;
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    if (index === -1) return;

    let newChatId: Id<"aisdk_chats">;
    if (message.role === "assistant") {
      newChatId = await forkChat({
        workspace: settingsWorkspaceId,
        scope: chat?.scope,
        project: chat?.project ?? undefined,
        messages: messages.slice(0, index + 1),
      });
    } else {
      const forkModelData = models?.find((candidate) => candidate.slug === forkModel);
      const forkEffort = validReasoningEffort(forkModelData, reasoningEffort);
      const forkTier = validServiceTier(forkModelData, selectedProvider, serviceTier);
      const forkMode = validInferenceMode(forkModelData, selectedProvider, effectiveMode);
      const forkBudget =
        forkModelData?.features?.reasoning_budget && reasoningBudget ? reasoningBudget : undefined;
      newChatId = await forkChat({
        workspace: settingsWorkspaceId,
        scope: chat?.scope,
        project: chat?.project ?? undefined,
        messages: messages.slice(0, index),
        messages_queue: {
          text: getMessageText(message),
          files: getMessageFiles(message),
          model: forkModel,
          ...(selectedProvider ? { provider: selectedProvider } : {}),
          ...(forkTier ? { serviceTier: forkTier } : {}),
          ...(forkMode ? { inferenceMode: forkMode } : {}),
          ...(forkEffort ? { reasoningEffort: forkEffort } : {}),
          ...(forkBudget ? { reasoningBudget: forkBudget } : {}),
          webSearch: false,
        },
      });
    }
    patchTabState(`chat-${newChatId}`, {
      serviceTier: validServiceTier(
        models?.find((candidate) => candidate.slug === forkModel),
        selectedProvider,
        serviceTier,
      ),
      inferenceMode: validInferenceMode(
        models?.find((candidate) => candidate.slug === forkModel),
        selectedProvider,
        effectiveMode,
      ),
    });

    await navigate({
      to: "/chat/$chatId",
      params: { chatId: newChatId },
      search: { model: forkModel, provider: selectedProvider },
    });
  }

  async function changeScope(scope: ChatScope) {
    if (!chatId) {
      setDraftScope(scope);
      return;
    }
    if (!chat?.canManageScope || isScopeSaving) return;
    setIsScopeSaving(true);
    try {
      await setChatScope({ chatId, scope });
    } catch (caughtError) {
      toast.error(
        caughtError instanceof Error ? caughtError.message : "Failed to update chat visibility.",
      );
    } finally {
      setIsScopeSaving(false);
    }
  }

  async function changeWorker(selection: ChatWorkerSelection | null) {
    const next = withoutDirectory(selection);
    if (!chatId) {
      setDraftWorker(next);
      return;
    }
    if (!chat?.canManage || isWorkerSaving) return;
    setIsWorkerSaving(true);
    try {
      await setChatWorker({ chatId, selection: next });
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Failed to update Worker.");
    } finally {
      setIsWorkerSaving(false);
    }
  }

  // Thread callbacks keep one identity for the Tab's lifetime and call the latest handlers, so a
  // Tab switch (only `isActive` changes) does not re-render every memoized message.
  const latestThreadHandlers = useRef({ handleRegenerate, handleRevert, handleFork });
  useLayoutEffect(() => {
    latestThreadHandlers.current = { handleRegenerate, handleRevert, handleFork };
  });
  const threadActions = useMemo(
    () => ({
      onCopy: copyMessageText,
      onRevert: (message: UIMessage) => {
        void latestThreadHandlers.current.handleRevert(message);
      },
      onRegenerate: (message: UIMessage) => latestThreadHandlers.current.handleRegenerate(message),
      onFork: (message: UIMessage, forkModel: string) => {
        void latestThreadHandlers.current
          .handleFork(message, forkModel)
          .catch((caughtError: unknown) => {
            toast.error(
              caughtError instanceof Error ? caughtError.message : "Failed to fork chat.",
            );
          });
      },
    }),
    [],
  );

  if (isChatUnavailable) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Alert className="max-w-md" variant="destructive">
          <AlertTitle>Chat unavailable</AlertTitle>
          <AlertDescription>
            This chat is no longer available to your account. The workspace may have changed or your
            membership may have been removed.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const isRunning = status === "submitted" || status === "streaming";
  const canSend =
    chatId === undefined
      ? Boolean(settingsWorkspaceId && selectedModelData) && !isModelLoading && !isCreating
      : chat !== undefined &&
        seededChatId === chatId &&
        status === "ready" &&
        Boolean(selectedModel) &&
        !isStarting;
  const latestUsage = findLatestUsage(messages);
  const maxTokens = selectedModelData?.providers.find(
    (provider) => provider.id === selectedProvider,
  )?.context;
  const canManageChat = usesDraftChoices || chat?.canManage === true;
  let workerSelection: ChatWorkerSelection | null = chat?.worker ?? null;
  if (usesDraftChoices) workerSelection = choicesAreStale ? null : draftWorker;
  const isRunTargetFixed = messages.length > 0 && agent.protocol === "acp";
  const isWorkerBusy = isWorkerSaving || (chatId !== undefined && status !== "ready");
  const pendingApprovals = getPendingApprovals(messages);
  const currentApproval = pendingApprovals[0];
  // A question shows once its turn has stopped streaming, after every approval of that step.
  const currentQuestion =
    isRunning || currentApproval ? undefined : getPendingQuestions(messages)[0];
  const isComposerReplaced = currentApproval !== undefined || currentQuestion !== undefined;
  const revertedCount = pendingRevert ? pendingRevert.messages.length - messages.length : 0;
  // A revert or a pending answer comes first; Retry would resend the reverted or unanswered turn.
  const visibleInterruption =
    interruption &&
    chatId !== undefined &&
    messages.length > 0 &&
    !isRunning &&
    !isStarting &&
    !isComposerReplaced &&
    !pendingRevert
      ? interruption
      : undefined;

  return (
    <div className="relative flex h-full flex-col">
      {isEmpty ? <SessionAmbient /> : null}

      {/* Inside a chat, its Worker and context usage sit in the Panel's top-right corner, under
          the User menu; a New session keeps them in the line under its Composer. Deviation from
          §2 (Session context is fixed after the first message): the built-in agent runs in
          Convex and only calls Worker tools, so chat managers may still change the Worker (and
          Worker tools in the Tools Dialog) through SetChatWorker. The Worker must lock once
          `agent.protocol === "acp"`, because an ACP agent process lives on its Worker. */}
      {isEmpty ? null : (
        <div className="relative flex h-11 shrink-0 items-center justify-end gap-1 px-3">
          {latestUsage && maxTokens ? (
            <div className="shrink-0 max-sm:hidden">
              <ContextUsage
                usage={latestUsage.usage}
                maxTokens={maxTokens}
                executions={latestUsage.executions}
              />
            </div>
          ) : null}
          <SessionWorkerControl
            workspaceId={settingsWorkspaceId}
            isOwner={isOwner}
            canManage={canManageChat}
            isFixed={isRunTargetFixed}
            isSaving={isWorkerBusy}
            selection={workerSelection}
            defaultWorkerTools={workerToolDefaults ?? []}
            agent={agent}
            onSelectionChange={(selection) => void changeWorker(selection)}
            onAgentChange={setAgent}
          />
        </div>
      )}

      {isEmpty ? null : (
        <>
          {isWaitingForChat && visiblePendingPrompt === undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : (
            <SessionThread
              messages={messages}
              status={status}
              pendingPrompt={visiblePendingPrompt || undefined}
              showChainOfThought={chainOfThoughtEnabled}
              forkModels={models}
              agentName={agent.name}
              canRevert={!isRunning && chat !== undefined}
              onCopy={threadActions.onCopy}
              onRevert={threadActions.onRevert}
              onRegenerate={threadActions.onRegenerate}
              onFork={threadActions.onFork}
            />
          )}
        </>
      )}

      <div
        className={cn(
          "relative mx-auto flex w-full flex-col px-4",
          isEmpty ? "max-w-168 flex-1 justify-center gap-3" : "max-w-190 gap-2 pb-4",
        )}
      >
        {isEmpty ? (
          <h1 className="mb-6 flex justify-center">
            <RadiumWordmark className="h-14 w-auto md:h-16" />
          </h1>
        ) : null}

        {createError ? (
          <Alert variant="destructive">
            <AlertTitle>Unable to start chat</AlertTitle>
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        ) : null}
        {modelsError ? (
          <Alert variant="destructive">
            <AlertTitle>Workspace unavailable</AlertTitle>
            <AlertDescription>
              Model settings for this workspace are no longer available to your account. Switch
              workspaces and try again.
            </AlertDescription>
          </Alert>
        ) : null}

        <AnimatePresence initial={false}>
          {visibleInterruption ? (
            <m.div
              key="interruption"
              variants={variants.reveal}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <RunInterruptionCard
                interruption={visibleInterruption}
                canRetry={chat !== undefined && Boolean(selectedModel)}
                shortcutsEnabled={isActive}
                onRetry={continueInterruptedTurn}
                onSwitchModel={() => setIsModelPickerOpen(true)}
              />
            </m.div>
          ) : null}
          {pendingRevert && !isComposerReplaced ? (
            <m.div
              key="revert"
              variants={variants.reveal}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="flex items-center gap-2 rounded-xl border border-border bg-card py-1 pr-1 pl-3 text-xs text-muted-foreground"
            >
              <Undo2Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                Reverted {revertedCount} {revertedCount === 1 ? "message" : "messages"}. Sending
                replaces them.
              </span>
              <Button variant="ghost" size="xs" onClick={restoreRevert}>
                <RotateCcwIcon data-icon="inline-start" />
                Restore
              </Button>
            </m.div>
          ) : null}
        </AnimatePresence>

        {/* The todo tray is the top of the prompt slot: while it is attached (until its exit
            finishes) the slot squares its top corners so the two read as one extended input. A
            pending approval or question takes the Composer's place; the Composer stays mounted
            (hidden) so its draft text, files, and model choice survive the answer. */}
        <div
          data-tray={isTrayAttached ? "attached" : undefined}
          className="group/prompt-slot flex flex-col"
        >
          <AnimatePresence initial={false} onExitComplete={() => setIsTrayAttached(false)}>
            {trayTodos ? <TodoPanel key="todos" items={trayTodos} isRunning={isRunning} /> : null}
          </AnimatePresence>
          <div className="flex flex-col">
            <AnimatePresence initial={false}>
              {currentApproval ? (
                <m.div
                  key="approval"
                  variants={variants.swap}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  <ApprovalPrompt
                    part={currentApproval}
                    total={pendingApprovals.length}
                    shortcutsEnabled={isActive}
                    onApprovalResponse={addToolApprovalResponse}
                  />
                </m.div>
              ) : null}
              {currentQuestion ? (
                <m.div
                  key={`question-${currentQuestion.toolCallId}`}
                  variants={variants.swap}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  <QuestionPrompt
                    part={currentQuestion}
                    shortcutsEnabled={isActive}
                    onAnswer={(output) =>
                      void addToolOutput({
                        tool: "question",
                        toolCallId: currentQuestion.toolCallId,
                        output,
                      })
                    }
                    onDismiss={() =>
                      void addToolOutput({
                        tool: "question",
                        toolCallId: currentQuestion.toolCallId,
                        state: "output-error",
                        errorText: QUESTION_DISMISSED_MESSAGE,
                      })
                    }
                  />
                </m.div>
              ) : null}
            </AnimatePresence>

            <div hidden={isComposerReplaced}>
              <Composer
                ref={composerRef}
                layoutId={`composer-${tabId}`}
                workspace={chatId ? chat?.workspace : settingsWorkspaceId}
                autoFocus={isEmpty && isActive}
                canSend={canSend}
                isRunning={isRunning}
                onSubmit={chatId === undefined ? submitDraft : submitTurn}
                onStop={() => void stop()}
                modelControl={
                  <ModelPicker
                    models={models}
                    isLoading={isModelLoading}
                    selectedModel={selectedModel}
                    selectedProvider={selectedProvider}
                    serviceTier={selectedTier}
                    inferenceMode={effectiveMode}
                    reasoningEffort={selectedEffort}
                    reasoningBudget={reasoningBudget}
                    onModelChange={setModelOverride}
                    onProviderChange={setProviderOverride}
                    onServiceTierChange={setServiceTier}
                    onInferenceModeChange={setInferenceMode}
                    onReasoningEffortChange={setReasoningEffort}
                    onReasoningBudgetChange={setReasoningBudget}
                    isOpen={isModelPickerOpen}
                    onOpenChange={setIsModelPickerOpen}
                  />
                }
                menuItems={
                  <ConversationVisibilityMenu
                    scope={chat?.scope ?? draftScope}
                    isDraft={chatId === undefined}
                    canChange={
                      chatId === undefined || (chat?.canManageScope === true && !isScopeSaving)
                    }
                    onChange={(scope) => void changeScope(scope)}
                  />
                }
                toolbarControls={
                  isOwner && canManageChat ? (
                    <ToolsDialog
                      workspace={settingsWorkspaceId}
                      chatId={chatId}
                      draftTools={choicesAreStale ? null : draftTools}
                      onDraftToolsChange={setDraftTools}
                      workerSelection={workerSelection}
                      isWorkerLocked={isWorkerBusy || isRunTargetFixed}
                      onWorkerSelectionChange={(selection) => void changeWorker(selection)}
                    />
                  ) : null
                }
                textStore={composerTextStore}
              />
            </div>
          </div>
        </div>

        {/* Only a New session shows its context under the Composer; a chat's Worker sits in the
            Panel corner and its Project never changes from the Session. */}
        {isEmpty ? (
          <SessionContext
            workspaceId={settingsWorkspaceId}
            isOwner={isOwner}
            canManage={canManageChat}
            isSaving={isWorkerBusy}
            projects={projects}
            project={selectedProject}
            selection={workerSelection}
            defaultWorkerTools={workerToolDefaults ?? []}
            agent={agent}
            onProjectChange={selectDraftProject}
            onSelectionChange={(selection) => void changeWorker(selection)}
            onAgentChange={setAgent}
          />
        ) : null}
      </div>
    </div>
  );
});

/** Copies a turn's text; it needs nothing from the Session, so its identity never changes. */
function copyMessageText(message: UIMessage) {
  const text = getMessageText(message);
  if (text) void navigator.clipboard?.writeText(text);
}

/**
 * The selection as the client may send or keep it: the Worker directory is derived by the backend
 * and never chosen here, so a stored or restored one is dropped.
 */
function withoutDirectory(selection: ChatWorkerSelection | null): ChatWorkerSelection | null {
  if (!selection) return null;
  if (selection.workerId === undefined) return { tools: selection.tools };
  return { workerId: selection.workerId, tools: selection.tools };
}

/**
 * Tab RunState from the chat lifecycle; the one place UI status is derived for a Session. Metadata
 * keeps unopened Tabs' remote runs visible without fetching messages. A turn that stopped short
 * stays `failed` or `cancelled` until the next request, also after a reload.
 */
function sessionRunState(
  status: ChatStatus,
  messages: UIMessage[],
  isStarting: boolean,
  interruption: ChatInterruption | undefined,
  activeStream: boolean,
): RunState {
  if (status === "error") return "failed";
  if (getPendingApprovals(messages).length > 0) return "awaiting";
  if (status === "ready" && getPendingQuestions(messages).length > 0) return "awaiting";
  if (status === "streaming") return "streaming";
  if (status === "submitted") return "thinking";
  // A run this Tab did not start (another browser tab, before a reload, or a Tab whose messages
  // are not loaded yet) is visible only through the chat metadata.
  if (activeStream) return "streaming";
  if (isStarting) return "queued";
  if (interruption?.kind === "failed") return "failed";
  if (interruption?.kind === "interrupted") return "cancelled";
  return "idle";
}

/** Cumulative token usage of the latest assistant turn that reported it. */
function findLatestUsage(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const metadata = messages[index]?.metadata;
    const usage = getUsageMetadata(metadata);
    if (usage) {
      const executions =
        typeof metadata === "object" &&
        metadata !== null &&
        "gatewayExecutions" in metadata &&
        Array.isArray(metadata.gatewayExecutions)
          ? metadata.gatewayExecutions
          : undefined;
      return { usage, executions };
    }
  }
  return undefined;
}

/** Queued attachments without a URL cannot be represented as AI SDK file parts. */
function hasFileUrl<T extends { url?: string }>(file: T): file is T & FileUIPart {
  return Boolean(file.url);
}

/** A sent file part back as a `File` for the Composer; a part that cannot be read is dropped. */
async function toComposerFile(part: FileUIPart): Promise<File | null> {
  try {
    const response = await fetch(part.url);
    const blob = await response.blob();
    return new File([blob], part.filename ?? "attachment", { type: part.mediaType });
  } catch {
    return null;
  }
}

/** Chatroom's AI SDK endpoint lives on the Convex site origin, not the web origin. */
function getAiSdkChatApi() {
  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL;
  return siteUrl ? `${siteUrl.replace(/\/$/, "")}/api/aisdk/chat` : "/api/aisdk/chat";
}

/** Bearer header for the Convex HTTP action; resolved per request so tokens stay fresh. */
async function getConvexAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await authClient.convex.token({ fetchOptions: { throw: false } });
  return data?.token ? { Authorization: `Bearer ${data.token}` } : {};
}
