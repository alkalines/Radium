import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  DatabaseIcon,
  FileIcon,
  FlagIcon,
  HistoryIcon,
  LinkIcon,
  MessageSquareIcon,
  RouteIcon,
  ShieldIcon,
  TextIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import { ProviderLogo } from "./provider-logo";
import { formatTelemetryDate, formatTelemetryDuration, formatTokenCount } from "./telemetry-utils";

type TraceResult = Exclude<FunctionReturnType<typeof api.telemetry.getTrace>, null>;
type Span = TraceResult["spans"][number];
type Step = {
  model?: Span;
  summary?: Span;
  tools: Span[];
};

export function TelemetryDetail({ traceId }: { traceId: Id<"telemetry_traces"> }) {
  const { data, error } = useQuery(convexQuery(api.telemetry.getTrace, { traceId }));

  if (error) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
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

  const { trace } = data;
  const steps = buildSteps(data.spans);
  const displaySteps = steps.length ? steps : [{ tools: [] }];
  const title = getRunTitle(data.inputJson, steps[0]?.model?.inputJson) ?? trace.functionId;

  return (
    <div className="flex flex-col gap-3">
      <Button variant="ghost" size="sm" className="mr-auto -ml-2" asChild>
        <Link to="/gateway/telemetry">
          <ArrowLeftIcon data-icon="inline-start" />
          All traces
        </Link>
      </Button>

      <header className="flex flex-col gap-3 px-0.5 pb-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-sans text-sm font-medium">{title}</h1>
            <RunStatus status={trace.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground lg:justify-end">
            <span>
              {displaySteps.length} {displaySteps.length === 1 ? "step" : "steps"}
            </span>
            <span aria-hidden>·</span>
            <span>{formatTelemetryDuration(trace.durationMs)}</span>
            <span aria-hidden>·</span>
            <span>
              input: {formatTokenCount(trace.usage?.inputTokens ?? 0)} → output:{" "}
              {formatTokenCount(trace.usage?.outputTokens ?? 0)}
            </span>
            <span aria-hidden>·</span>
            <time dateTime={new Date(trace.startedAt).toISOString()}>
              {formatTelemetryDate(trace.startedAt)}
            </time>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1.5">
              <RouteIcon className="size-3" /> Timeline
            </span>
          </div>
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

      <section aria-label="Execution steps" className="flex flex-col gap-2.5">
        {displaySteps.map((step, index) => (
          <StepCard
            key={step.model?._id ?? `trace-${index}`}
            step={step}
            index={index}
            rootInput={index === 0 ? data.inputJson : undefined}
            rootOutput={index === displaySteps.length - 1 ? data.outputJson : undefined}
            trace={trace}
          />
        ))}
      </section>

      <RunDetails data={data} />
    </div>
  );
}

function StepCard({
  step,
  index,
  rootInput,
  rootOutput,
  trace,
}: {
  step: Step;
  index: number;
  rootInput?: string;
  rootOutput?: string;
  trace: TraceResult["trace"];
}) {
  const [open, setOpen] = useState(false);
  const input = step.model?.inputJson ?? rootInput;
  const output = step.model?.outputJson ?? rootOutput;
  const error = step.model?.error ?? (!step.model ? trace.error : undefined);
  const duration = step.summary?.durationMs ?? step.model?.durationMs ?? trace.durationMs;
  const usage = step.model?.usage ?? step.summary?.usage ?? (!step.model ? trace.usage : undefined);
  const model = step.model?.model ?? step.summary?.model ?? trace.model;
  const provider = step.model?.provider ?? step.summary?.provider ?? trace.provider;
  const outputLabel = error ? "Error" : summarizeOutput(output, step.tools);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-xs",
        error && "border-destructive/35",
      )}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2.5 px-3 py-3 text-left sm:px-4">
        <span className="w-4 shrink-0 font-mono text-[11px] text-muted-foreground">
          {index + 1}
        </span>
        <InputSummary value={input} />
        <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-medium",
            error && "text-destructive",
          )}
        >
          {error ? (
            <CircleAlertIcon className="size-3.5 shrink-0" />
          ) : outputLabel === "Response" ? (
            <MessageSquareIcon className="size-3.5 shrink-0" />
          ) : (
            <WrenchIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{outputLabel}</span>
        </span>
        <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground md:block">
          {formatTelemetryDuration(duration)}
        </span>
        <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground lg:block">
          {formatTokenCount(usage?.inputTokens ?? 0)} → {formatTokenCount(usage?.outputTokens ?? 0)}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="collapsible-content border-t">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/25 px-3 py-2 font-mono text-[10px] text-muted-foreground sm:px-4">
          <Badge variant="secondary" className="h-4 rounded-sm px-1.5 text-[9px]">
            {trace.source}
          </Badge>
          <span className="flex items-center gap-1.5">
            <ProviderLogo slug={provider} className="size-3" />
            {provider}/{model}
          </span>
          {step.tools.length > 0 && (
            <span className="flex items-center gap-1">
              <WrenchIcon className="size-3" /> {step.tools.length} tool{" "}
              {step.tools.length === 1 ? "execution" : "executions"}
            </span>
          )}
          {(step.model?.finishReason ?? step.summary?.finishReason ?? trace.finishReason) && (
            <span>
              finish: {step.model?.finishReason ?? step.summary?.finishReason ?? trace.finishReason}
            </span>
          )}
          <span className="ml-auto hidden sm:inline">{formatTelemetryDuration(duration)}</span>
        </div>

        <div className="grid min-h-44 lg:grid-cols-2 lg:divide-x">
          <StepPanel label="Input">
            <PromptView value={input} />
          </StepPanel>
          <StepPanel label="Output">
            {error ? (
              <ErrorOutput message={error} />
            ) : (
              <OutputView value={output} tools={step.tools} />
            )}
          </StepPanel>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StepPanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function PromptView({ value }: { value?: string }) {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return <EmptyPayload label="input" value={value} />;
  }

  const prompt = parsed as Record<string, unknown>;
  const messages = Array.isArray(prompt.messages) ? prompt.messages : [];
  const entries = [
    ...(prompt.instructions !== undefined
      ? [{ role: "system", content: prompt.instructions }]
      : []),
    ...messages.map((message) => {
      const record = asRecord(message);
      return {
        role: typeof record?.role === "string" ? record.role : "message",
        content: record?.content ?? record?.parts ?? message,
      };
    }),
  ];
  const hiddenCount = Math.max(0, entries.length - 2);
  const previousMessages = entries.slice(0, hiddenCount);
  const visibleMessages = entries.slice(hiddenCount);

  return (
    <div className="flex flex-col gap-2.5">
      {hiddenCount > 0 && <PreviousMessages messages={previousMessages} />}
      {visibleMessages.map((message, index) => (
        <MessageCard
          key={`${message.role}-${hiddenCount + index}`}
          role={message.role}
          index={hiddenCount + index + 1}
          content={message.content}
        />
      ))}
      {!messages.length && prompt.instructions === undefined && <RawPayload value={value} />}
    </div>
  );
}

function PreviousMessages({ messages }: { messages: Array<{ role: string; content: unknown }> }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-dashed">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[10px] text-muted-foreground">
        <HistoryIcon className="size-3.5" />
        {messages.length} previous {messages.length === 1 ? "message" : "messages"}
        <ChevronDownIcon className="ml-auto size-3 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t border-dashed">
        <div className="flex flex-col gap-2 p-2">
          {messages.map((message, index) => (
            <MessageCard
              key={`${message.role}-${index}`}
              role={message.role}
              index={index + 1}
              content={message.content}
              defaultOpen={false}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageCard({
  role,
  index,
  content,
  defaultOpen = false,
}: {
  role: string;
  index: number;
  content: unknown;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const parts = Array.isArray(content) ? content : [content];
  const roleStyle = getRoleStyle(role);
  const RoleIcon = roleStyle.icon;
  const preview = summarizeContent(content);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("overflow-hidden rounded-lg border", roleStyle.container)}
    >
      <CollapsibleTrigger
        className={cn("group flex w-full items-center gap-2 px-3 py-2 text-left", roleStyle.text)}
      >
        <span className="font-mono text-[9px] text-muted-foreground">{index}</span>
        <RoleIcon className="size-3.5 shrink-0" />
        <span className="font-mono text-[9px] font-semibold uppercase tracking-wider">{role}</span>
        {parts.length > 1 && (
          <span className="font-mono text-[9px] text-muted-foreground">{parts.length} parts</span>
        )}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            {preview}
          </span>
        )}
        <ChevronDownIcon className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t border-current/10">
        <div className="flex flex-col gap-1.5 p-2.5">
          {parts.map((part, partIndex) => (
            <ContentLine key={partIndex} value={part} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ContentLine({ value }: { value: unknown }) {
  if (typeof value === "string")
    return <p className="whitespace-pre-wrap px-1 text-xs leading-relaxed">{value}</p>;
  const part = asRecord(value);
  if (!part) return <InlineJson value={value} />;

  const type = typeof part.type === "string" ? part.type : "";
  if (type === "text") {
    return <p className="whitespace-pre-wrap px-1 text-xs leading-relaxed">{String(part.text)}</p>;
  }
  if (type.includes("tool-call")) {
    return (
      <div className="rounded-md border border-telemetry-tool/35 bg-telemetry-tool/10 px-2.5 py-2 text-telemetry-tool">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
          <WrenchIcon className="size-3" /> Tool call · {String(part.toolName ?? "tool")}
        </div>
        <InlineJson value={part.input ?? part.args} />
      </div>
    );
  }
  if (type.includes("tool-result")) {
    const output = asRecord(part.output);
    return (
      <div className="rounded-md border border-telemetry-tool/35 bg-telemetry-tool/10 px-2.5 py-2 text-telemetry-tool">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
          <CircleCheckIcon className="size-3" /> Tool result · {String(part.toolName ?? "tool")}
        </div>
        <InlineJson value={output?.value ?? part.output} />
      </div>
    );
  }
  if (type === "dynamic-tool" || type.startsWith("tool-")) {
    return <InputToolPart part={part} />;
  }
  if (type.includes("reasoning")) {
    return (
      <div className="rounded-md border border-telemetry-thinking/35 bg-telemetry-thinking/10 px-2.5 py-2 text-telemetry-thinking">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
          <BrainCircuitIcon className="size-3" /> Reasoning
        </div>
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{String(part.text ?? "")}</p>
      </div>
    );
  }
  if (type === "source-url") {
    return (
      <div className="rounded-md border border-telemetry-user/30 bg-telemetry-user/10 px-2.5 py-2 text-telemetry-user">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
          <LinkIcon className="size-3" /> URL source
        </div>
        <a
          href={String(part.url)}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-xs underline underline-offset-2"
        >
          {String(part.title ?? part.url)}
        </a>
      </div>
    );
  }
  if (type === "source-document") {
    return (
      <div className="rounded-md border border-telemetry-user/30 bg-telemetry-user/10 px-2.5 py-2 text-telemetry-user">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
          <FileIcon className="size-3" /> Document source
        </div>
        <p className="text-xs">{String(part.title ?? part.filename ?? part.sourceId)}</p>
        <p className="mt-1 font-mono text-[9px] opacity-70">{String(part.mediaType)}</p>
      </div>
    );
  }
  if (type === "file") {
    return (
      <div className="rounded-md border border-telemetry-user/30 bg-telemetry-user/10 px-2.5 py-2 text-telemetry-user">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-wider">
          <FileIcon className="size-3" /> File
        </div>
        <p className="truncate text-xs">{String(part.filename ?? part.url ?? "Attached file")}</p>
        <p className="mt-1 font-mono text-[9px] opacity-70">{String(part.mediaType)}</p>
      </div>
    );
  }
  if (type === "step-start") {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        <FlagIcon className="size-3" /> Step start
      </div>
    );
  }
  if (part.text !== undefined)
    return <p className="whitespace-pre-wrap text-xs leading-relaxed">{String(part.text)}</p>;
  return <InlineJson value={value} />;
}

function InputToolPart({ part }: { part: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const type = String(part.type);
  const name =
    type === "dynamic-tool" && typeof part.toolName === "string"
      ? part.toolName
      : type.slice("tool-".length);
  const state = typeof part.state === "string" ? part.state : "unknown";
  const failed = state === "output-error" || state === "output-denied";
  const hasOutput = part.output !== undefined || part.errorText !== undefined || failed;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-md border",
        failed
          ? "border-destructive/30 bg-destructive/5"
          : "border-telemetry-tool/35 bg-telemetry-tool/10",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 px-2.5 py-2 text-left",
          failed ? "text-destructive" : "text-telemetry-tool",
        )}
      >
        {failed ? (
          <CircleAlertIcon className="size-3.5 shrink-0" />
        ) : hasOutput ? (
          <CircleCheckIcon className="size-3.5 shrink-0" />
        ) : (
          <WrenchIcon className="size-3.5 shrink-0" />
        )}
        <span className="font-mono text-[9px] font-semibold uppercase tracking-wider">
          Tool · {name}
        </span>
        <span className="truncate font-mono text-[9px] text-muted-foreground">
          {state.replaceAll("-", " ")}
        </span>
        <ChevronDownIcon className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t border-current/10">
        <div className={cn("grid gap-2 p-2.5", hasOutput && "sm:grid-cols-2")}>
          <JsonSection label="Input" value={part.input ?? part.rawInput} />
          {hasOutput && (
            <JsonSection
              label={failed ? "Error" : "Output"}
              value={part.errorText ?? part.output ?? part.approval}
              destructive={failed}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function OutputView({ value, tools }: { value?: string; tools: Span[] }) {
  const parsed = parseJson(value);
  const parts = Array.isArray(parsed)
    ? parsed
    : asRecord(parsed) && Array.isArray(asRecord(parsed)?.content)
      ? (asRecord(parsed)!.content as unknown[])
      : parsed === undefined
        ? []
        : [parsed];

  if (!parts.length && !tools.length) return <EmptyPayload label="output" value={value} />;

  const usedToolIds = new Set<string>();
  const renderedParts = parts.map((part) => {
    const record = asRecord(part);
    if (!String(record?.type).includes("tool-call")) return { part };
    const toolCallId = typeof record?.toolCallId === "string" ? record.toolCallId : undefined;
    const toolName = typeof record?.toolName === "string" ? record.toolName : undefined;
    const tool =
      tools.find((candidate) => candidate.toolCallId === toolCallId) ??
      tools.find(
        (candidate) =>
          !usedToolIds.has(candidate._id) && (candidate.toolName ?? candidate.name) === toolName,
      );
    if (tool) usedToolIds.add(tool._id);
    return { part, tool };
  });
  const unmatchedTools = tools.filter((tool) => !usedToolIds.has(tool._id));

  return (
    <div className="flex flex-col gap-2">
      {renderedParts.map(({ part, tool }, index) => (
        <OutputPart key={index} value={part} tool={tool} />
      ))}
      {unmatchedTools.map((tool) => (
        <ToolResult key={tool._id} tool={tool} />
      ))}
    </div>
  );
}

function OutputPart({ value, tool }: { value: unknown; tool?: Span }) {
  const [open, setOpen] = useState(false);
  const part = asRecord(value);
  const type = typeof part?.type === "string" ? part.type : "text";
  const isReasoning = type.includes("reasoning");
  const isToolCall = type.includes("tool-call");
  const isToolResult = type.includes("tool-result");
  const isTool = isToolCall || isToolResult;
  const failed = tool?.status === "error";
  const label = isReasoning
    ? "Thinking"
    : isToolResult
      ? `${String(part?.toolName ?? "Tool")} result`
      : isToolCall
        ? String(part?.toolName ?? "Tool")
        : "Text";
  const output = asRecord(part?.output);
  const content = isToolCall
    ? (part?.input ?? part?.args)
    : isToolResult
      ? (output?.value ?? part?.output)
      : (part?.text ?? value);
  const PartIcon = isReasoning
    ? BrainCircuitIcon
    : isToolResult
      ? CircleCheckIcon
      : isToolCall
        ? WrenchIcon
        : TextIcon;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-md border text-xs",
        failed && "border-destructive/30 bg-destructive/5 text-destructive",
        isReasoning &&
          !failed &&
          "border-telemetry-thinking/35 bg-telemetry-thinking/10 text-telemetry-thinking",
        isToolCall &&
          !failed &&
          "border-telemetry-tool/35 bg-telemetry-tool/10 text-telemetry-tool",
        isToolResult &&
          !failed &&
          "border-telemetry-tool/35 bg-telemetry-tool/10 text-telemetry-tool",
        !isReasoning &&
          !isTool &&
          !failed &&
          "border-telemetry-system/35 bg-telemetry-system/10 text-telemetry-system",
      )}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
        <PartIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-mono text-[10px] font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] opacity-75">
          {typeof content === "string" ? content : compactJson(content)}
        </span>
        {tool && (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
            {formatTelemetryDuration(tool.durationMs)}
          </span>
        )}
        <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t border-current/10">
        {isToolCall ? (
          <div className={cn("grid gap-2 p-3", tool && "sm:grid-cols-2")}>
            <JsonSection label="Input" value={content} />
            {tool && (
              <JsonSection
                label={failed ? "Error" : "Output"}
                value={
                  tool.error ??
                  (tool.outputJson ? parseJson(tool.outputJson) : "No output payload was recorded.")
                }
                destructive={failed}
              />
            )}
          </div>
        ) : (
          <div className="px-3 py-2.5">
            {typeof content === "string" ? (
              <p className="whitespace-pre-wrap leading-relaxed">{content}</p>
            ) : (
              <JsonBlock value={content} />
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolResult({ tool }: { tool: Span }) {
  const [expanded, setExpanded] = useState(false);
  const result = tool.error ?? tool.outputJson;
  const failed = tool.status === "error";
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className={cn(
        "overflow-hidden rounded-md border",
        failed
          ? "border-destructive/30 bg-destructive/5"
          : "border-telemetry-tool/35 bg-telemetry-tool/10",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[10px]",
          failed ? "text-destructive" : "text-telemetry-tool",
        )}
      >
        {failed ? (
          <CircleAlertIcon className="size-3.5" />
        ) : (
          <CircleCheckIcon className="size-3.5" />
        )}
        <span className="truncate">
          {tool.toolName ?? tool.name} {failed ? "failed" : "completed"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {formatTelemetryDuration(tool.durationMs)}
        </span>
        <ChevronDownIcon className="size-3 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t border-current/10">
        <div className="grid gap-2 p-3 sm:grid-cols-2">
          <JsonSection
            label="Arguments"
            value={tool.inputJson ? parseJson(tool.inputJson) : "No argument payload was recorded."}
          />
          <JsonSection
            label={failed ? "Error" : "Result"}
            value={result ? parseJson(result) : "No result payload was recorded."}
            destructive={failed}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ErrorOutput({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-md border border-destructive/30 bg-destructive/5 font-mono text-xs text-destructive"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
        <CircleAlertIcon className="size-3.5" /> Error
        {!open && <span className="min-w-0 flex-1 truncate text-[10px] opacity-80">{message}</span>}
        <ChevronDownIcon className="ml-auto size-3 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t border-destructive/20">
        <p className="whitespace-pre-wrap px-3 py-3 leading-relaxed">{message}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function InputSummary({ value }: { value?: string }) {
  const parsed = parseJson(value);
  const prompt = asRecord(parsed);
  const messages = Array.isArray(prompt?.messages) ? prompt.messages : [];
  const last = [...messages].reverse().find((message) => {
    const role = asRecord(message)?.role;
    return role === "user" || role === "tool" || role === "assistant";
  });
  const record = asRecord(last);
  const role = record?.role;
  const content = record?.content ?? record?.parts ?? last;
  const tools = collectToolNames(content);
  const label = tools.length ? summarizeNames(tools) : (extractText(content) ?? "Prompt");

  return (
    <span className="flex min-w-0 max-w-[40%] items-center gap-1.5 text-xs text-muted-foreground">
      {role === "tool" || tools.length ? (
        <WrenchIcon className="size-3.5 shrink-0" />
      ) : (
        <MessageSquareIcon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

function RunStatus({ status }: { status: TraceResult["trace"]["status"] }) {
  if (status === "ok") return null;
  return <Badge variant={status === "error" ? "destructive" : "outline"}>{status}</Badge>;
}

function RunDetails({ data }: { data: TraceResult }) {
  const [open, setOpen] = useState(false);
  const { trace, completion } = data;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 rounded-xl border bg-card">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground">
        <DatabaseIcon className="size-3.5" />
        Run details
        {completion && (
          <span className="ml-2 font-mono text-[10px]">
            ${completion.response.pricing.cost.toFixed(6)}
          </span>
        )}
        <ChevronDownIcon className="ml-auto size-3.5 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content border-t">
        <div className="grid gap-x-8 gap-y-2 p-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Trace ID" value={trace._id} copy />
          <Detail label="Request ID" value={trace.requestId} copy />
          <Detail label="Call ID" value={trace.callId} copy />
          <Detail label="Function" value={trace.functionId} />
          <Detail label="Operation" value={trace.operationId} />
          <Detail label="Finish reason" value={trace.finishReason ?? "-"} />
          <Detail
            label="Reasoning tokens"
            value={formatTokenCount(trace.usage?.reasoningTokens ?? 0)}
          />
          <Detail label="Cache read" value={formatTokenCount(trace.usage?.cacheReadTokens ?? 0)} />
          <Detail
            label="Cache write"
            value={formatTokenCount(trace.usage?.cacheWriteTokens ?? 0)}
          />
          {completion && <Detail label="Generation ID" value={completion.response.genId} copy />}
          {completion && (
            <Detail label="TTFT" value={formatTelemetryDuration(completion.response.ttft)} />
          )}
          {completion && (
            <Detail
              label="Generation"
              value={formatTelemetryDuration(completion.response.gen_time)}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Detail({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <code className="ml-auto truncate text-[10px]">{value}</code>
      {copy && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard.writeText(value)}
        >
          <CopyIcon />
        </Button>
      )}
    </div>
  );
}

function RawPayload({ value }: { value?: string }) {
  if (!value) return <EmptyPayload label="payload" />;
  return <JsonBlock value={parseJson(value)} />;
}

function EmptyPayload({ label, value }: { label: string; value?: string }) {
  if (value) return <RawPayload value={value} />;
  return (
    <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed px-4 text-center text-xs text-muted-foreground">
      No {label} payload was recorded.
    </div>
  );
}

function InlineJson({ value }: { value: unknown }) {
  return <JsonBlock value={value} />;
}

function JsonSection({
  label,
  value,
  destructive,
}: {
  label: string;
  value: unknown;
  destructive?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "mb-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground",
          destructive && "text-destructive",
        )}
      >
        {label}
      </div>
      <JsonBlock value={value} />
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const code = prettyJson(value);
  return (
    <CodeBlock
      code={code}
      language="json"
      className="bg-background/60 [&_code]:text-[10px]! [&_pre]:p-2.5! [&_pre]:text-[10px]!"
    >
      <CodeBlockCopyButton size="icon-xs" aria-label="Copy JSON" />
    </CodeBlock>
  );
}

function getRoleStyle(role: string) {
  if (role === "system") {
    return {
      icon: ShieldIcon,
      container: "border-telemetry-system/35 bg-telemetry-system/10",
      text: "text-telemetry-system",
    };
  }
  if (role === "user") {
    return {
      icon: UserRoundIcon,
      container: "border-telemetry-user/35 bg-telemetry-user/10",
      text: "text-telemetry-user",
    };
  }
  if (role === "assistant") {
    return {
      icon: BotIcon,
      container: "border-telemetry-assistant/35 bg-telemetry-assistant/10",
      text: "text-telemetry-assistant",
    };
  }
  if (role === "tool") {
    return {
      icon: WrenchIcon,
      container: "border-telemetry-tool/35 bg-telemetry-tool/10",
      text: "text-telemetry-tool",
    };
  }
  return {
    icon: MessageSquareIcon,
    container: "bg-muted/20",
    text: "text-muted-foreground",
  };
}

function summarizeContent(value: unknown): string {
  const tools = collectToolNames(value);
  if (tools.length) return summarizeNames(tools);
  return extractText(value) ?? compactJson(value) ?? "Empty message";
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function buildSteps(spans: Span[]): Step[] {
  const models = spans
    .filter((span) => span.kind === "model")
    .sort((a, b) => a.startedAt - b.startedAt);
  const summaries = spans
    .filter((span) => span.kind === "step")
    .sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
  const tools = spans.filter((span) => span.kind === "tool");

  return models.map((model, index) => {
    const nextStartedAt = models[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
    return {
      model,
      summary: summaries.find((span) => span.stepNumber === index) ?? summaries[index],
      tools: tools.filter(
        (tool) => tool.startedAt >= model.startedAt && tool.startedAt < nextStartedAt,
      ),
    };
  });
}

function summarizeOutput(value: string | undefined, tools: Span[]): string {
  const parsed = parseJson(value);
  const parts = Array.isArray(parsed) ? parsed : asRecord(parsed)?.content;
  const toolNames = collectToolNames(parts);
  if (toolNames.length) return summarizeNames(toolNames);
  if (tools.length) return summarizeNames(tools.map((tool) => tool.toolName ?? tool.name));
  return "Response";
}

function summarizeNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name}${count > 1 ? ` (×${count})` : ""}`).join(", ");
}

function collectToolNames(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    const record = asRecord(item);
    const type = typeof record?.type === "string" ? record.type : "";
    if (type.includes("tool") && typeof record?.toolName === "string") return [record.toolName];
    if (type.startsWith("tool-") && type !== "tool-call" && type !== "tool-result") {
      return [type.slice("tool-".length)];
    }
    return [];
  });
}

function getRunTitle(
  rootInput: string | undefined,
  modelInput: string | undefined,
): string | undefined {
  for (const value of [rootInput, modelInput]) {
    const prompt = asRecord(parseJson(value));
    const messages = Array.isArray(prompt?.messages) ? prompt.messages : [];
    const userMessage = [...messages]
      .reverse()
      .find((message) => asRecord(message)?.role === "user");
    const userRecord = asRecord(userMessage);
    const text = extractText(userRecord?.content ?? userRecord?.parts);
    if (text) return text;
  }
  return undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map(extractText).filter(Boolean).join(" ");
    return text || undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.text === "string") return record.text;
  return extractText(record.content ?? record.parts);
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return repairTruncatedJson(value) ?? value;
  }
}

function repairTruncatedJson(value: string): unknown | undefined {
  if (!value.endsWith("...")) return undefined;
  const prefix = value.slice(0, -3);
  const commaPositions = structuralCommaPositions(prefix);

  for (const candidate of [
    prefix,
    ...commaPositions.reverse().map((index) => prefix.slice(0, index)),
  ]) {
    const repaired = closeJsonPrefix(candidate);
    if (!repaired) continue;
    try {
      return JSON.parse(repaired);
    } catch {
      // Try the previous complete field or array item.
    }
  }
  return undefined;
}

function structuralCommaPositions(value: string): number[] {
  const positions: number[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === ",") positions.push(index);
  }
  return positions;
}

function closeJsonPrefix(value: string): string | undefined {
  const stack: Array<"}" | "]"> = [];
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === "}" || character === "]") {
      if (stack.at(-1) !== character) return undefined;
      stack.pop();
    }
  }

  let repaired = value.trimEnd();
  if (inString) {
    repaired = repaired.replace(/\\u[\da-fA-F]{0,3}$/, "");
    if (repaired.endsWith("\\")) repaired = repaired.slice(0, -1);
    repaired += '…"';
  } else if (repaired.endsWith(":")) repaired += "null";
  else if (repaired.endsWith(",")) repaired = repaired.slice(0, -1);

  return repaired + stack.reverse().join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function TelemetryDetailSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-7 w-24" />
      <div className="flex items-center justify-between gap-4 py-2">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="hidden h-4 w-96 md:block" />
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
