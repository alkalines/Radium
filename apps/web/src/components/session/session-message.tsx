import { memo, useState, type ReactNode } from "react";
import type { ToolUIPart, UIMessage } from "ai";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { BrainIcon } from "lucide-react";

import type { RunState } from "@/components/agentic/agent-status";
import { Markdown } from "@/components/markdown";
import type { ModelOption } from "@/components/models/model-options";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { variants } from "@/lib/motion";
import { DeniedMarker } from "./approval-gate";
import { MessageActions } from "./message-actions";
import { AcpNotice } from "./acp/notice";
import { isAcpNoticePart, isAcpToolPart, type AcpToolPart } from "./acp/parts";
import {
  getMessageModel,
  getMessageText,
  getPerformanceMetadata,
  isToolPart,
} from "./message-parts";
import { getToolRunState, hasRenderableAssistantContent, isDeniedTool } from "./tool-parts";
import { ToolStep, traceStatusFor } from "./tool-step";

/**
 * Reveal pattern (`docs/Interface_Design.md` §7.3) for one message or step: content that arrives
 * while the reader watches enters with `variants.reveal`; content present when its parent mounted
 * renders in place and never re-animates.
 */
export function Reveal({ isNew, children }: { isNew: boolean; children: ReactNode }) {
  return (
    <m.div variants={variants.reveal} initial={isNew ? "hidden" : false} animate="visible">
      {children}
    </m.div>
  );
}

type MessagePart = UIMessage["parts"][number];
type IndexedPart = { index: number; part: MessagePart };

/** Text and other content render on their own; adjacent reasoning and tool calls form one Trace. */
type MessageBlock =
  | { type: "content"; item: IndexedPart }
  | { type: "steps"; items: IndexedPart[] };

function groupMessageParts(parts: MessagePart[]) {
  const blocks: MessageBlock[] = [];

  for (const [index, part] of parts.entries()) {
    if (part.type === "step-start") continue;
    // Metadata-only reasoning carries continuation state but has no visible trace.
    if (part.type === "reasoning" && !part.text.trim()) continue;

    if (part.type === "reasoning" || isAcpToolPart(part) || isToolPart(part)) {
      const previous = blocks.at(-1);
      if (previous?.type === "steps") {
        previous.items.push({ index, part });
      } else {
        blocks.push({ type: "steps", items: [{ index, part }] });
      }
      continue;
    }

    blocks.push({ type: "content", item: { index, part } });
  }

  return blocks;
}

export type SessionMessageProps = {
  message: UIMessage;
  /** The chat request in flight is writing this message. */
  isLive: boolean;
  /** A request is in flight, so turn actions other than copy are unavailable. */
  actionsDisabled: boolean;
  showChainOfThought: boolean;
  forkModels: ModelOption[] | undefined;
  /** Name of the agent that answers this Session's turns, shown in the assistant footer. */
  agentName: string;
  modelLabel?: string;
  forkWithoutModel?: boolean;
  canRevert?: boolean;
  onCopy: (message: UIMessage) => void;
  onRevert?: (message: UIMessage) => void;
  onRegenerate?: (message: UIMessage) => void;
  onFork?: (message: UIMessage, modelSlug: string) => void;
};

/**
 * One turn of a Session. User turns are a secondary Bubble at the end of the column; assistant
 * turns are unboxed Markdown with Trace steps for reasoning and tool calls, a denial Marker after
 * a rejected call (pending approvals take the Composer's place instead), and footer actions once
 * the turn is complete.
 *
 * Memoized: the Session passes stable callbacks, so finished turns skip re-rendering when only
 * the Tab's focus or the live turn changes.
 */
