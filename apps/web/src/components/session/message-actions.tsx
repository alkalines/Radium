import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type FocusEvent,
} from "react";
import * as m from "motion/react-m";
import { CheckIcon, CopyIcon, GitBranchIcon, RefreshCcwIcon, Undo2Icon } from "lucide-react";

import { modelDisplayName, type ModelOption } from "@/components/models/model-options";
import { ModelList } from "@/components/models/model-list";
import { useModelPreferences } from "@/components/models/model-preferences";
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { spring, transitions } from "@/lib/motion";
import type { MessagePerformance } from "./message-parts";

function MessageAction({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Footer under one turn (shadcn Message pattern). User turns: fork with another model, revert
 * (when `onRevert` is given), copy; they reveal on hover or focus. Assistant turns: regenerate, copy,
 * fork, then who answered (the agent name, then the model as `Lab: Model`) and the generation
 * performance. The assistant buttons reveal while the pointer is over the turn, keyboard focus is
 * inside the footer, or the fork list is open (always on touch); hidden, they leave the flow and
 * the details slide into their place. `disabled` (a request is in flight) blocks everything except
 * copy. Fork opens a model list (the user's pinned models first, hidden ones left out) and hands
 * the chosen slug to `onFork`; the caller decides what forking a user versus an assistant turn
 * means.
 */
export function MessageActions({
  role,
  forkModels,
  disabled,
  agentName,
  model,
  modelLabel,
  forkWithoutModel = false,
  performance,
  onCopy,
  onRevert,
  onRegenerate,
  onFork,
}: {
  role: "user" | "assistant";
  forkModels: ModelOption[] | undefined;
  disabled: boolean;
  /** The agent that answered an assistant turn (`Radium` or an ACP agent). */
  agentName?: string;
  /** Model ID an assistant turn recorded; named from `forkModels` when the workspace lists it. */
  model?: string;
  /** Agent-advertised choice name, without a Gateway model lookup. */
  modelLabel?: string;
  forkWithoutModel?: boolean;
  performance?: MessagePerformance;
  onCopy: () => void;
  onRevert?: () => void;
  /** Starts the reply over from its user turn (a stopped turn continues from the Session card). */
  onRegenerate?: () => void;
  onFork?: (modelSlug: string) => void;
}) {
  const [isCopied, setIsCopied] = useState(false);
  const [isForkOpen, setIsForkOpen] = useState(false);
  const [isPointerNear, setIsPointerNear] = useState(false);
  const [hasKeyboardFocus, setHasKeyboardFocus] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);
  const isCoarsePointer = useSyncExternalStore(
    subscribeCoarsePointer,
    readCoarsePointer,
    () => false,
  );
  const { pinnedModels, hiddenModels } = useModelPreferences();
  const isUser = role === "user";

  // "Near" is the whole turn: the footer sits under it, so the pointer reaches the turn first.
  // The footer mounts when a streamed turn finishes, often under a pointer that never re-enters.
  useEffect(() => {
    if (isUser) return;
    const turn = footerRef.current?.closest<HTMLElement>('[data-slot="message"]');
    if (!turn) return;

    if (turn.matches(":hover")) setIsPointerNear(true);

    const enter = () => setIsPointerNear(true);
    const leave = () => setIsPointerNear(false);
    turn.addEventListener("pointerenter", enter);
    turn.addEventListener("pointerleave", leave);
    return () => {
      turn.removeEventListener("pointerenter", enter);
      turn.removeEventListener("pointerleave", leave);
    };
  }, [isUser]);

  useEffect(() => {
    if (!isCopied) return;

    const timeout = setTimeout(() => setIsCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [isCopied]);

  const copyAction = (
    <MessageAction
      label={isCopied ? "Copied" : "Copy"}
      onClick={() => {
        onCopy();
        setIsCopied(true);
      }}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  );

  const forkAction = !onFork ? null : forkWithoutModel ? (
    <MessageAction label="Fork into a new session" disabled={disabled} onClick={() => onFork("")}>
      <GitBranchIcon />
    </MessageAction>
  ) : (
    <Popover open={isForkOpen} onOpenChange={setIsForkOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={isUser ? "Fork with another model" : "Fork into a new session"}
              disabled={disabled || !forkModels?.length}
            >
              <GitBranchIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {isUser ? "Fork with another model" : "Fork into a new session"}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align={isUser ? "end" : "start"}
        className="w-[min(calc(100vw-2rem),22rem)] gap-0 overflow-hidden rounded-2xl p-0"
      >
        <ModelList
          models={forkModels ?? []}
          pinnedSlugs={pinnedModels}
          hiddenSlugs={hiddenModels}
          heading="Fork with model"
          placeholder="Pick a model to fork with…"
          onSelect={(model) => {
            setIsForkOpen(false);
            onFork(model.slug);
          }}
        />
      </PopoverContent>
    </Popover>
  );

  if (isUser) {
    return (
      <MessageFooter className="gap-2 px-0">
        <div className="flex items-center opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
          {forkAction}
          {onRevert ? (
            <MessageAction label="Revert to this message" disabled={disabled} onClick={onRevert}>
              <Undo2Icon />
            </MessageAction>
          ) : null}
          {copyAction}
        </div>
      </MessageFooter>
    );
  }

  const modelOption = model ? forkModels?.find((candidate) => candidate.slug === model) : undefined;
  const details = [
    agentName ? <span key="agent">{agentName}</span> : null,
    modelLabel ? (
      <span key="model" className="truncate" title={modelLabel}>
        {modelLabel}
      </span>
    ) : model ? (
      <span key="model" className={modelOption ? "truncate" : "truncate font-mono"} title={model}>
        {modelOption ? modelDisplayName(modelOption) : model}
      </span>
    ) : null,
    performance ? (
      <span
        key="tps"
        className="tabular-nums"
        title={`Average across ${performance.requestCount} API requests`}
      >
        {formatTps(performance.averageTps)} tokens/s
      </span>
    ) : null,
    performance ? (
      <span key="time" className="tabular-nums" title="Total generation time">
        {formatDuration(performance.generationTimeMs)}
      </span>
    ) : null,
  ].filter((detail) => detail !== null);

  const isRevealed = isPointerNear || hasKeyboardFocus || isForkOpen || isCoarsePointer;

  // Mouse clicks focus the buttons too; only keyboard focus should hold them open.
  function handleFocus(event: FocusEvent<HTMLDivElement>) {
    if (event.target.matches(":focus-visible")) setHasKeyboardFocus(true);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setHasKeyboardFocus(false);
  }

  return (
    <MessageFooter
      ref={footerRef}
      className="relative min-h-7 min-w-0 px-0"
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {/* Hidden buttons stay mounted (out of the flow, still focusable) so keyboard users reach
          them; focusing one reveals the row. */}
      <m.div
        initial={false}
        animate={
          isRevealed
            ? { opacity: 1, x: 0, filter: "blur(0px)", transition: transitions.enter }
            : { opacity: 0, x: -4, filter: "blur(2px)", transition: transitions.exit }
        }
        className={
          isRevealed
            ? "flex shrink-0 items-center pr-2"
            : "pointer-events-none absolute inset-y-0 left-0 flex items-center"
        }
      >
        {onRegenerate ? (
          <MessageAction label="Regenerate" disabled={disabled} onClick={onRegenerate}>
            <RefreshCcwIcon />
          </MessageAction>
        ) : null}
        {copyAction}
        {forkAction}
      </m.div>
      {details.length > 0 ? (
        <m.span
          layout="position"
          transition={{ layout: spring.snap }}
          className="flex min-w-0 items-center gap-2 font-normal"
        >
          {details.map((detail, index) => (
            <span key={detail.key} className="flex min-w-0 items-center gap-2">
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              {detail}
            </span>
          ))}
        </m.span>
      ) : null}
    </MessageFooter>
  );
}

const coarsePointerQuery = "(pointer: coarse)";

/** Touch screens have no hover, so the assistant buttons stay visible there. */
function subscribeCoarsePointer(onChange: () => void) {
  const query = window.matchMedia(coarsePointerQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readCoarsePointer() {
  return window.matchMedia(coarsePointerQuery).matches;
}

function formatTps(value: number) {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
