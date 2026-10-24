import { useEffect } from "react";
import { getToolName, type ToolUIPart } from "ai";
import { ShieldAlertIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { ToolInputBlock } from "./tool-code";
import { getToolKind, type ToolKind } from "./tool-parts";

/** The answer `useChat().addToolApprovalResponse` expects for one approval request. */
export type ApprovalResponse = { id: string; approved: boolean; reason?: string };

const gateCopy: Record<ToolKind, { title: string; description: string }> = {
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
  other: { title: "Allow this tool call?", description: "The tool runs after you approve it." },
};

const deniedCopy: Record<ToolKind, string> = {
  bash: "Denied. No command was executed.",
  edit: "Denied. No files were changed.",
  create: "Denied. No file was created.",
  read: "Denied. Nothing was read.",
  "web-search": "Denied. Nothing was searched.",
  other: "Denied. The tool did not run.",
};

// Keyboard shortcuts belong to the gate, not to an open menu, dialog, or picker list that the
// same keys would close or select in.
const overlaySelector =
  "[role=dialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]";

/**
 * Execution approval for one tool call in `approval-requested`: what will run, then Deny / Allow
 * once. This is the only surface allowed a colored (`awaiting`) border. With `shortcutsEnabled`
 * (the visible Tab's first pending approval), ⌘/Ctrl+Enter allows and Esc denies unless another
 * handler already consumed the key.
 */
export function ApprovalGate({
  part,
  shortcutsEnabled,
  onApprovalResponse,
}: {
  part: ToolUIPart & { state: "approval-requested" };
  shortcutsEnabled: boolean;
  onApprovalResponse: (response: ApprovalResponse) => void;
}) {
  const approvalId = part.approval.id;
  const kind = getToolKind(part);
  const copy = gateCopy[kind];
  const title =
    kind === "other" ? `Allow ${getToolName(part).replaceAll(/[_-]/g, " ")}?` : copy.title;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

  useEffect(() => {
    if (!shortcutsEnabled) return;

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
  }, [approvalId, onApprovalResponse, shortcutsEnabled]);

  return (
    <div
      data-state="awaiting"
      className="flex flex-col gap-3 rounded-lg border border-signal-awaiting/30 bg-card p-3"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-signal-awaiting" />
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[13px] text-muted-foreground">
            {part.approval.requestReason ?? copy.description}
          </p>
        </div>
      </div>
      <ToolInputBlock part={part} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onApprovalResponse({ id: approvalId, approved: false })}
        >
          Deny {shortcutsEnabled ? <Kbd>Esc</Kbd> : null}
        </Button>
        <Button size="sm" onClick={() => onApprovalResponse({ id: approvalId, approved: true })}>
          Allow once {shortcutsEnabled ? <Kbd>{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd> : null}
        </Button>
      </div>
    </div>
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
