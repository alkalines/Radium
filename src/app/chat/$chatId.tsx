import { DefaultChatTransport, type ToolUIPart, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { useQuery } from "convex/react";
import { ensureSession as ensureSessionClient } from "@better-auth-ui/react";
import { ensureSession as ensureSessionServer } from "@better-auth-ui/react/server";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
} from "@/components/ai-elements/confirmation";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  ChatPromptInput,
  filterFilesWithUrl,
  type ReasoningEffort,
} from "@/components/chat/chat-prompt-input";
import {
  ChatConversationSkeleton,
  ChatStartingTransition,
  chatComposerViewTransitionName,
  clearChatHandoff,
  readChatHandoff,
} from "@/components/chat/chat-loading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/chat/$chatId")({
  staticData: {
    pageTitle: "Chat",
  },
  async beforeLoad({ context: { queryClient }, location }) {
    const ensureSession = createIsomorphicFn()
      .server(() =>
        ensureSessionServer(queryClient, auth as any, {
          baseURL: getRequestUrl().origin,
          headers: getRequestHeaders(),
        }),
      )
      .client(() => ensureSessionClient(queryClient, authClient));

    const session = await ensureSession();

    if (!session) {
      throw redirect({
        to: "/auth/$path",
        params: { path: "sign-in" },
        search: { redirectTo: location.href },
      });
    }
  },
  component: ChatConversationPage,
});

function ChatConversationPage() {
  const { chatId } = Route.useParams();

  return <ChatConversationContent chatId={chatId} key={chatId} />;
}

