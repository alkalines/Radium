import { useState } from "react";
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
import type { ApprovalResponse } from "./approval-gate";
import { isToolPart } from "./message-parts";
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
 * while `messages` is still empty (between creating the chat and the first send). `isActive`
 * gives the visible Tab's first pending approval the ⌘/Ctrl+Enter and Esc shortcuts.
 */
export function SessionThread({
  messages,
  status,
  isActive,
  pendingPrompt,
  showChainOfThought,
  forkModels,
  editingId,
  canEdit,
  onApprovalResponse,
  onCopy,
  onEditStart,
  onEditCancel,
  onEditSubmit,
  onRetry,
  onFork,
}: {
  messages: UIMessage[];
  status: ChatStatus;
  isActive: boolean;
  pendingPrompt?: string;
  showChainOfThought: boolean;
  forkModels?: ModelOption[];
  editingId: string | null;
  canEdit: boolean;
  onApprovalResponse: (response: ApprovalResponse) => void;
  onCopy: (message: UIMessage) => void;
  onEditStart: (message: UIMessage) => void;
  onEditCancel: () => void;
  onEditSubmit: (message: UIMessage, text: string) => void;
  onRetry: (message: UIMessage) => void;
  onFork: (message: UIMessage, modelSlug: string) => void;
}) {
  // Snapshot of the turns the thread opened with. Taken during render (React's "adjust state
  // while rendering" pattern) so the very first paint of history is already static.
  const [loadedMessageIds, setLoadedMessageIds] = useState<ReadonlySet<string> | null>(null);
  if (loadedMessageIds === null && messages.length > 0) {
    setLoadedMessageIds(new Set(messages.map((message) => message.id)));
  }

  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const showPendingPrompt = messages.length === 0 && pendingPrompt !== undefined;
  const isWaitingForReply =
    showPendingPrompt || (status === "submitted" && lastMessage?.role === "user");
  const shortcutApprovalId = isActive ? getFirstPendingApprovalId(lastMessage) : undefined;

  if (messages.length === 0 && !showPendingPrompt) {
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
                      isEditing={editingId === message.id}
                      canEdit={canEdit}
                      shortcutApprovalId={isLast ? shortcutApprovalId : undefined}
                      onApprovalResponse={onApprovalResponse}
                      onCopy={onCopy}
                      onEditStart={onEditStart}
                      onEditCancel={onEditCancel}
                      onEditSubmit={onEditSubmit}
                      onRetry={onRetry}
                      onFork={onFork}
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

/** The first tool call in the last turn that waits for approval; it owns the keyboard shortcuts. */
function getFirstPendingApprovalId(message: UIMessage | undefined) {
  if (message?.role !== "assistant") return undefined;

  for (const part of message.parts) {
    if (isToolPart(part) && part.state === "approval-requested") {
      return part.approval.id;
    }
  }

  return undefined;
}
