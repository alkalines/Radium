import { useState, type ReactNode } from "react";
import type { ChatStatus, UIMessage } from "ai";
import { MessageCircleDashedIcon } from "lucide-react";

import { AgentStatus } from "@/components/agentic/agent-status";
import type { ModelOption } from "@/components/models/model-options";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Reveal, SessionMessage } from "./session-message";

const PENDING_PROMPT_ID = "pending-prompt";

/**
 * The conversation of one Session Tab: a 760px column of turns in a `MessageScroller` that fills
 * the Panel (`min-h-0 flex-1`). User turns are scroll anchors, so a new prompt settles near the
 * top and the reply streams in below it; `autoScroll` follows the reply only while the reader
 * stays at the live edge, and the scroll button returns there.
 *
 * Turns present when the thread first shows content (history, restored Tabs) render in place;
 * only turns and steps that arrive afterwards reveal. `pendingPrompt` shows the just-sent prompt
 * while `messages` is still empty (between creating the chat and the first send).
 */
export function SessionThread({
  messages,
  status,
  pendingPrompt,
  showChainOfThought,
  forkModels,
  agentName,
  canRevert,
  onCopy,
  onRevert,
  onRegenerate,
  onFork,
  forkLatestOnly = false,
  modelLabel,
  historyControl,
}: {
  messages: UIMessage[];
  status: ChatStatus;
  pendingPrompt?: string;
  showChainOfThought: boolean;
  forkModels?: ModelOption[];
  agentName: string;
  canRevert?: boolean;
  onCopy: (message: UIMessage) => void;
  onRevert?: (message: UIMessage) => void;
  onRegenerate?: (message: UIMessage) => void;
  onFork?: (message: UIMessage, modelSlug: string) => void;
  /** ACP supports only a latest-point fork, without a model picker. */
  forkLatestOnly?: boolean;
  modelLabel?: string;
  /** Lives above the oldest loaded turn, inside the scroll viewport. */
  historyControl?: ReactNode;
}) {
  // Snapshot of the turns the thread opened with. Taken during render (React's "adjust state
  // while rendering" pattern) so the very first paint of history is already static.
  const [loadedMessageIds, setLoadedMessageIds] = useState<ReadonlySet<string> | null>(null);
  if (loadedMessageIds === null && messages.length > 0) {
    setLoadedMessageIds(new Set(messages.map((message) => message.id)));
  }

  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const latestAssistantId = messages.findLast((message) => message.role === "assistant")?.id;
  const showPendingPrompt = pendingPrompt !== undefined;
  const isWaitingForReply =
    showPendingPrompt || (status === "submitted" && lastMessage?.role === "user");

  if (messages.length === 0 && !showPendingPrompt && !historyControl) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageCircleDashedIcon />
          </EmptyMedia>
          <EmptyTitle>No messages yet</EmptyTitle>
          <EmptyDescription>Send a prompt to begin.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={isBusy}
            className="mx-auto w-full max-w-190 gap-6 px-4 py-8"
          >
            {historyControl}
            {showPendingPrompt ? (
              <MessageScrollerItem messageId={PENDING_PROMPT_ID} scrollAnchor>
                <Reveal isNew>
                  <Message align="end">
                    <MessageContent>
                      <Bubble variant="secondary" align="end">
                        <BubbleContent className="whitespace-pre-wrap">
                          {pendingPrompt}
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </Reveal>
              </MessageScrollerItem>
            ) : null}

            {messages.map((message, index) => {
              const isLast = index === messages.length - 1;

              return (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  <Reveal isNew={loadedMessageIds !== null && !loadedMessageIds.has(message.id)}>
                    <SessionMessage
                      message={message}
                      isLive={isBusy && isLast && message.role === "assistant"}
                      actionsDisabled={isBusy}
                      showChainOfThought={showChainOfThought}
                      forkModels={forkModels}
                      agentName={agentName}
                      modelLabel={modelLabel}
                      forkWithoutModel={forkLatestOnly}
                      canRevert={canRevert}
                      onCopy={onCopy}
                      onRevert={onRevert}
                      onRegenerate={onRegenerate}
                      onFork={
                        !forkLatestOnly || message.id === latestAssistantId ? onFork : undefined
                      }
                    />
                  </Reveal>
                </MessageScrollerItem>
              );
            })}

            {isWaitingForReply ? (
              <MessageScrollerItem>
                <Reveal isNew>
                  <AgentStatus state="queued" label="Queued" />
                </Reveal>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
