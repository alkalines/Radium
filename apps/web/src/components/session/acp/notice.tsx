import { AlertCircleIcon, CheckIcon, InfoIcon, Minimize2Icon } from "lucide-react";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { cn } from "@/lib/utils";
import type { AcpNoticeItem } from "./parts";

/** Compact agent notices; compaction summaries stay collapsed until the reader asks for them. */
export function AcpNotice({ notice }: { notice: AcpNoticeItem }) {
  const danger = notice.severity === "error" || notice.severity === "fatal";
  const warning = notice.severity === "warning" || notice.severity === "warn";
  const success = notice.severity === "success";
  const Icon = notice.compaction
    ? Minimize2Icon
    : danger || warning
      ? AlertCircleIcon
      : success
        ? CheckIcon
        : InfoIcon;
  return (
    <Marker
      className={cn(
        "items-start text-xs",
        danger && "text-destructive",
        warning && "text-signal-awaiting",
        success && "text-signal-success",
      )}
    >
      <Icon />
      <div className="min-w-0">
        <MarkerContent>{notice.title}</MarkerContent>
        {notice.compaction ? (
          <span className="ml-2 text-muted-foreground">
            {notice.compaction.status.replaceAll("_", " ")}
          </span>
        ) : null}
        {notice.description ? (
          <p className="mt-1 text-muted-foreground whitespace-pre-wrap">{notice.description}</p>
        ) : null}
        {notice.compaction?.summary ? (
          <details className="mt-1 text-muted-foreground">
            <summary className="cursor-pointer">Summary</summary>
            <p className="mt-1 whitespace-pre-wrap">{notice.compaction.summary}</p>
          </details>
        ) : null}
      </div>
    </Marker>
  );
}