function ChatConversationContent({ chatId }: { chatId: string }) {
  const convexChatId = chatId as Id<"aisdk_chats">;
  const chat = useQuery(api.aisdk.GetChat, { chatId: convexChatId });
  const models = useQuery(api.models.availableModels);
  const [model, setModel] = useState<string>();
  const [reasoningBudget, setReasoningBudget] = useState<number>();
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [handoffPrompt] = useState(() => readChatHandoff(chatId));
  const [handoffSettled, setHandoffSettled] = useState(() => handoffPrompt === null);
  const loadedInitialMessages = useRef(false);
  const sentQueuedMessage = useRef(false);
  const submittedApprovalContinuations = useRef(new Set<string>());
  const queuedModel = typeof chat === "string" ? undefined : chat?.messages_queue?.model;
  const selectedModel = model ?? queuedModel ?? models?.[0]?.slug;
  const selectedModelData = models?.find((item) => item.slug === selectedModel);
  const handleModelChange = useCallback((nextModel: string) => {
    setModel(nextModel);
  }, []);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: getAiSdkChatApi(),
        body: {
          chatId: convexChatId,
          model: selectedModel,
          reasoningEffort: selectedModelData?.reasoning ? reasoningEffort : undefined,
          reasoningBudget:
            selectedModelData?.features?.reasoning_budget && reasoningBudget
              ? reasoningBudget
              : undefined,
        },
        headers: getConvexAuthHeaders,
        prepareSendMessagesRequest({ api: requestApi, body, credentials, headers, id, messages }) {
          const requestModel = body?.model ?? getLastMessageModel(messages);

          return {
            api: requestApi,
            body: {
              ...body,
              chatId: convexChatId,
              id,
              messages,
              model: requestModel,
            },
            credentials,
            headers,
          };
        },
        credentials: "include",
      }),
    [
      convexChatId,
      reasoningBudget,
      reasoningEffort,
      selectedModel,
      selectedModelData?.features?.reasoning_budget,
      selectedModelData?.reasoning,
    ],
  );
  const { addToolApprovalResponse, error, messages, sendMessage, setMessages, status, stop } =
    useChat({
      id: chatId,
      sendAutomaticallyWhen: ({ messages: nextMessages }) => {
        const continuationKey = getApprovalContinuationKey(nextMessages);

        if (!continuationKey || submittedApprovalContinuations.current.has(continuationKey)) {
          return false;
        }

        submittedApprovalContinuations.current.add(continuationKey);
        return true;
      },
      transport,
    });

  useEffect(() => {
    if (handoffPrompt === null) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHandoffSettled(true);
    }, 1450);

    return () => window.clearTimeout(timeoutId);
  }, [handoffPrompt]);

  useEffect(() => {
    if (chat !== undefined) {
      clearChatHandoff(chatId);
    }
  }, [chat, chatId]);

  useEffect(() => {
    if (loadedInitialMessages.current || !chat || typeof chat === "string") {
      return;
    }

    setMessages(chat.messages as UIMessage[]);
    loadedInitialMessages.current = true;
  }, [chat, setMessages]);

  useEffect(() => {
    if (
      sentQueuedMessage.current ||
      !chat ||
      typeof chat === "string" ||
      !chat.messages_queue ||
      status !== "ready"
    ) {
      return;
    }

    sentQueuedMessage.current = true;
    void sendMessage(
      {
        text: chat.messages_queue.text,
        files: chat.messages_queue.files.filter(filterFilesWithUrl),
      },
      {
        body: {
          chatId: convexChatId,
          model: chat.messages_queue.model,
          reasoningBudget: chat.messages_queue.reasoningBudget,
          reasoningEffort: chat.messages_queue.reasoningEffort,
        },
      },
    );
  }, [chat, convexChatId, sendMessage, status]);

  if (chat === undefined) {
    if (handoffPrompt !== null) {
      return (
        <ChatStartingTransition prompt={handoffPrompt}>
          <ChatPromptInput
            disabled
            models={models}
            onModelChange={handleModelChange}
            onReasoningBudgetChange={setReasoningBudget}
            onReasoningEffortChange={setReasoningEffort}
            placeholder="Continue the conversation..."
            reasoningBudget={reasoningBudget}
            reasoningEffort={reasoningEffort}
            selectedModel={selectedModel}
            status="submitted"
          />
        </ChatStartingTransition>
      );
    }

    return <ChatConversationSkeleton />;
  }

  if (!handoffSettled && handoffPrompt !== null) {
    return (
      <ChatStartingTransition prompt={handoffPrompt}>
        <ChatPromptInput
          disabled
          models={models}
          onModelChange={handleModelChange}
          onReasoningBudgetChange={setReasoningBudget}
          onReasoningEffortChange={setReasoningEffort}
          placeholder="Continue the conversation..."
          reasoningBudget={reasoningBudget}
          reasoningEffort={reasoningEffort}
          selectedModel={selectedModel}
          status="submitted"
        />
      </ChatStartingTransition>
    );
  }

  if (typeof chat === "string") {
    return (
      <main className="flex min-h-[calc(100svh-var(--header-height))] items-center justify-center p-4">
        <Alert className="max-w-md" variant="destructive">
          <AlertTitle>Chat unavailable</AlertTitle>
          <AlertDescription>{chat}</AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="flex min-h-[calc(100svh-var(--header-height))] flex-col">
      <Conversation className="min-h-0">
        <ConversationContent className="mx-auto w-full max-w-4xl px-4 py-8">
          {messages.length === 0 ? (
            <ConversationEmptyState description="Send a prompt to begin." title="No messages yet" />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, index) => {
                    if (part.type === "text") {
                      return (
                        <MessageResponse key={`${message.id}-${index}`}>
                          {part.text}
                        </MessageResponse>
                      );
                    }

                    if (part.type === "reasoning") {
                      return (
                        <Reasoning
                          isStreaming={part.state === "streaming"}
                          key={`${message.id}-${index}`}
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    }

                    if (isToolPart(part)) {
                      return (
                        <ChatToolPart
                          hasLaterAssistantContent={message.parts
                            .slice(index + 1)
                            .some(hasRenderableAssistantContent)}
                          key={`${message.id}-${index}`}
                          onApprovalResponse={addToolApprovalResponse}
                          part={part}
                        />
                      );
                    }

                    return null;
                  })}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="sticky bottom-0 border-t bg-background/95 p-4 backdrop-blur">
        <div
          className="mx-auto flex w-full max-w-3xl flex-col gap-3"
          style={{ viewTransitionName: chatComposerViewTransitionName }}
        >
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Message failed</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}

          <ChatPromptInput
            disabled={status !== "ready" || !selectedModel}
            models={models}
            onModelChange={handleModelChange}
            onReasoningBudgetChange={setReasoningBudget}
            onReasoningEffortChange={setReasoningEffort}
            onStop={() => void stop()}
            onSubmit={({ text, files }) => {
              const trimmedText = text.trim();

              if ((!trimmedText && files.length === 0) || !selectedModel) {
                return;
              }

              void sendMessage(
                { text: trimmedText, files },
                {
                  body: {
                    chatId: convexChatId,
                    model: selectedModel,
                    reasoningEffort: selectedModelData?.reasoning ? reasoningEffort : undefined,
                    reasoningBudget:
                      selectedModelData?.features?.reasoning_budget && reasoningBudget
                        ? reasoningBudget
                        : undefined,
                  },
                },
              );
            }}
            placeholder="Continue the conversation..."
            reasoningBudget={reasoningBudget}
            reasoningEffort={reasoningEffort}
            selectedModel={selectedModel}
            status={status}
          />
        </div>
      </div>
    </main>
  );
}

