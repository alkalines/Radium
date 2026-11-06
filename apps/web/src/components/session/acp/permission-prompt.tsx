import { useEffect, useMemo } from "react";
import type { AcpInteractionRequest } from "backend/src/acp/contract";
import { ShieldAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { ApprovalPromptShell, approvalOverlaySelector } from "../approval-gate";
import { acpPermissionContent } from "./tool-content";
import { AcpToolContentBlock } from "./tool-content-block";

/** Agent-owned permission choices, with the built-in approval shell and overlay-safe shortcuts. */
export function AcpPermissionPrompt({
  request,
  index,
  total,
  shortcutsEnabled,
  onAnswer,
}: {
  request: Extract<AcpInteractionRequest, { kind: "permission" }>;
  index: number;
  total: number;
  shortcutsEnabled: boolean;
  onAnswer: (optionId: string) => void;
}) {
  const approve = request.options.find((option) => option.kind === "allow_once");
  const reject = request.options.find((option) => option.kind === "reject_once");
  const content = useMemo(() => acpPermissionContent(request.content), [request.content]);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  useEffect(() => {
    if (!shortcutsEnabled) return;
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return;
      if (event.target instanceof Element && event.target.closest(approvalOverlaySelector)) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && approve) {
        event.preventDefault();
        onAnswer(approve.optionId);
      }
      if (event.key === "Escape" && reject) {
        event.preventDefault();
        onAnswer(reject.optionId);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [approve, reject, onAnswer, shortcutsEnabled]);
  const title = request.title ?? "Allow this tool call?";
  return (
    <ApprovalPromptShell title={title}>
      <div className="flex max-h-[min(24rem,50svh)] flex-col gap-3 overflow-y-auto p-3">
        <div className="flex items-start gap-2.5 px-1">
          <Marker className="min-w-0 flex-1 text-signal-awaiting">
            <ShieldAlertIcon />
            <MarkerContent>
              <span className="text-sm font-medium text-foreground">{title}</span>
            </MarkerContent>
          </Marker>
          {total > 1 ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {index + 1} of {total}
            </span>
          ) : null}
        </div>
        {request.toolKind ? (
          <p className="px-1 font-mono text-xs text-muted-foreground">{request.toolKind}</p>
        ) : null}
        {request.locations?.map((location, index) => (
          <p key={index} className="break-all px-1 font-mono text-xs text-muted-foreground">
            {location.path}
            {location.line !== undefined ? `:${location.line}` : ""}
          </p>
        ))}
        <AcpToolContentBlock
          content={content}
          path={request.locations?.[0]?.path}
          terminal={request.toolKind === "execute"}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-2 py-2">
        {["allow_always", "reject_always", "reject_once", "allow_once"]
          .flatMap((kind) => request.options.filter((option) => option.kind === kind))
          .map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={
                option.kind === "allow_once"
                  ? "default"
                  : option.kind === "reject_once"
                    ? "outline"
                    : "ghost"
              }
              onClick={() => onAnswer(option.optionId)}
            >
              {option.name}
              {shortcutsEnabled && option === approve ? <Kbd>{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd> : null}
              {shortcutsEnabled && option === reject ? <Kbd>Esc</Kbd> : null}
            </Button>
          ))}
      </div>
    </ApprovalPromptShell>
  );
}
