"use client";

import { useQuery } from "convex/react";
import { useState, useEffect, useRef, use } from "react";
import { useChat } from "@ai-sdk/react";
import { api } from "../../../../convex/_generated/api";
import ChatroomPromptInput from "@/components/chatroom/chat/PromptInput";
import { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Loader } from "@/components/ai-elements/loader";
import { AlertCircle } from "lucide-react";
import { Id } from "../../../../convex/_generated/dataModel";
import { DefaultChatTransport } from "ai";

export default function ChatPage({
  params,
}: {
  params: Promise<{ chatID: string }>;
  resume?: boolean;
}) {
  const { chatID } = use(params);

  /**
   * ChatroomInput state
   */
  const [selectedModel, setSelectedModel] = useState<string>();
  const [useWebSearch, setUseWebSearch] = useState<boolean>(false);
  const [text, setText] = useState<string>("");

  const models = useQuery(api.models.availableModels);
  const authors = useQuery(api.authors.listAuthors);
  const chatInfo = useQuery(api.aisdk.GetChat, {
    chatId: chatID as Id<"aisdk_chats">,
  });

  /**
   * AI SDK useChat hook
   */
  const { messages, status, sendMessage, setMessages } = useChat({
    id: chatID,
    transport: new DefaultChatTransport({
      prepareSendMessagesRequest: ({ id, messages, body }) => {
        return {
          body: {
            id,
            message: messages[messages.length - 1],
            webSearch: useWebSearch,
            model: body!.model!
          },
        };
      },
    }),
  });

  /**
   * Track if we've already loaded messages to avoid re-syncing
   */
  const hasLoadedMessages = useRef(false);

  /**
   * Sync messages from chatInfo when it loads
   */
  useEffect(() => {
    if (
      chatInfo &&
      typeof chatInfo !== "string" &&
      chatInfo.messages &&
      !hasLoadedMessages.current &&
      !chatInfo.activeStream
    ) {
      setMessages(chatInfo.messages as any);
      if (chatInfo.messages_queue) {
        console.log(chatInfo.messages_queue.model);
        setSelectedModel(chatInfo.messages_queue.model);
        sendMessage(
          {
            text: chatInfo.messages_queue.text,
            files: chatInfo.messages_queue.files as any,
          },
          {
            body: {
              model: chatInfo.messages_queue.model,
              webSearch: chatInfo.messages_queue.webSearch,
            },
          }
        );
      } else {
        const lastMessageModel = chatInfo.messages.at(-1)?.metadata?.model;
        if (lastMessageModel)
          setSelectedModel(
            models?.find((m) => m.slug === lastMessageModel)?.slug
          );
      }
      hasLoadedMessages.current = true;
    }
  }, [chatInfo, setMessages, models, sendMessage]);

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }
    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files: message.files,
      },
      {
        body: {
          model: models?.find((m) => m._id === selectedModel)?.slug,
        }
      }
    );
    setText("");
  };

  return (
    <main className="mx-auto w-full flex-1 max-w-7xl flex flex-col h-full bg-bg-100">
      {/* Conversation Area */}
      <Conversation className="flex-1 overflow-hidden">
        <ConversationContent className="px-4 md:px-8 lg:px-14 3xl:px-20 max-w-4xl mx-auto w-full">
          {messages.map((message, messageIndex) => (
            <div key={message.id || `msg-${messageIndex}`}>
              {message.parts.map((part, partIndex) => {
                switch (part.type) {
                  case "text":
                    return (
                      <Message
                        from={message.role}
                        key={`${message.id}-${partIndex}`}
                      >
                        <MessageContent>
                          <MessageResponse>{part.text}</MessageResponse>
                        </MessageContent>
                      </Message>
                    );
                  case "reasoning":
                    return (
                      <Reasoning
                        key={`${message.id}-${partIndex}`}
                        isStreaming={
                          status === "streaming" &&
                          partIndex === message.parts.length - 1 &&
                          message.id === messages.at(-1)?.id
                        }
                        duration={(part as any).duration}
                      >
                        <ReasoningTrigger />
                        <ReasoningContent>{part.text}</ReasoningContent>
                      </Reasoning>
                    );
                  default:
                    return null;
                }
              })}
            </div>
          ))}
          {status === "submitted" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader size={16} />
              <span className="text-sm">Thinking...</span>
            </div>
          )}
          {chatInfo && typeof chatInfo !== "string" && chatInfo.activeStream && status === "ready" && (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400">
              <AlertCircle className="size-5 shrink-0" />
              <span className="text-sm">
                A response is currently being generated in another session. Please wait for it to complete.
              </span>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Chat Input */}
      <div className="shrink-0 px-4 md:px-8 lg:px-14 3xl:px-20 pb-4 max-w-4xl mx-auto w-full">
        <ChatroomPromptInput
          models={models}
          authors={authors}
          chatStatus={status}
          handleSubmit={handleSubmit}
          StateUseWebSearch={[useWebSearch, setUseWebSearch]}
          StateSelectedModel={[selectedModel, setSelectedModel]}
          StateText={[text, setText]}
          activeStream={chatInfo && typeof chatInfo !== "string" ? chatInfo.activeStream : false}
        />
      </div>
    </main>
  );
}
