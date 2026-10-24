import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DefaultChatTransport, type ChatStatus, type FileUIPart, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ToolSelection } from "backend/src/chatroom/tools";
import type { ChatWorkerSelection } from "backend/src/worker/chat-config";
import { isWorkerOnline } from "backend/src/worker/presence";
import type { RunState } from "@/components/agentic/agent-status";
import { RadiumWordmark } from "@/components/agentic/radium-wordmark";
import { SessionAmbient } from "@/components/agentic/session-ambient";
import { ContextUsage } from "@/components/session/context-usage";
import {
  getApprovalContinuationKey,
  getLastMessageModel,
  getLastMessageProvider,
  getMessageFiles,
  getMessageText,
  getUsageMetadata,
  hasPendingApproval,
} from "@/components/session/message-parts";
import { SessionThread } from "@/components/session/session-thread";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import type { TabProjectHint } from "@/components/window/window-tabs";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { builtInAgent, sessionAgentById, type SessionAgent, type SessionProject } from "./agents";
import {
  Composer,
  ConversationVisibilityMenu,
  type ChatScope,
  type ComposerMessage,
  type ComposerTextStore,
} from "./composer";
import { ModelPicker, validReasoningEffort } from "./model-picker";
import { SessionContext } from "./session-context";
import { patchTabState, readTabState, type DraftTabSnapshot } from "./tab-state";
import { workerToolsFor } from "@/components/chatroom/tool-catalog";
import { ToolsDialog } from "./tools-dialog";

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
 * - Draft (`chatId` undefined): wordmark, ambient glow, Composer, and Session context, centered.
 *   Submitting persists the chat with `api.aisdk.CreateChat` (prompt in `messages_queue`) and calls
 *   `onCreated`; the prompt stays visible as a pending turn until the chat's messages arrive.
 * - Active: loads `api.aisdk.GetChat`, seeds `useChat` once from the persisted messages, sends a
 *   queued prompt once, then streams turns from `POST /api/aisdk/chat` on the Convex site.
 *   A chat that errors or is no longer accessible shows an inline notice and calls
 *   `onUnavailable` once.
 *
 * The Window keeps every open Tab mounted, so streams continue in background Tabs; `isActive`
 * gates autofocus and approval shortcuts. `onTabHint` reports title, RunState, and Project on
 * change. The callbacks take the Tab id so the Window can pass the same functions to every Tab:
 * the screen is memoized, and with stable props a navigation re-renders only the Tabs whose
 * `isActive` (or requested model/Project) changed.
 *
 * Per-Tab state: what Convex cannot give back (Composer text, model/provider/reasoning choices,
 * the agent, and a draft's workspace, visibility, Worker, Project, and tool override) is kept in
 * the Tab's snapshot (`tab-state.ts`), keyed strictly by `tabId`. It is restored once after mount
 * and rewritten on change; it never writes workspace or user defaults. Saved chats take
 * visibility, Worker, Project, and tools from Convex, never from the snapshot.
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
  const isChatUnavailable = Boolean(chatError) || typeof chatResult === "string";

  const createChat = useMutation(api.aisdk.CreateChat);
  const forkChat = useMutation(api.aisdk.ForkChat);
  const setChatScope = useMutation(api.aisdk.SetChatScope);
  const setChatWorker = useMutation(api.aisdk.SetChatWorker);
  const setChatProject = useMutation(api.aisdk.SetChatProject);

  // An existing chat's settings belong to its own workspace; a draft uses the current one.
  const settingsWorkspaceId = chat?.workspace ?? workspaceId;
  const isOwner = workspaces.some(
    (candidate) => candidate._id === settingsWorkspaceId && candidate.role === "owner",
  );
  const signedIn = userInfo !== undefined && typeof userInfo !== "string";

  const [modelOverride, setModelOverride] = useState(requestedModel);
  const [providerOverride, setProviderOverride] = useState(requestedProvider);
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
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isScopeSaving, setIsScopeSaving] = useState(false);
  const [isWorkerSaving, setIsWorkerSaving] = useState(false);
  const [isProjectSaving, setIsProjectSaving] = useState(false);

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
  if (chatId === undefined) projectId = choicesAreStale ? null : draftProject;
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
  const persistedMessages = chat?.messages as UIMessage[] | undefined;
  const chatModel = persistedMessages ? getLastMessageModel(persistedMessages) : undefined;
  const chatProvider = persistedMessages ? getLastMessageProvider(persistedMessages) : undefined;
  const queuedModel = chat?.messages_queue?.model;
  const queuedProvider = chat?.messages_queue?.provider;
  const hasModels = Boolean(models?.length);
  const isModelListLoading =
    models === undefined || (chatId === undefined && (modelsFetching || choicesAreStale));
  const isWaitingForChat = chatId !== undefined && chatResult === undefined && !chatError;
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
    [chatId, selectedBudget, selectedEffort, selectedModel, selectedProvider],
  );

  // Prevent duplicate sends if the SDK rechecks this approval before it settles.
  const submittedApprovalContinuations = useRef(new Set<string>());
  const {
    addToolApprovalResponse,
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
      const continuationKey = getApprovalContinuationKey(nextMessages);
      if (!continuationKey || submittedApprovalContinuations.current.has(continuationKey)) {
        return false;
      }
      submittedApprovalContinuations.current.add(continuationKey);
      return true;
    },
  });

  // Seed useChat once per chat from persisted messages; later query updates must not overwrite
  // its live state.
  const seededChatId = useRef<string>(undefined);
  useEffect(() => {
    if (!chat || !chatId || seededChatId.current === chatId) return;
    seededChatId.current = chatId;
    setMessages(chat.messages as UIMessage[]);
  }, [chat, chatId, setMessages]);

  // Mark before sending so Convex updates or status changes cannot replay the queued turn.
  const sentQueueChatId = useRef<string>(undefined);
  useEffect(() => {
    const queue = chat?.messages_queue;
    if (!chatId || !queue || status !== "ready" || sentQueueChatId.current === chatId) return;
    sentQueueChatId.current = chatId;
    void sendMessage(
      { text: queue.text, files: queue.files.filter(hasFileUrl) },
      {
        body: {
          chatId,
          model: queue.model,
          provider: queue.provider,
          reasoningBudget: queue.reasoningBudget,
          reasoningEffort: queue.reasoningEffort,
        },
      },
    );
  }, [chat?.messages_queue, chatId, sendMessage, status]);

  const reportedUnavailable = useRef(false);
  useEffect(() => {
    if (!isChatUnavailable || reportedUnavailable.current) return;
    reportedUnavailable.current = true;
    onUnavailable(tabId);
  }, [isChatUnavailable, onUnavailable, tabId]);

  // The submitted or queued prompt shows as the user turn until the conversation has messages.
  let visiblePendingPrompt: string | undefined;
  if (messages.length === 0) visiblePendingPrompt = pendingPrompt ?? chat?.messages_queue?.text;
  const isStarting = isCreating || visiblePendingPrompt !== undefined;
  const isEmpty = chatId === undefined && pendingPrompt === undefined;
  const runState = sessionRunState(status, messages, isStarting);

  const submittedTitle = pendingPrompt?.split("\n")[0]?.trim() || undefined;
  const title = chat?.title ?? submittedTitle;

  // `undefined` while a saved chat or the Projects list is still loading, so the Tab keeps its hint.
  const isProjectKnown =
    (chatId === undefined || chat !== undefined) && (projectId === null || projects !== undefined);
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
        reasoningEffort: validReasoningEffort(modelData, reasoningEffort),
        reasoningBudget:
          modelData?.features?.reasoning_budget && reasoningBudget ? reasoningBudget : undefined,
      };
    },
    [chatId, models, reasoningBudget, reasoningEffort, selectedProvider],
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
          ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
          ...(selectedBudget ? { reasoningBudget: selectedBudget } : {}),
          webSearch: false,
        },
      });
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
    void sendMessage({ text, files }, { body: buildSendBody(selectedModel) });
  }

  function handleRetry(message: UIMessage) {
    if (!selectedModel) return;
    void regenerate({ messageId: message.id, body: buildSendBody(selectedModel) });
  }

  function handleEditSubmit(message: UIMessage, nextText: string) {
    if (!selectedModel) return;
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    if (index === -1) return;
    const files = getMessageFiles(message);
    setEditingId(null);
    setMessages(messages.slice(0, index));
    void sendMessage({ text: nextText, files }, { body: buildSendBody(selectedModel) });
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
          ...(forkEffort ? { reasoningEffort: forkEffort } : {}),
          ...(forkBudget ? { reasoningBudget: forkBudget } : {}),
          webSearch: false,
        },
      });
    }

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

  async function changeProject(project: SessionProject | null) {
    if (!chatId) {
      selectDraftProject(project);
      return;
    }
    if (!chat?.canManage || isProjectSaving) return;
    setIsProjectSaving(true);
    try {
      await setChatProject({ chatId, project: project?._id ?? null });
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Failed to update Project.");
    } finally {
      setIsProjectSaving(false);
    }
  }

  // Thread callbacks keep one identity for the Tab's lifetime and call the latest handlers, so a
  // Tab switch (only `isActive` changes) does not re-render every memoized message.
  const latestThreadHandlers = useRef({ handleRetry, handleEditSubmit, handleFork });
  useLayoutEffect(() => {
    latestThreadHandlers.current = { handleRetry, handleEditSubmit, handleFork };
  });
  const threadActions = useMemo(
    () => ({
      onCopy: copyMessageText,
      onEditStart: (message: UIMessage) => setEditingId(message.id),
      onEditCancel: () => setEditingId(null),
      onEditSubmit: (message: UIMessage, nextText: string) =>
        latestThreadHandlers.current.handleEditSubmit(message, nextText),
      onRetry: (message: UIMessage) => latestThreadHandlers.current.handleRetry(message),
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
      : chat !== undefined && status === "ready" && Boolean(selectedModel) && !isStarting;
  const latestUsage = findLatestUsage(messages);
  const maxTokens = selectedModelData?.providers.find(
    (provider) => provider.id === selectedProvider,
  )?.context;
  const canManageChat = chatId === undefined || chat?.canManage === true;
  let workerSelection: ChatWorkerSelection | null = chat?.worker ?? null;
  if (chatId === undefined) workerSelection = choicesAreStale ? null : draftWorker;
  const isRunTargetFixed = messages.length > 0 && agent.protocol === "acp";
  const isWorkerBusy = isWorkerSaving || (chatId !== undefined && status !== "ready");

  return (
    <div className="relative flex h-full flex-col">
      {isEmpty ? <SessionAmbient /> : null}

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
              isActive={isActive}
              pendingPrompt={visiblePendingPrompt || undefined}
              showChainOfThought={chainOfThoughtEnabled}
              forkModels={models}
              editingId={editingId}
              canEdit={status === "ready" && Boolean(selectedModel)}
              onApprovalResponse={addToolApprovalResponse}
              onCopy={threadActions.onCopy}
              onEditStart={threadActions.onEditStart}
              onEditCancel={threadActions.onEditCancel}
              onEditSubmit={threadActions.onEditSubmit}
              onRetry={threadActions.onRetry}
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
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Message failed</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
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

        <Composer
          layoutId={`composer-${tabId}`}
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
              reasoningEffort={selectedEffort}
              reasoningBudget={reasoningBudget}
              onModelChange={setModelOverride}
              onProviderChange={setProviderOverride}
              onReasoningEffortChange={setReasoningEffort}
              onReasoningBudgetChange={setReasoningBudget}
            />
          }
          contextUsage={
            latestUsage && maxTokens ? (
              <ContextUsage usage={latestUsage} maxTokens={maxTokens} modelId={selectedModel} />
            ) : null
          }
          menuItems={
            <ConversationVisibilityMenu
              scope={chat?.scope ?? draftScope}
              isDraft={chatId === undefined}
              canChange={chatId === undefined || (chat?.canManageScope === true && !isScopeSaving)}
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

        {/* Deviation from §2 (Session context is fixed after the first message): the built-in agent
            runs in Convex and only calls Worker tools, so chat managers may still change the
            Project, Worker, and Directory (and Worker tools in the Tools Dialog) through
            SetChatProject/SetChatWorker. The Worker part must lock once
            `agent.protocol === "acp"`, because an ACP agent process lives on its Worker. */}
        <SessionContext
          workspaceId={settingsWorkspaceId}
          isOwner={isOwner}
          canManage={canManageChat}
          isFixed={isRunTargetFixed}
          isSaving={isWorkerBusy || isProjectSaving}
          projects={projects}
          project={selectedProject}
          selection={workerSelection}
          defaultWorkerTools={workerToolDefaults ?? []}
          agent={agent}
          onProjectChange={(project) => void changeProject(project)}
          onSelectionChange={(selection) => void changeWorker(selection)}
          onAgentChange={setAgent}
        />
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

/** Tab RunState from the chat lifecycle; the one place UI status is derived for a Session. */
function sessionRunState(status: ChatStatus, messages: UIMessage[], isStarting: boolean): RunState {
  if (status === "error") return "failed";
  if (hasPendingApproval(messages)) return "awaiting";
  if (status === "streaming") return "streaming";
  if (status === "submitted") return "thinking";
  if (isStarting) return "queued";
  return "idle";
}

/** Cumulative token usage of the latest assistant turn that reported it. */
function findLatestUsage(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getUsageMetadata(messages[index]?.metadata);
    if (usage) return usage;
  }
  return undefined;
}

/** Queued attachments without a URL cannot be represented as AI SDK file parts. */
function hasFileUrl<T extends { url?: string }>(file: T): file is T & FileUIPart {
  return Boolean(file.url);
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
