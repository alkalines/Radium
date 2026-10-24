import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DefaultChatTransport, type ChatStatus, type FileUIPart, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatWorkerSelection } from "backend/src/worker/chat-config";
import type { RunState } from "@/components/agentic/agent-status";
import { RadiumWordmark } from "@/components/agentic/radium-wordmark";
import { SessionAmbient } from "@/components/agentic/session-ambient";
import { ChatToolsMenu } from "@/components/chat/chat-tools-menu";
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
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { builtInAgent, type SessionAgent } from "./agents";
import {
  Composer,
  ConversationVisibilityMenu,
  type ChatScope,
  type ComposerMessage,
} from "./composer";
import { ModelPicker, validReasoningEffort } from "./model-picker";
import { SessionContext } from "./session-context";

/** Display hints a Session reports to its Tab in the Tab strip. */
export type SessionTabHint = { title?: string; runState: RunState };

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
 * gates autofocus and approval shortcuts. `onTabHint` reports title and RunState on change.
 */
export function SessionScreen({
  tabId,
  chatId,
  isActive,
  requestedModel,
  requestedProvider,
  onTabHint,
  onCreated,
  onUnavailable,
}: {
  tabId: string;
  chatId?: Id<"aisdk_chats">;
  isActive: boolean;
  requestedModel?: string;
  requestedProvider?: string;
  onTabHint: (hint: SessionTabHint) => void;
  onCreated: (chatId: Id<"aisdk_chats">) => void;
  onUnavailable: () => void;
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
  const [choiceWorkspaceId, setChoiceWorkspaceId] = useState(settingsWorkspaceId);
  const [draftScope, setDraftScope] = useState<ChatScope>("personal");
  const [draftWorker, setDraftWorker] = useState<ChatWorkerSelection | null>(null);
  const [agent, setAgent] = useState<SessionAgent>(builtInAgent);
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isScopeSaving, setIsScopeSaving] = useState(false);
  const [isWorkerSaving, setIsWorkerSaving] = useState(false);

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

  // Model and Worker choices of a draft belong to a workspace; discard them as it changes.
  const choicesAreStale = chatId === undefined && choiceWorkspaceId !== settingsWorkspaceId;
  useEffect(() => {
    if (!choicesAreStale) return;
    setChoiceWorkspaceId(settingsWorkspaceId);
    setModelOverride(undefined);
    setProviderOverride(undefined);
    setDraftWorker(null);
  }, [choicesAreStale, settingsWorkspaceId]);

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
    onUnavailable();
  }, [isChatUnavailable, onUnavailable]);

  // The submitted or queued prompt shows as the user turn until the conversation has messages.
  let visiblePendingPrompt: string | undefined;
  if (messages.length === 0) visiblePendingPrompt = pendingPrompt ?? chat?.messages_queue?.text;
  const isStarting = isCreating || visiblePendingPrompt !== undefined;
  const isEmpty = chatId === undefined && pendingPrompt === undefined;
  const runState = sessionRunState(status, messages, isStarting);

  const submittedTitle = pendingPrompt?.split("\n")[0]?.trim() || undefined;
  const title = chat?.title ?? submittedTitle;
  useEffect(() => {
    onTabHint({ title, runState });
  }, [onTabHint, runState, title]);

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

    const workerSelection = isOwner ? draftWorker : null;
    setCreateError(null);
    setIsCreating(true);
    setPendingPrompt(text);
    try {
      const createdChatId = await createChat({
        workspace: settingsWorkspaceId,
        scope: draftScope,
        ...(workerSelection ? { worker: workerSelection } : {}),
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
      onCreated(createdChatId);
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

  function handleCopy(message: UIMessage) {
    const text = getMessageText(message);
    if (text) void navigator.clipboard?.writeText(text);
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
    if (!chatId) {
      setDraftWorker(selection);
      return;
    }
    if (!chat?.canManage || isWorkerSaving) return;
    setIsWorkerSaving(true);
    try {
      await setChatWorker({ chatId, selection });
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Failed to update Worker.");
    } finally {
      setIsWorkerSaving(false);
    }
  }

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
  const workerSelection = chatId === undefined ? draftWorker : (chat?.worker ?? null);

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
              onCopy={handleCopy}
              onEditStart={(message) => setEditingId(message.id)}
              onEditCancel={() => setEditingId(null)}
              onEditSubmit={handleEditSubmit}
              onRetry={handleRetry}
              onFork={(message, forkModel) => {
                void handleFork(message, forkModel).catch((caughtError: unknown) => {
                  toast.error(
                    caughtError instanceof Error ? caughtError.message : "Failed to fork chat.",
                  );
                });
              }}
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
            <>
              <ConversationVisibilityMenu
                scope={chat?.scope ?? draftScope}
                isDraft={chatId === undefined}
                canChange={
                  chatId === undefined || (chat?.canManageScope === true && !isScopeSaving)
                }
                onChange={(scope) => void changeScope(scope)}
              />
              {isOwner && canManageChat ? (
                <ChatToolsMenu workspace={settingsWorkspaceId} chatId={chatId} />
              ) : null}
            </>
          }
        />

        {/* Deviation from §2 (Session context is fixed after the first message): the built-in agent
            runs in Convex and only calls Worker tools, so chat managers may still change the
            Worker, Directory, and Tools through SetChatWorker. The row must lock once
            `agent.protocol === "acp"`, because an ACP agent process lives on its Worker. */}
        <SessionContext
          workspaceId={settingsWorkspaceId}
          isOwner={isOwner}
          canManage={canManageChat}
          isFixed={messages.length > 0 && agent.protocol === "acp"}
          isSaving={isWorkerSaving || (chatId !== undefined && status !== "ready")}
          selection={workerSelection}
          agent={agent}
          onSelectionChange={(selection) => void changeWorker(selection)}
          onAgentChange={setAgent}
        />
      </div>
    </div>
  );
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
