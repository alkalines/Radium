import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  ArrowLeftIcon,
  BotIcon,
  BracesIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  CopyIcon,
  DatabaseIcon,
  GaugeIcon,
  GitBranchIcon,
  HashIcon,
  MessageSquareCodeIcon,
  TerminalSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import { ProviderLogo } from "./provider-logo";
import { StatusBadge } from "./telemetry-panel";
import {
  formatTelemetryDate,
  formatTelemetryDuration,
  formatTokenCount,
  prettyTelemetryJson,
} from "./telemetry-utils";

type TraceResult = Exclude<FunctionReturnType<typeof api.telemetry.getTrace>, null>;
type Span = TraceResult["spans"][number];

export function TelemetryDetail({ traceId }: { traceId: Id<"telemetry_traces"> }) {
  const { data, error } = useQuery(convexQuery(api.telemetry.getTrace, { traceId }));

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load trace</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  if (data === undefined) return <TelemetryDetailSkeleton />;

  if (data === null) {
    return (
      <Alert>
        <AlertTitle>Trace not found</AlertTitle>
        <AlertDescription>
          This trace was deleted or does not belong to your balance.
        </AlertDescription>
      </Alert>
    );
  }

  const { trace, completion } = data;
  const usage = trace.usage;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/gateway/telemetry">
            <ArrowLeftIcon data-icon="inline-start" />
            All traces
          </Link>
        </Button>
        <span className="hidden font-mono text-[11px] text-muted-foreground sm:block">
          {trace._id}
        </span>
      </div>

      <header className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted">
            <ProviderLogo slug={trace.provider} className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-mono text-lg font-semibold">{trace.functionId}</h1>
              <StatusBadge status={trace.status} />
              <Badge variant="outline">{trace.source}</Badge>
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {trace.provider}/{trace.model} / {trace.operationId}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4 font-mono text-xs text-muted-foreground">
            <span>{formatTelemetryDuration(trace.durationMs)}</span>
            <span>
              {formatTokenCount(usage?.inputTokens ?? 0)} -&gt;{" "}
              {formatTokenCount(usage?.outputTokens ?? 0)}
            </span>
          </div>
        </div>

        <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4">
          <TraceMetric
            icon={Clock3Icon}
            label="Duration"
            value={formatTelemetryDuration(trace.durationMs)}
          />
          <TraceMetric
            icon={GaugeIcon}
            label="Total tokens"
            value={formatTokenCount(usage?.totalTokens ?? 0)}
          />
          <TraceMetric
            icon={GitBranchIcon}
            label="Reasoning"
            value={String(trace.stepCount ?? 0)}
          />
          <TraceMetric
            icon={WrenchIcon}
            label="Tool calls"
            value={String(trace.toolCallCount ?? 0)}
          />
        </div>
      </header>

      {data.truncated && (
        <Alert>
          <AlertTitle>Trace window truncated</AlertTitle>
          <AlertDescription>
            Only the first 100 spans and their payloads are shown.
          </AlertDescription>
        </Alert>
      )}

      {trace.error && (
        <Alert variant="destructive">
          <AlertTitle>Request error</AlertTitle>
          <AlertDescription className="font-mono text-xs">{trace.error}</AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="font-mono text-sm font-semibold uppercase tracking-wider">
              Execution timeline
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Reasoning, model calls, and tool executions in start order.
            </p>
          </div>
          <Badge variant="secondary">{data.spans.length} spans</Badge>
        </div>
        {data.spans.length ? (
          <div className="flex flex-col gap-2">
            {data.spans.map((span, index) => (
              <SpanRow key={span._id} span={span} index={index} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border px-4 py-10 text-center text-sm text-muted-foreground">
            No child spans were recorded.
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <CompletionCard completion={completion} traceCompletionId={trace.chatCompletionId} />
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-wider">
              <DatabaseIcon className="size-4" /> Trace metadata
            </CardTitle>
            <CardDescription>Convex and AI SDK correlation identifiers.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Identifier label="Trace ID" value={trace._id} />
            <Identifier label="Request ID" value={trace.requestId} />
            <Identifier label="Call ID" value={trace.callId} />
            <Identifier label="Operation ID" value={trace.operationId} />
            <Identifier label="Function ID" value={trace.functionId} />
            {trace.chatId && <Identifier label="Chat ID" value={trace.chatId} />}
            {trace.key && <Identifier label="API key ID" value={trace.key} />}
            <Separator />
            <MetadataRow label="Started" value={formatTelemetryDate(trace.startedAt)} />
            {trace.endedAt && (
              <MetadataRow label="Ended" value={formatTelemetryDate(trace.endedAt)} />
            )}
            <MetadataRow label="Finish reason" value={trace.finishReason ?? "-"} />
            <MetadataRow
              label="Reasoning tokens"
              value={formatTokenCount(usage?.reasoningTokens ?? 0)}
            />
            <MetadataRow label="Cache read" value={formatTokenCount(usage?.cacheReadTokens ?? 0)} />
            <MetadataRow
              label="Cache write"
              value={formatTokenCount(usage?.cacheWriteTokens ?? 0)}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SpanRow({ span, index }: { span: Span; index: number }) {
  const [open, setOpen] = useState(index === 0);
  const Icon =
    span.kind === "tool" ? WrenchIcon : span.kind === "model" ? BotIcon : BrainCircuitIcon;
  const hasDetails = Boolean(span.inputJson || span.outputJson || span.error);
  const style =
    span.kind === "step"
      ? {
          border: "border-l-chart-1",
          icon: "text-chart-1",
          badge: "border-chart-1/30 bg-chart-1/10 text-chart-1",
        }
      : span.kind === "model"
        ? {
            border: "border-l-chart-2",
            icon: "text-chart-2",
            badge: "border-chart-2/30 bg-chart-2/10 text-chart-2",
          }
        : {
            border: "border-l-chart-3",
            icon: "text-chart-3",
            badge: "border-chart-3/30 bg-chart-3/10 text-chart-3",
          };
  const kindLabel = span.kind === "step" ? "reasoning" : span.kind;
  const name = span.kind === "step" ? "Reasoning" : span.name;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("overflow-hidden rounded-xl border border-l-4 bg-card", style.border)}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
        disabled={!hasDetails}
      >
        <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground">
          {String(index + 1).padStart(2, "0")}
        </span>
        <Icon className={cn("size-4 shrink-0", style.icon)} />
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{name}</span>
        <Badge variant="outline" className={style.badge}>
          {kindLabel}
        </Badge>
        <StatusBadge status={span.status} />
        <span className="hidden font-mono text-xs text-muted-foreground sm:block">
          {formatTelemetryDuration(span.durationMs)}
        </span>
        <span className="hidden font-mono text-xs text-muted-foreground md:block">
          {formatTokenCount(span.usage?.totalTokens ?? 0)} tok
        </span>
        {hasDetails && (
          <ChevronDownIcon
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t">
        {span.kind === "step" ? (
          <PayloadPanel label="Reasoning output" value={span.error ?? span.outputJson} />
        ) : (
          <div className="grid lg:grid-cols-2 lg:divide-x">
            <PayloadPanel
              label={span.kind === "tool" ? "Arguments" : "Input"}
              value={span.inputJson}
            />
            <PayloadPanel
              label={span.error ? "Error" : "Output"}
              value={span.error ?? span.outputJson}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-t bg-muted/30 px-4 py-2 font-mono text-[11px] text-muted-foreground">
          {span.provider && <span>provider={span.provider}</span>}
          {span.model && <span>model={span.model}</span>}
          {span.toolCallId && <span>tool_call_id={span.toolCallId}</span>}
          {span.finishReason && <span>finish_reason={span.finishReason}</span>}
          <span>started={new Date(span.startedAt).toISOString()}</span>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PayloadPanel({ label, value }: { label: string; value?: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const code = value ? prettyTelemetryJson(value) : undefined;
  const parsed = value ? parsePayload(value) : undefined;
  return (
    <div className="flex min-h-40 min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <TerminalSquareIcon className="size-3.5" /> {label}
        </div>
        {code && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 font-mono text-[11px]"
            onClick={() => setShowRaw((current) => !current)}
          >
            <BracesIcon data-icon="inline-start" />
            {showRaw ? "Hide raw" : "View raw"}
          </Button>
        )}
      </div>
      {showRaw && code ? (
        <CodeBlock
          code={code}
          language="json"
          showLineNumbers
          className="min-h-36 flex-1 border-0 bg-muted/40"
        >
          <CodeBlockCopyButton aria-label={`Copy ${label.toLowerCase()}`} />
        </CodeBlock>
      ) : parsed !== undefined ? (
        <PayloadPreview value={parsed} />
      ) : (
        <div className="flex min-h-28 flex-1 items-center justify-center rounded-md border border-dashed bg-muted/20 px-4 text-center text-xs text-muted-foreground">
          No {label.toLowerCase()} payload was recorded.
        </div>
      )}
    </div>
  );
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function PayloadPreview({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground">null</span>;
  }
  if (typeof value === "string") {
    return <p className="whitespace-pre-wrap text-sm leading-relaxed">{value}</p>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <code className="text-xs">{String(value)}</code>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-xs text-muted-foreground">Empty list</span>;
    return (
      <div className="flex flex-col gap-2">
        {value.map((item, index) => (
          <PayloadItem key={index} value={item} depth={depth} />
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.messages) || record.instructions !== undefined) {
      return <PromptPreview value={record} />;
    }
    if (typeof record.type === "string") return <ContentPart value={record} />;
    if (depth >= 2) {
      return (
        <span className="text-xs text-muted-foreground">{Object.keys(record).length} fields</span>
      );
    }
    return <ObjectPreview value={record} depth={depth} />;
  }
  return <span className="text-xs text-muted-foreground">Unsupported value</span>;
}

function PayloadItem({ value, depth }: { value: unknown; depth: number }) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string") return <ContentPart value={record} />;
  }
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <PayloadPreview value={value} depth={depth + 1} />
    </div>
  );
}

function PromptPreview({ value }: { value: Record<string, unknown> }) {
  return (
    <div className="flex flex-col gap-3">
      {value.instructions !== undefined && (
        <div className="rounded-lg border border-chart-1/30 bg-chart-1/10 p-3">
          <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-chart-1">
            Instructions
          </div>
          <PayloadPreview value={value.instructions} depth={1} />
        </div>
      )}
      {Array.isArray(value.messages) &&
        value.messages.map((message, index) => {
          const record: Record<string, unknown> =
            typeof message === "object" && message !== null
              ? (message as Record<string, unknown>)
              : { content: message };
          return (
            <div key={index} className="rounded-lg border bg-muted/20 p-3">
              <div className="mb-2 flex items-center gap-2">
                <MessageSquareCodeIcon className="size-3.5 text-chart-2" />
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                  {typeof record.role === "string" ? record.role : `Message ${index + 1}`}
                </span>
              </div>
              <PayloadPreview value={record.content} depth={1} />
            </div>
          );
        })}
    </div>
  );
}

function ContentPart({ value }: { value: Record<string, unknown> }) {
  const type = String(value.type);
  const isReasoning = type.includes("reasoning");
  const isTool = type.includes("tool");
  const color = isReasoning ? "text-chart-1" : isTool ? "text-chart-3" : "text-chart-2";
  const background = isReasoning
    ? "border-chart-1/30 bg-chart-1/10"
    : isTool
      ? "border-chart-3/30 bg-chart-3/10"
      : "border-chart-2/30 bg-chart-2/10";
  const title =
    typeof value.toolName === "string"
      ? value.toolName
      : type.replaceAll("-", " ").replaceAll("_", " ");
  const content = value.text ?? value.output ?? value.input ?? value.args ?? value.content;

  return (
    <div className={cn("rounded-lg border p-3", background)}>
      <div
        className={cn(
          "mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-wider",
          color,
        )}
      >
        {isTool ? (
          <WrenchIcon className="size-3.5" />
        ) : isReasoning ? (
          <BrainCircuitIcon className="size-3.5" />
        ) : (
          <BotIcon className="size-3.5" />
        )}
        {title}
      </div>
      {content !== undefined ? (
        <PayloadPreview value={content} depth={1} />
      ) : (
        <ObjectPreview value={value} depth={1} omit={["type", "toolName"]} />
      )}
    </div>
  );
}

function ObjectPreview({
  value,
  depth,
  omit = [],
}: {
  value: Record<string, unknown>;
  depth: number;
  omit?: string[];
}) {
  const entries = Object.entries(value).filter(([key]) => !omit.includes(key));
  return (
    <dl className="flex flex-col divide-y rounded-lg border bg-muted/20">
      {entries.map(([key, item]) => (
        <div key={key} className="grid gap-1 px-3 py-2 sm:grid-cols-[8rem_1fr]">
          <dt className="font-mono text-[11px] text-muted-foreground">{key}</dt>
          <dd className="min-w-0">
            <PayloadPreview value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CompletionCard({
  completion,
  traceCompletionId,
}: {
  completion: TraceResult["completion"];
  traceCompletionId?: Id<"chat_completions">;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-wider">
          <CircleDollarSignIcon className="size-4" /> Gateway completion
        </CardTitle>
        <CardDescription>The billing record produced by this AI SDK request.</CardDescription>
      </CardHeader>
      <CardContent>
        {!completion ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {traceCompletionId
              ? "The linked completion is no longer available."
              : "No chat_completions record is linked to this trace."}
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Identifier label="Convex ID" value={completion._id} />
              <Identifier label="Generation ID" value={completion.response.genId} />
              <Identifier label="Provider gen ID" value={completion.response.providerGenId} />
              <MetadataRow label="Model" value={completion.model?.slug ?? "Unknown"} />
              <MetadataRow label="Provider" value={completion.request.provider} />
              <MetadataRow label="Streamed" value={completion.request.streamed ? "yes" : "no"} />
            </div>
            <div className="flex flex-col gap-2">
              <MetadataRow
                label="Cost"
                value={`$${completion.response.pricing.cost.toFixed(6)}`}
                mono
              />
              <MetadataRow label="TTFT" value={formatTelemetryDuration(completion.response.ttft)} />
              <MetadataRow
                label="Generation"
                value={formatTelemetryDuration(completion.response.gen_time)}
              />
              <MetadataRow
                label="Input tokens"
                value={formatTokenCount(completion.response.usage.prompt_tokens)}
              />
              <MetadataRow
                label="Output tokens"
                value={formatTokenCount(completion.response.usage.completion_tokens)}
              />
              <MetadataRow label="Finish reason" value={completion.response.finish_reason} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TraceMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3Icon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 bg-card px-3 py-2.5">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="ml-auto font-mono text-sm font-medium tabular-nums">{value}</strong>
    </div>
  );
}

function Identifier({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <HashIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate text-[11px]">{value}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={`Copy ${label}`}
        onClick={() => void navigator.clipboard.writeText(value)}
      >
        <CopyIcon />
      </Button>
    </div>
  );
}

function MetadataRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("truncate text-right", mono && "font-mono")}>{value}</span>
    </div>
  );
}

function TelemetryDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-28" />
      <Skeleton className="h-44" />
      <Skeleton className="h-80" />
      <Skeleton className="h-14" />
      <Skeleton className="h-14" />
    </div>
  );
}
