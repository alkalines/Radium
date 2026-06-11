import { DefaultChatTransport, type UIMessage } from "ai";
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
  const { error, messages, sendMessage, setMessages, status, stop } = useChat({
    id: chatId,
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
        <ConversationContent className="mx-auto w-full max-w-3xl px-4 py-8">
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
