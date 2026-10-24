import { useEffect, useState, type ComponentProps } from "react";
import { CheckIcon, CopyIcon, GitBranchIcon, PencilIcon, RefreshCcwIcon } from "lucide-react";

import type { ModelOption } from "@/components/models/model-options";
import { ModelList } from "@/components/models/model-list";
import { useModelPreferences } from "@/components/models/model-preferences";
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
 * Footer under one turn (shadcn Message pattern). User turns: fork with another model, edit
 * (when `onEdit` is given), copy. Assistant turns: retry, copy, fork, then the generation
 * performance. Actions reveal on hover or focus; `disabled` (a request is in flight) blocks
 * everything except copy. Fork opens a model list (the user's pinned models first, hidden ones
 * left out) and hands the chosen slug to `onFork`; the caller decides what forking a user versus
 * an assistant turn means.
 */
export function MessageActions({
  role,
  forkModels,
  disabled,
  performance,
  onCopy,
  onEdit,
  onRetry,
  onFork,
}: {
  role: "user" | "assistant";
  forkModels: ModelOption[] | undefined;
  disabled: boolean;
  performance?: MessagePerformance;
  onCopy: () => void;
  onEdit?: () => void;
  onRetry?: () => void;
  onFork: (modelSlug: string) => void;
}) {
  const [isCopied, setIsCopied] = useState(false);
  const [isForkOpen, setIsForkOpen] = useState(false);
  const { pinnedModels, hiddenModels } = useModelPreferences();
  const isUser = role === "user";

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

  const forkAction = (
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

  return (
    <MessageFooter className="gap-2 px-0">
      {performance ? (
        <span className="flex items-center gap-2 font-normal tabular-nums">
          <span title={`Average across ${performance.requestCount} API requests`}>
            {formatTps(performance.averageTps)} tokens/s
          </span>
          <span aria-hidden="true">·</span>
          <span title="Total generation time">{formatDuration(performance.generationTimeMs)}</span>
        </span>
      ) : null}
      <div className="flex items-center opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
        {isUser ? (
          <>
            {forkAction}
            {onEdit ? (
              <MessageAction label="Edit" disabled={disabled} onClick={onEdit}>
                <PencilIcon />
              </MessageAction>
            ) : null}
            {copyAction}
          </>
        ) : (
          <>
            {onRetry ? (
              <MessageAction label="Retry" disabled={disabled} onClick={onRetry}>
                <RefreshCcwIcon />
              </MessageAction>
            ) : null}
            {copyAction}
            {forkAction}
          </>
        )}
      </div>
    </MessageFooter>
  );
}

function formatTps(value: number) {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