export const SessionMessage = memo(function SessionMessage(props: SessionMessageProps) {
  const { message, isLive } = props;
  const showActions = !isLive && message.role !== "system";

  if (message.role === "user") {
    const text = getMessageText(message);

    return (
      <Message align="end">
        <MessageContent className="gap-2">
          {text ? (
            <Bubble variant="secondary" align="end">
              <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
            </Bubble>
          ) : null}
          {showActions ? (
            <MessageActions
              role="user"
              forkModels={props.forkModels}
              forkWithoutModel={props.forkWithoutModel}
              disabled={props.actionsDisabled}
              onCopy={() => props.onCopy(message)}
              onRevert={
                props.canRevert && props.onRevert ? () => props.onRevert?.(message) : undefined
              }
              onFork={props.onFork ? (modelSlug) => props.onFork?.(message, modelSlug) : undefined}
            />
          ) : null}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message>
      <MessageContent className="gap-4">
        <AssistantParts {...props} />
        {showActions ? (
          <MessageActions
            role="assistant"
            forkModels={props.forkModels}
            disabled={props.actionsDisabled}
            forkWithoutModel={props.forkWithoutModel}
            agentName={props.agentName}
            model={getMessageModel(message)}
            modelLabel={props.modelLabel}
            performance={getPerformanceMetadata(message.metadata)}
            onCopy={() => props.onCopy(message)}
            onRegenerate={props.onRegenerate ? () => props.onRegenerate?.(message) : undefined}
            onFork={props.onFork ? (modelSlug) => props.onFork?.(message, modelSlug) : undefined}
          />
        ) : null}
      </MessageContent>
    </Message>
  );
});

function AssistantParts({ message, isLive, showChainOfThought }: SessionMessageProps) {
  // Parts that exist when the message mounts are history (or covered by the message's own
  // reveal); only parts appended afterwards, such as steps after an approval, reveal.
  const [mountedPartCount] = useState(message.parts.length);
  const blocks = groupMessageParts(message.parts);
  const lastTextIndex = message.parts.findLastIndex((part) => part.type === "text");

  return blocks.map((block, blockIndex) => {
    if (block.type === "content") {
      const { index, part } = block.item;
      if (isAcpNoticePart(part)) {
        return (
          <Reveal key={`${message.id}-${index}`} isNew={index >= mountedPartCount}>
            <AcpNotice notice={part.data} />
          </Reveal>
        );
      }
      if (part.type !== "text") return null;

      return (
        <Reveal key={`${message.id}-${index}`} isNew={index >= mountedPartCount}>
          <Markdown isAnimating={isLive && index === lastTextIndex}>{part.text}</Markdown>
        </Reveal>
      );
    }

    const firstIndex = block.items[0]?.index ?? 0;
    const isLastBlock = blockIndex === blocks.length - 1;
    const steps = block.items.map(({ index, part }) => (
      <Reveal
        key={`${message.id}-${index}`}
        // A new chain of thought reveals as a whole; its first step must not reveal again inside it.
        isNew={index >= mountedPartCount && !(showChainOfThought && index === firstIndex)}
      >
        <MessageStep
          part={part}
          isLive={isLive}
          isGrouped={showChainOfThought}
          hasLaterContent={message.parts.slice(index + 1).some(hasRenderableAssistantContent)}
        />
      </Reveal>
    ));
    const tools = block.items.flatMap(({ part }) =>
      isAcpToolPart(part) || isToolPart(part) ? [part] : [],
    );

    return (
      <div key={`${message.id}-steps-${firstIndex}`} className="flex min-w-0 flex-col gap-3">
        {showChainOfThought ? (
          <ChainOfThought
            items={block.items}
            isRunning={isLive && isLastBlock}
            isLive={isLive}
            isNew={firstIndex >= mountedPartCount}
          >
            {steps}
          </ChainOfThought>
        ) : (
          <Trace>{steps}</Trace>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {tools.map(deniedSlot)}
        </AnimatePresence>
      </div>
    );
  });
}

/**
 * Swap pattern for one tool call: a denial shows an outcome Marker. A plain function, not a
 * component, because `AnimatePresence` must see the keyed motion elements (or their absence) as
 * its direct children to run exits and measure for `popLayout`.
 */
function deniedSlot(part: ToolUIPart | AcpToolPart) {
  if (isAcpToolPart(part) || !isDeniedTool(part)) return null;

  return (
    <m.div
      key={`denied-${part.toolCallId}`}
      variants={variants.swap}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <DeniedMarker part={part} />
    </m.div>
  );
}

/** One reasoning or tool step; inside a chain of thought, reasoning is plain text under the summary. */
function MessageStep({
  part,
  isLive,
  isGrouped,
  hasLaterContent,
}: {
  part: MessagePart;
  isLive: boolean;
  isGrouped: boolean;
  hasLaterContent: boolean;
}) {
  if (part.type === "reasoning") {
    const isStreaming = isLive && part.state === "streaming";
    const metadata = part.providerMetadata;
    const isSummary =
      metadata?.radium?.reasoningType === "summary" || metadata?.openai !== undefined;
    const heading = isSummary
      ? /^(?:#{1,6}\s+([^\n]+)|\*\*([^*\n]+)\*\*)/.exec(part.text.trim())
      : null;
    const title = heading?.[1] ?? heading?.[2];

    if (isGrouped) {
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            {isSummary ? "Reasoning summary" : "Visible reasoning"}
            {title ? `: ${title}` : ""}
          </span>
          <Markdown isAnimating={isStreaming} className="text-[13px]">
            {part.text}
          </Markdown>
        </div>
      );
    }

    return (
      <ReasoningStep
        text={part.text}
        isStreaming={isStreaming}
        isSummary={isSummary}
        title={title}
      />
    );
  }

  if (isAcpToolPart(part) || isToolPart(part)) {
    return <ToolStep part={part} isLive={isLive} hasLaterContent={hasLaterContent} />;
  }

  return null;
}

/** Reasoning as a Trace step: open while the model thinks, collapsed once it is done. */
function ReasoningStep({
  text,
  isStreaming,
  isSummary,
  title,
}: {
  text: string;
  isStreaming: boolean;
  isSummary: boolean;
  title?: string;
}) {
  const [userOpen, setUserOpen] = useState<boolean>();
  const state: RunState = isStreaming ? "thinking" : "succeeded";

  return (
    <TraceCollapsible open={userOpen ?? isStreaming} onOpenChange={setUserOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={traceStatusFor(state)}>
          <TraceIcon>
            <BrainIcon />
          </TraceIcon>
          <TraceTitle>
            {isSummary ? "Reasoning summary" : isStreaming ? "Thinking" : "Visible reasoning"}
            {title ? `: ${title}` : ""}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Markdown isAnimating={isStreaming} className="text-[13px]">
          {text}
        </Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * Chain of thought (workspace setting): adjacent reasoning and tool steps collapse under one
 * summary line that stays open while the run works or waits for approval, then folds away
 * unless the reader toggled it.
 */
function ChainOfThought({
  items,
  isRunning,
  isLive,
  isNew,
  children,
}: {
  items: IndexedPart[];
  /** The live request is still producing this block (nothing follows it yet). */
  isRunning: boolean;
  isLive: boolean;
  isNew: boolean;
  children: ReactNode;
}) {
  const [userOpen, setUserOpen] = useState<boolean>();
  const tools = items.flatMap(({ part }) =>
    isAcpToolPart(part) || isToolPart(part) ? [part] : [],
  );
  const isAwaiting = tools.some((part) => getToolRunState(part, isLive) === "awaiting");
  const failedCount = tools.filter((part) => getToolRunState(part, isLive) === "failed").length;

  let state: RunState = "succeeded";
  if (failedCount > 0) state = "failed";
  if (isAwaiting) state = "awaiting";
  if (isRunning && !isAwaiting) state = "thinking";

  let title = `Worked through ${items.length} ${items.length === 1 ? "step" : "steps"}`;
  if (tools.length === 0) title = "Thought";
  if (failedCount > 0) title = `${title}, ${failedCount} failed`;
  if (isAwaiting) title = "Waiting for your answer";
  if (state === "thinking") title = "Thinking";

  return (
    <Trace>
      <Reveal isNew={isNew}>
        <TraceCollapsible open={userOpen ?? (isRunning || isAwaiting)} onOpenChange={setUserOpen}>
          <TraceCollapsibleTrigger>
            <TraceLine status={traceStatusFor(state)}>
              <TraceIcon>
                <BrainIcon />
              </TraceIcon>
              <TraceTitle>{title}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <Trace>{children}</Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Reveal>
    </Trace>
  );
}
