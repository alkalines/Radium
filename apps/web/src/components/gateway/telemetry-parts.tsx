import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import {
  BotIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  EyeOffIcon,
  MessageSquareIcon,
  ShieldIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { blobValue } from "backend/src/telemetry/store";

import { AgentStatus } from "@/components/agentic/agent-status";
import { Tag } from "@/components/harness/group-list";
import { Badge } from "@/components/ui/badge";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { cn } from "@/lib/utils";
import type { api } from "backend/convex/_generated/api";
import {
  asRecord,
  changeLabel,
  contentText,
  lineageLabel,
  messageToolCalls,
  prettyJson,
  requestRunState,
  type ToolCallView,
  type ChangedField,
  type LineageKind,
  type RequestStatusValue,
} from "./telemetry-utils";
import { ProviderLogo } from "./provider-logo";

/** A stored blob as returned by the telemetry read functions. */
export type TelemetryBlob = NonNullable<
  FunctionReturnType<typeof api.observability.telemetry.getRequest>["system"]
>;
export type RequestRow = FunctionReturnType<
  typeof api.observability.telemetry.listRequests
>["page"][number];

export function RequestStatusLabel({ status }: { status: RequestStatusValue }) {
  return (
    <AgentStatus state={requestRunState(status)} label={status === "ok" ? "success" : status} />
  );
}

/** Provider logo for requests that may have failed before any provider was chosen. */
export function RequestProviderLogo({ slug, className }: { slug?: string; className?: string }) {
  return slug ? <ProviderLogo slug={slug} className={className} /> : null;
}

/**
 * Lineage badge. When the parent request is known the badge links to it, so a retry or branch
 * is one click from the conversation it came from.
 */
export function LineageBadge({
  lineage,
  className,
}: {
  lineage: { kind: LineageKind; request?: string; depth?: number };
  className?: string;
}) {
  const label = lineageLabel(lineage);
  const badge = (
    <Badge
      variant={lineage.kind === "root" || lineage.kind === "continue" ? "outline" : "secondary"}
      className={className}
    >
      {label}
    </Badge>
  );
  if (!lineage.request) return badge;
  return (
    <Link
      to="/gateway/telemetry/$id"
      params={{ id: lineage.request }}
      aria-label={`${label}: open the related request`}
      className="rounded-4xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {badge}
    </Link>
  );
}

/** Chips naming what changed relative to the previous request in the session. */
export function ChangeTags({ fields }: { fields: readonly ChangedField[] }) {
  if (fields.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {fields.map((field) => (
        <Tag key={field}>{changeLabel(field)} changed</Tag>
      ))}
    </span>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  const code = prettyJson(value);
  const highlighted = useHighlightedCode(code, "json");

  return (
    <CodeBlock size="sm">
      <CodeBlockActions>
        <CodeBlockCopyButton value={code} />
      </CodeBlockActions>
      <CodeBlockContent>
        {highlighted.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

export function JsonSection({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <JsonBlock value={value} />
    </div>
  );
}

function roleStyle(role: string) {
  switch (role) {
    case "system":
    case "developer":
      return {
        icon: ShieldIcon,
        container: "border-telemetry-system/35 bg-telemetry-system/10",
        text: "text-telemetry-system",
      };
    case "user":
      return {
        icon: UserRoundIcon,
        container: "border-telemetry-user/35 bg-telemetry-user/10",
        text: "text-telemetry-user",
      };
    case "assistant":
      return {
        icon: BotIcon,
        container: "border-telemetry-assistant/35 bg-telemetry-assistant/10",
        text: "text-telemetry-assistant",
      };
    case "tool":
      return {
        icon: WrenchIcon,
        container: "border-telemetry-tool/35 bg-telemetry-tool/10",
        text: "text-telemetry-tool",
      };
    default:
      return {
        icon: MessageSquareIcon,
        container: "bg-muted/20",
        text: "text-muted-foreground",
      };
  }
}

/** A `tool` message matched to the assistant tool call that requested it. */
export type ToolResultView = { blob: TelemetryBlob; depth?: number; isNew?: boolean };

/**
 * One conversation message. Recorded content renders by role; a message stored without content
 * (recording was off, or the content is in file storage) renders a placeholder that keeps the
 * role and tool names, which are always captured. An assistant message renders each tool call
 * together with its result from `toolResults` (keyed by `tool_call_id`) in one card.
 */
export function MessageView({
  blob,
  depth,
  isNew,
  defaultOpen = false,
  highlightNew = true,
  label,
  toolResults,
}: {
  blob: TelemetryBlob;
  depth?: number;
  isNew?: boolean;
  defaultOpen?: boolean;
  highlightNew?: boolean;
  /** Overrides the role label, e.g. "output" for the model's answer. */
  label?: string;
  toolResults?: ReadonlyMap<string, ToolResultView>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const value = useMemo(() => blobValue(blob), [blob.content]);
  const record = asRecord(value);
  const role = typeof record?.role === "string" ? record.role : (blob.meta?.role ?? "message");
  const style = roleStyle(role);
  const RoleIcon = style.icon;

  const text = contentText(record?.content);
  const calls = record ? messageToolCalls(record) : [];
  const reasoning = record
    ? (record.reasoning ?? record.reasoning_content ?? record.reasoning_details)
    : undefined;
  const toolNames = calls.length ? calls.map((call) => call.name) : (blob.meta?.names ?? []);
  const preview = blob.redacted
    ? "Content not recorded"
    : (text ?? (toolNames.length ? toolNames.join(", ") : "Structured content"));

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-lg border",
        style.container,
        isNew && highlightNew && "ring-1 ring-primary/40",
      )}
    >
      <CollapsibleTrigger
        className={cn("group flex w-full items-center gap-2 px-3 py-2 text-left", style.text)}
      >
        {depth !== undefined && (
          <span className="font-mono text-[9px] text-muted-foreground">{depth}</span>
        )}
        <RoleIcon className="size-3.5 shrink-0" />
        <span className="font-mono text-[9px] font-semibold uppercase tracking-wider">
          {label ?? role}
        </span>
        {role === "assistant" && toolNames.length > 0 && (
          <span className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-telemetry-tool">
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            {toolNames.length === 1 ? "Tool call" : `Tool calls · ${toolNames.length}`}
          </span>
        )}
        {isNew && highlightNew && <Tag className="text-foreground">new</Tag>}
        {blob.redacted && <EyeOffIcon className="size-3 shrink-0 text-muted-foreground" />}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            {preview}
          </span>
        )}
        <ChevronDownIcon className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t border-current/10">
        <div className="flex flex-col gap-2 p-2.5">
          {blob.redacted ? (
            <RedactedBody blob={blob} toolNames={toolNames} />
          ) : blob.content === undefined ? (
            <StoredFileNotice blob={blob} />
          ) : (
            <>
              {text !== undefined && (
                <p className="px-1 text-xs leading-relaxed whitespace-pre-wrap">{text}</p>
              )}
              {text === undefined && record?.content != null && (
                <JsonBlock value={record.content} />
              )}
              {reasoning != null && (
                <div className="rounded-md border border-telemetry-thinking/35 bg-telemetry-thinking/10 px-2.5 py-2 text-telemetry-thinking">
                  <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
                    <BrainCircuitIcon className="size-3" /> Reasoning
                  </div>
                  {typeof reasoning === "string" ? (
                    <p className="text-xs leading-relaxed whitespace-pre-wrap">{reasoning}</p>
                  ) : (
                    <JsonBlock value={reasoning} />
                  )}
                </div>
              )}
              {calls.map((call, index) => (
                <ToolCallCard
                  key={call.id ?? index}
                  call={call}
                  result={call.id ? toolResults?.get(call.id) : undefined}
                  expectsResult={toolResults !== undefined}
                />
              ))}
              {typeof record?.tool_call_id === "string" && (
                <p className="px-1 font-mono text-[10px] text-muted-foreground">
                  tool_call_id {record.tool_call_id}
                </p>
              )}
              {!record && <JsonBlock value={value} />}
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A tool call and the result the client sent back for it. Without `expectsResult` (the model's
 * own output) the result arrives only in the next request, so its absence is not flagged.
 */
function ToolCallCard({
  call,
  result,
  expectsResult,
}: {
  call: ToolCallView;
  result: ToolResultView | undefined;
  expectsResult: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-telemetry-tool/35 bg-telemetry-tool/10 text-telemetry-tool">
      <div className="flex items-center gap-1.5 px-2.5 pt-2 font-mono text-[9px] font-semibold uppercase tracking-wider">
        <WrenchIcon className="size-3" /> Tool call · {call.name}
        {call.id && (
          <span className="ml-auto truncate font-normal normal-case tracking-normal text-muted-foreground">
            {call.id}
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <JsonBlock value={call.arguments} />
      </div>
      <div className="flex flex-col gap-1.5 border-t border-telemetry-tool/25 bg-background/40 px-2.5 py-2">
        <div className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
          Result
          {result?.depth !== undefined && (
            <span className="font-normal text-muted-foreground">{result.depth}</span>
          )}
          {result?.isNew && <Tag className="text-foreground">new</Tag>}
        </div>
        {result ? (
          <ToolResultBody blob={result.blob} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {expectsResult
              ? "No result was sent for this call."
              : "The client returns the result in its next request."}
          </p>
        )}
      </div>
    </div>
  );
}

function ToolResultBody({ blob }: { blob: TelemetryBlob }) {
  const value = useMemo(() => blobValue(blob), [blob.content]);
  if (blob.redacted) {
    return (
      <p className="text-xs text-muted-foreground">
        The result was not stored ({blob.size.toLocaleString()} bytes).
      </p>
    );
  }
  if (blob.content === undefined) return <StoredFileNotice blob={blob} />;
  const content = asRecord(value)?.content;
  const text = contentText(content);
  return text !== undefined ? (
    <p className="text-xs leading-relaxed whitespace-pre-wrap text-foreground">{text}</p>
  ) : (
    <JsonBlock value={content ?? value} />
  );
}

function toolDescription(blob: TelemetryBlob): string | undefined {
  const record = asRecord(blobValue(blob));
  const fn = asRecord(record?.function) ?? record;
  return typeof fn?.description === "string" ? fn.description : undefined;
}

/** A tool definition. With `before` the body shows the old and new JSON schema side by side. */
export function ToolItem({
  name,
  blob,
  before,
  badge,
}: {
  name: string;
  blob: TelemetryBlob;
  before?: TelemetryBlob;
  badge?: "added" | "removed" | "changed";
}) {
  const [open, setOpen] = useState(false);
  const description = toolDescription(blob);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
        <WrenchIcon className="size-3.5 shrink-0 text-telemetry-tool" />
        <span className="font-mono text-xs font-medium">{name}</span>
        {badge && <Tag>{badge}</Tag>}
        {description && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {description}
          </span>
        )}
        <ChevronDownIcon className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t">
        <div className={cn("grid gap-3 p-3", before && "lg:grid-cols-2")}>
          {before && <ToolSchema label="Before" blob={before} />}
          <ToolSchema label={before ? "After" : "Definition"} blob={blob} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolSchema({ label, blob }: { label: string; blob: TelemetryBlob }) {
  if (blob.content !== undefined) {
    return <JsonSection label={label} value={blobValue(blob)} />;
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span className="font-mono text-[9px] uppercase tracking-wider">{label}</span>
      {blob.redacted ? (
        <p>The tool definition was not recorded; only its name is kept.</p>
      ) : (
        <StoredFileNotice blob={blob} />
      )}
    </div>
  );
}
function RedactedBody({ blob, toolNames }: { blob: TelemetryBlob; toolNames: string[] }) {
  return (
    <div className="flex flex-col gap-2 px-1 py-1 text-xs text-muted-foreground">
      <p>
        The content of this message was not stored. Only its role and tool names are kept, and its
        fingerprint still lets Radium detect when it changes.
      </p>
      {toolNames.length > 0 && (
        <p className="flex flex-wrap items-center gap-1">
          Tool calls:
          {toolNames.map((name) => (
            <Tag key={name} className="font-mono">
              {name}
            </Tag>
          ))}
        </p>
      )}
      {blob.meta?.toolCallId && (
        <p className="font-mono text-[10px]">tool_call_id {blob.meta.toolCallId}</p>
      )}
      <p className="font-mono text-[10px]">{blob.size.toLocaleString()} bytes</p>
    </div>
  );
}

/** Link to the stored file for content above the inline limit. */
export function StoredFileNotice({ blob }: { blob: TelemetryBlob }) {
  if (!blob.storageUrl) return null;
  return (
    <a
      href={blob.storageUrl}
      target="_blank"
      rel="noreferrer"
      className="text-xs underline underline-offset-2"
    >
      Open the full content ({blob.size.toLocaleString()} bytes)
    </a>
  );
}
