import { type SyntheticEvent, useEffect, useState } from "react";
import { getToolName, type ToolUIPart } from "ai";
import { MessageSquareXIcon, ShieldAlertIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Textarea } from "@/components/ui/textarea";
import { ToolInputBlock } from "./tool-code";
import { getToolKind, type ToolKind } from "./tool-parts";

/** The answer `useChat().addToolApprovalResponse` expects for one approval request. */
export type ApprovalResponse = { id: string; approved: boolean; reason?: string };

const gateCopy: Record<ToolKind, { title: string; description: string }> = {
  code: {
    title: "Allow this code?",
    description: "The program runs using this chat's tools.",
  },
  bash: {
    title: "Allow this command on the Worker?",
    description:
      "It runs with the Worker's OS permissions. The working directory is not a sandbox.",
  },
  edit: {
    title: "Allow these edits on the Worker?",
    description: "The patch is staged and applied to files in the Worker directory.",
  },
  create: {
    title: "Allow creating this file on the Worker?",
    description: "The file is written to the Worker directory.",
  },
  read: {
    title: "Allow this read on the Worker?",
    description: "The file is read from the Worker directory.",
  },
  "web-search": {
    title: "Allow this web search?",
    description: "The query is sent to the search provider.",
  },
  question: { title: "Allow these questions?", description: "You answer them next." },
  todo: {
    title: "Allow updating the todo list?",
    description: "The list above the prompt changes.",
  },
  other: { title: "Allow this tool call?", description: "The tool runs after you approve it." },
};

const deniedCopy: Record<ToolKind, string> = {
  code: "Denied. No code was run.",
  bash: "Denied. No command was executed.",
  edit: "Denied. No files were changed.",
  create: "Denied. No file was created.",
  read: "Denied. Nothing was read.",
  "web-search": "Denied. Nothing was searched.",
  question: "Denied. No questions were asked.",
  todo: "Denied. The todo list did not change.",
  other: "Denied. The tool did not run.",
};

// Keyboard shortcuts belong to the prompt, not to an open menu, dialog, or picker list that the
// same keys would close or select in.
const overlaySelector =
  "[role=dialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]";

/**
 * Execution approval for one tool call in `approval-requested`. It temporarily takes the
 * Composer's place and shape (`rounded-2xl` card at the bottom of the Session): what will run,
 * then `Reject with reason`, `Reject`, and `Approve`. Rejecting with a reason swaps the toolbar
 * for a text field whose reason goes back to the agent with the denial. This is the only surface
 * allowed a colored (`awaiting`) border.
 *
 * `total` is how many calls of the turn wait; they are answered one at a time, first to last.
 * With `shortcutsEnabled` (the visible Tab), ⌘/Ctrl+Enter approves and Esc rejects unless another
 * handler already consumed the key; while a reason is typed, Enter sends it and Esc goes back.
 * `expiresAt` (Code Mode calls) shows the time left before the call is refused automatically.
 */
export function ApprovalPrompt({
  part,
  total,
  shortcutsEnabled,
  expiresAt,
  onApprovalResponse,
}: {
  part: ToolUIPart & { state: "approval-requested" };
  total: number;
  shortcutsEnabled: boolean;
  expiresAt?: number;
  onApprovalResponse: (response: ApprovalResponse) => void;
}) {
  const [isGivingReason, setIsGivingReason] = useState(false);
  const [reason, setReason] = useState("");
  const approvalId = part.approval.id;
  const kind = getToolKind(part);
  const copy = gateCopy[kind];
  const title =
    kind === "other" ? `Allow ${getToolName(part).replaceAll(/[_-]/g, " ")}?` : copy.title;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

  // The next pending call starts over without a half-typed reason for the previous one.
  const [shownApprovalId, setShownApprovalId] = useState(approvalId);
  if (shownApprovalId !== approvalId) {
    setShownApprovalId(approvalId);
    setIsGivingReason(false);
    setReason("");
  }

  useEffect(() => {
    if (!shortcutsEnabled || isGivingReason) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return;
      if (event.target instanceof Element && event.target.closest(overlaySelector)) return;

      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onApprovalResponse({ id: approvalId, approved: true });
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onApprovalResponse({ id: approvalId, approved: false });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [approvalId, isGivingReason, onApprovalResponse, shortcutsEnabled]);

  function submitReason(event: SyntheticEvent) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    onApprovalResponse({ id: approvalId, approved: false, reason: trimmed });
  }

  return (
    <div
      data-state="awaiting"
      role="group"
      aria-label={title}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-signal-awaiting/40 bg-card group-data-[tray=attached]/prompt-slot:rounded-t-none"
    >
      <div className="flex max-h-[min(24rem,50svh)] flex-col gap-3 overflow-y-auto p-3">
        <div className="flex items-start gap-2.5 px-1">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-signal-awaiting" />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-[13px] text-muted-foreground">
              {part.approval.requestReason ?? copy.description}
            </p>
          </div>
          {expiresAt !== undefined ? (
            <ExpiryCountdown expiresAt={expiresAt} outcome="Rejects" />
          ) : null}
          {total > 1 ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              1 of {total}
            </span>
          ) : null}
        </div>
        <ToolInputBlock part={part} />
      </div>

      {isGivingReason ? (
        <form onSubmit={submitReason} className="flex flex-col border-t border-border">
          <label htmlFor={`reject-reason-${approvalId}`} className="sr-only">
            Reason for rejecting
          </label>
          <Textarea
            id={`reject-reason-${approvalId}`}
            autoFocus
            value={reason}
            placeholder="Tell the agent what to do instead…"
            className="max-h-32 min-h-14 resize-none rounded-none border-0 bg-transparent px-4 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Esc leaves the reason; it must not also reject through the window shortcut.
                event.preventDefault();
                setIsGivingReason(false);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                submitReason(event);
              }
            }}
          />
          <div className="flex items-center justify-end gap-2 px-2 pb-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setIsGivingReason(false)}
            >
              Back <Kbd>Esc</Kbd>
            </Button>
            <Button type="submit" variant="destructive" size="sm" disabled={!reason.trim()}>
              <MessageSquareXIcon data-icon="inline-start" />
              Reject with reason <Kbd>↵</Kbd>
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-2">
          <Button variant="ghost" size="sm" onClick={() => setIsGivingReason(true)}>
            <MessageSquareXIcon data-icon="inline-start" />
            Reject with reason
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onApprovalResponse({ id: approvalId, approved: false })}
            >
              Reject {shortcutsEnabled ? <Kbd>Esc</Kbd> : null}
            </Button>
            <Button
              size="sm"
              onClick={() => onApprovalResponse({ id: approvalId, approved: true })}
            >
              Approve {shortcutsEnabled ? <Kbd>{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd> : null}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Time left before an unanswered Code Mode prompt is refused by the server, e.g. "Rejects in
 * 2:59". The deadline is the server's; local clock skew only shifts the displayed time.
 */
export function ExpiryCountdown({ expiresAt, outcome }: { expiresAt: number; outcome: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {outcome} in {clock}
    </span>
  );
}

/** The outcome that replaces an Approval gate the user denied. */
export function DeniedMarker({ part }: { part: ToolUIPart }) {
  return (
    <Marker className="text-xs">
      <XIcon />
      <MarkerContent>{deniedCopy[getToolKind(part)]}</MarkerContent>
    </Marker>
  );
}
