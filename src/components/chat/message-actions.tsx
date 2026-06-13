"use client";

import { CheckIcon, CopyIcon, GitBranchIcon, PencilIcon, RefreshCcwIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { MessageAction, MessageActions } from "@/components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector";
import { cn } from "@/lib/utils";

/** Minimal model shape needed to render the fork picker. */
export type ForkPickerModel = {
  slug: string;
  name: string;
  author: { name: string; slug: string } | null;
};

const COPIED_RESET_MS = 1500;

type ChatMessageActionsProps = {
  role: "system" | "user" | "assistant";
  models: ForkPickerModel[] | undefined;
  /** Whether actions can run (false while a message is streaming). */
  disabled?: boolean;
  /** Copies the message text to the clipboard. */
  onCopy: () => void;
  /** Regenerates the assistant message (assistant only). */
  onRetry?: () => void;
  /** Enters inline edit mode for the message (user only). */
  onEdit?: () => void;
  /** Forks the conversation at this message using the chosen model. */
  onFork: (model: string) => void;
};

/**
 * Hover-revealed action bar shown beneath a chat message. Assistant messages get
 * Retry / Copy / Fork; user messages get Fork / Edit / Copy. "Fork" opens a model
 * picker and hands the chosen model slug back to the parent, which decides the
 * fork semantics (continue vs. regenerate).
 */
export function ChatMessageActions({
  role,
  models,
  disabled,
  onCopy,
  onRetry,
  onEdit,
  onFork,
}: ChatMessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const isUser = role === "user";

  const handleCopy = useCallback(() => {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [onCopy]);

  const handleForkSelect = useCallback(
    (model: string) => {
      setForkOpen(false);
      onFork(model);
    },
    [onFork],
  );

  const copyButton = (
    <MessageAction onClick={handleCopy} tooltip="Copy">
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );

  const forkButton = (
    <MessageAction
      disabled={disabled || !models?.length}
      onClick={() => setForkOpen(true)}
      tooltip={isUser ? "Fork with another model" : "Fork into a new chat"}
    >
      <GitBranchIcon className="size-3.5" />
    </MessageAction>
  );

  return (
    <>
      <MessageActions
        className={cn(
          "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
          isUser && "justify-end",
        )}
      >
        {isUser ? (
          <>
            {forkButton}
            <MessageAction disabled={disabled} onClick={onEdit} tooltip="Edit">
              <PencilIcon className="size-3.5" />
            </MessageAction>
            {copyButton}
          </>
        ) : (
          <>
            <MessageAction disabled={disabled} onClick={onRetry} tooltip="Retry">
              <RefreshCcwIcon className="size-3.5" />
            </MessageAction>
            {copyButton}
            {forkButton}
          </>
        )}
      </MessageActions>

      <ForkModelDialog
        models={models}
        onOpenChange={setForkOpen}
        onSelect={handleForkSelect}
        open={forkOpen}
      />
    </>
  );
}

type ForkModelDialogProps = {
  models: ForkPickerModel[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (model: string) => void;
};

function ForkModelDialog({ models, open, onOpenChange, onSelect }: ForkModelDialogProps) {
  return (
    <ModelSelector onOpenChange={onOpenChange} open={open}>
      <ModelSelectorContent
        className="[&_[data-slot=dialog-close]]:right-2 [&_[data-slot=dialog-close]]:top-2"
        title="Fork with model"
      >
        <div className="pr-12">
          <ModelSelectorInput placeholder="Pick a model to fork with..." />
        </div>
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Models">
            {models?.map((model) => (
              <ModelSelectorItem
                key={model.slug}
                keywords={[model.name, model.author?.name ?? "", model.author?.slug ?? ""]}
                onSelect={() => onSelect(model.slug)}
                value={model.slug}
              >
                {model.author ? (
                  <img
                    alt={`${model.author.name} logo`}
                    className="size-5 shrink-0 rounded-full bg-white p-0.5 ring-1 ring-border/70"
                    height={16}
                    src={`https://models.dev/logos/labs/${model.author.slug}.svg`}
                    width={16}
                  />
                ) : null}
                <ModelSelectorName>
                  {model.author ? `${model.author.name}: ${model.name}` : model.name}
                </ModelSelectorName>
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