type ToolApprovalResponse = Parameters<ReturnType<typeof useChat>["addToolApprovalResponse"]>[0];

function ChatToolPart({
  hasLaterAssistantContent,
  onApprovalResponse,
  part,
}: {
  hasLaterAssistantContent: boolean;
  onApprovalResponse: (response: ToolApprovalResponse) => void;
  part: ToolUIPart;
}) {
  const approval = "approval" in part ? part.approval : undefined;
  const toolInput = getToolInput(part);
  const toolName = part.type.replace(/^tool-/, "");
  // @ts-expect-error state only available in AI SDK v6
  const isApprovalRequested = part.state === "approval-requested";
  const shouldAutoClose =
    part.state === "approval-responded" ||
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied" ||
    (hasLaterAssistantContent && !isApprovalRequested);
  const [isOpen, setIsOpen] = useState(!shouldAutoClose);

  useEffect(() => {
    if (isApprovalRequested) {
      setIsOpen(true);
      return;
    }

    if (shouldAutoClose) {
      setIsOpen(false);
    }
  }, [isApprovalRequested, shouldAutoClose]);

  return (
    <Tool
      className="w-[min(calc(100vw-2rem),42rem)] max-w-full"
      onOpenChange={setIsOpen}
      open={isOpen}
    >
      <ToolHeader state={part.state} title={toolName} type={part.type} />
      <ToolContent>
        <ToolInput input={toolInput} key={JSON.stringify(toolInput)} />
        {approval && isApprovalRequested ? (
          <Confirmation
            approval={approval}
            className="border-0 bg-transparent px-4 pt-0 pb-4 shadow-none"
            state={part.state}
          >
            <ConfirmationActions className="w-full justify-end pt-1">
              <ConfirmationAction
                onClick={() => onApprovalResponse({ approved: false, id: approval.id })}
                variant="outline"
              >
                Deny
              </ConfirmationAction>
              <ConfirmationAction
                onClick={() => onApprovalResponse({ approved: true, id: approval.id })}
              >
                Approve
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        ) : null}
        <ToolOutput errorText={part.errorText} output={part.output} />
      </ToolContent>
    </Tool>
  );
}

function isToolPart(part: UIMessage["parts"][number]): part is ToolUIPart {
  return part.type.startsWith("tool-");
}

function hasRenderableAssistantContent(part: UIMessage["parts"][number]) {
  if (part.type === "text") {
    return part.text.trim().length > 0;
  }

  if (part.type === "reasoning") {
    return part.text.trim().length > 0;
  }

  return !isToolPart(part) && part.type !== "step-start";
}

function getApprovalContinuationKey(messages: UIMessage[]) {
  const message = messages[messages.length - 1];

  if (!message || message.role !== "assistant") {
    return null;
  }

  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    -1,
  );
  const toolParts = message.parts.slice(lastStepStartIndex + 1).filter(isToolPart);
  const respondedApprovals = toolParts.filter(
    (part) => part.state === "approval-responded" && "approval" in part,
  );

  if (respondedApprovals.length === 0) {
    return null;
  }

  const canContinue = toolParts.every(
    (part) =>
      part.state === "output-available" ||
      part.state === "output-error" ||
      part.state === "approval-responded",
  );

  if (!canContinue) {
    return null;
  }

  return respondedApprovals.map((part) => part.approval.id).join(":");
}

function getToolInput(part: ToolUIPart) {
  if (part.input !== undefined) {
    return part.input;
  }

  return "rawInput" in part ? part.rawInput : {};
}

function getLastMessageModel(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const metadata = messages[index]?.metadata;

    if (isModelMetadata(metadata)) {
      return metadata.model;
    }
  }

  return undefined;
}

function isModelMetadata(metadata: UIMessage["metadata"]): metadata is { model: string } {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "model" in metadata &&
    typeof metadata.model === "string"
  );
}

function getAiSdkChatApi() {
  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL;

  return siteUrl ? `${siteUrl.replace(/\/$/, "")}/api/aisdk/chat` : "/api/aisdk/chat";
}

async function getConvexAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await authClient.convex.token({
    fetchOptions: { throw: false },
  });

  return data?.token ? { Authorization: `Bearer ${data.token}` } : {};
}
