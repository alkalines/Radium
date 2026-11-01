import { useEffect, useState } from "react";
import type { ChatInterruption } from "backend/src/chatroom/interruption";
import { CheckIcon, CirclePauseIcon, CircleXIcon, CopyIcon, RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/**
 * A turn that stopped before its reply finished, detached above the prompt slot: what happened,
 * then `Retry` (F5), `Copy error` for failures, and `Switch model`. Retry continues the turn from
 * its last completed step; it does not start the reply over (the turn's Regenerate action does).
 *
 * With `shortcutsEnabled` (the visible Tab) and `canRetry`, a plain F5 retries instead of
 * reloading the page; Ctrl/⌘/Shift+F5 still reload.
 */
export function RunInterruptionCard({
  interruption,
  canRetry,
  shortcutsEnabled,
  onRetry,
  onSwitchModel,
}: {
  interruption: ChatInterruption;
  canRetry: boolean;
  shortcutsEnabled: boolean;
  onRetry: () => void;
  onSwitchModel: () => void;
}) {
  const [isCopied, setIsCopied] = useState(false);
  const isFailed = interruption.kind === "failed";
  const Icon = isFailed ? CircleXIcon : CirclePauseIcon;
  const isStepLimit = interruption.kind === "step_limit";
  let title = "Interrupted";
  let detail =
    "The reply stopped before it finished. Retry continues from its last completed step.";
  if (isFailed) {
    title = "Request failed";
    detail = interruption.message ?? "The request ended with an error before the reply finished.";
  } else if (isStepLimit) {
    title = "Paused at the step limit";
    detail =
      "The model was still working when this request reached its step limit. Continue picks up from its last completed step.";
  }

  useEffect(() => {
    if (!isCopied) return;

    const timeout = setTimeout(() => setIsCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [isCopied]);

  useEffect(() => {
    if (!shortcutsEnabled || !canRetry) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "F5" || event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onRetry();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canRetry, onRetry, shortcutsEnabled]);

  function copyError() {
    void navigator.clipboard?.writeText(detail);
    setIsCopied(true);
  }

  return (
    <div
      role="status"
      data-state={isFailed ? "failed" : "cancelled"}
      className="flex items-start gap-2.5 rounded-2xl border border-border bg-card p-3 pb-2"
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          isFailed ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn("text-sm font-medium", isFailed && "text-destructive")}>{title}</p>
        <p className="max-h-24 overflow-y-auto text-[13px] break-words text-muted-foreground">
          {detail}
        </p>
        <div className="-ml-2 flex flex-wrap items-center gap-1 pt-1.5">
          <Button variant="outline" size="sm" disabled={!canRetry} onClick={onRetry}>
            <RotateCwIcon data-icon="inline-start" />
            {isStepLimit ? "Continue" : "Retry"} {shortcutsEnabled ? <Kbd>F5</Kbd> : null}
          </Button>
          {isFailed ? (
            <Button variant="ghost" size="sm" onClick={copyError}>
              {isCopied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {isCopied ? "Copied" : "Copy error"}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onSwitchModel}>
            Switch model
          </Button>
        </div>
      </div>
    </div>
  );
}
