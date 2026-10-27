import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "backend/convex/_generated/dataModel";
import { ArrowLeftIcon, ArrowRightIcon, CircleAlertIcon, CopyIcon } from "lucide-react";
import { blobValue } from "backend/src/telemetry/store";

import { AgentStatus, type RunState } from "@/components/agentic/agent-status";
import { Tag } from "@/components/harness/group-list";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "backend/convex/_generated/api";
import { DataSection } from "./data-section";
import { ProviderLogo } from "./provider-logo";
import {
  JsonBlock,
  RequestProviderLogo,
  JsonSection,
  LineageBadge,
  RequestStatusLabel,
  ToolItem,
  type TelemetryBlob,
} from "./telemetry-parts";
import { RequestConversation } from "./telemetry-conversation";
import {
  diffLines,
  diffParams,
  formatCost,
  formatTelemetryDate,
  formatTelemetryDuration,
  formatTokenCount,
  systemText,
  type DiffLine,
} from "./telemetry-utils";

type RequestResult = FunctionReturnType<typeof api.observability.telemetry.getRequest>;

export function TelemetryDetail({ requestId }: { requestId: Id<"telemetry_requests"> }) {
  const { data, error } = useQuery(
    convexQuery(api.observability.telemetry.getRequest, { request: requestId }),
  );

  if (error) {
    return (
      <>
        <WorkspacePageHeader title="Request" action={<AllRequestsLink />} />
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load request</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </>
    );
  }

  if (data === undefined) return <TelemetryDetailSkeleton />;

  const { request, summary } = data;

  return (
    <>
      <WorkspacePageHeader
        title={request.model}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
            <RequestProviderLogo slug={request.provider} className="size-3.5" />
            <span>{request.provider ?? "no provider"}</span>
            <span>·</span>
            <span>{request.stream ? "streamed" : "non-streamed"}</span>
            <span>·</span>
            <time dateTime={new Date(request.startedAt).toISOString()}>
              {formatTelemetryDate(request.startedAt)}
            </time>
          </span>
        }
        action={
          <>
            <RequestStatusLabel status={request.status} />
            <AllRequestsLink />
          </>
        }
      />

      <Lineage data={data} />
      <Overview data={data} cost={summary.cost} />
      {request.error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            Request failed{request.error.status ? ` (${request.error.status})` : ""}
          </AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {request.error.message}
          </AlertDescription>
        </Alert>
      )}
      {data.changes && <Changes data={data} />}
      {data.legacy ? <LegacyPayloads data={data} /> : <RequestConversation data={data} />}
      <ParamsSection params={data.params} headers={data.headers} />
      <Attempts data={data} />
    </>
  );
}

function AllRequestsLink() {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/gateway/telemetry">
        <ArrowLeftIcon data-icon="inline-start" />
        All requests
      </Link>
    </Button>
  );
}

function TelemetryDetailSkeleton() {
  return (
    <>
      <WorkspacePageHeader title="Request" action={<AllRequestsLink />} />
      <Skeleton className="h-24 rounded-2xl" />
      <Skeleton className="h-48 rounded-2xl" />
    </>
  );
}

const lineageDescriptions = {
  root: "First request of this conversation.",
  continue: "Continues the conversation from",
  retry: "Resends exactly the input of",
  rewrite: "Extends the input of",
  branch: "Diverges from an earlier point in the conversation of",
  compacted:
    "Shares no history with earlier requests in this session, so the context was likely compacted or replaced.",
} as const;

function Lineage({ data }: { data: RequestResult }) {
  const { request, related, session } = data;
  const { kind } = request.lineage;
  const rewriteNote =
    kind === "rewrite" ? " The stored output of that request was replaced." : undefined;
  const branchNote =
    kind === "branch"
      ? ` Both branches are kept; this one forks after message ${request.lineage.depth ?? "?"}.`
      : undefined;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 text-sm">
      <LineageBadge lineage={{ ...request.lineage, request: undefined }} />
      <span className="text-muted-foreground">
        {lineageDescriptions[kind]}
        {related && (
          <>
            {" "}
            <Link
              to="/gateway/telemetry/$id"
              params={{ id: related._id }}
              className="text-foreground underline underline-offset-2"
            >
              the request at {formatTelemetryDate(related.startedAt)}
            </Link>
            .
          </>
        )}
        {rewriteNote}
        {branchNote}
      </span>
      {session && (
        <Link
          to="/gateway/telemetry/sessions/$id"
          params={{ id: session._id }}
          className="ml-auto text-sm underline underline-offset-2"
        >
          View session
        </Link>
      )}
    </div>
  );
}

function Overview({ data, cost }: { data: RequestResult; cost: number | undefined }) {
  const { request, session } = data;
  const usage = request.usage;

  return (
    <DataSection
      title="Overview"
      description={cost !== undefined ? `Estimated ${formatCost(cost)}` : undefined}
      contentClassName="grid gap-x-8 gap-y-2 p-4 text-xs sm:grid-cols-2 lg:grid-cols-3"
    >
      <Detail label="Request ID" value={request.requestId} copy />
      <Detail label="Source" value={request.source} />
      <Detail label="Duration" value={formatTelemetryDuration(request.durationMs)} />
      <Detail label="Time to first token" value={formatTelemetryDuration(request.ttftMs)} />
      <Detail label="Generation" value={formatTelemetryDuration(request.generationMs)} />
      <Detail label="Finish reason" value={request.finishReason ?? "–"} />
      <Detail label="Input tokens" value={formatTokenCount(usage?.inputTokens ?? 0)} />
      <Detail label="Output tokens" value={formatTokenCount(usage?.outputTokens ?? 0)} />
      <Detail label="Reasoning tokens" value={formatTokenCount(usage?.reasoningTokens ?? 0)} />
      <Detail label="Cache read" value={formatTokenCount(usage?.cacheReadTokens ?? 0)} />
      <Detail label="Cache write" value={formatTokenCount(usage?.cacheWriteTokens ?? 0)} />
      <Detail label="Cost" value={formatCost(cost)} />
      {request.providerGenerationId && (
        <Detail label="Generation ID" value={request.providerGenerationId} copy />
      )}
      {session && <Detail label="Session" value={session.key} copy />}
      {session?.parentKey && <Detail label="Parent session" value={session.parentKey} copy />}
    </DataSection>
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

function Changes({ data }: { data: RequestResult }) {
  const changes = data.changes!;
  const { system, params, tools, model } = changes;
  const nothing = !system && !params && !tools && !model;

  return (
    <DataSection
      title="Changes"
      description={
        <>
          Compared with{" "}
          <Link
            to="/gateway/telemetry/$id"
            params={{ id: changes.previous }}
            className="text-foreground underline underline-offset-2"
          >
            the previous request
          </Link>{" "}
          in this session.
        </>
      }
      contentClassName="flex flex-col divide-y"
    >
      {nothing && <p className="p-4 text-sm text-muted-foreground">No configuration changed.</p>}
      {model && (
        <ChangeBlock title="Model">
          <p className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span className="text-destructive line-through">{model.from}</span>
            <ArrowRightIcon className="size-3 text-muted-foreground" />
            <span>{model.to}</span>
          </p>
        </ChangeBlock>
      )}
      {system && (
        <ChangeBlock title="System prompt">
          <SystemDiff from={system.from} to={system.to} />
        </ChangeBlock>
      )}
      {tools && (
        <ChangeBlock title="Tools">
          <ToolChanges tools={tools} />
        </ChangeBlock>
      )}
      {params && (
        <ChangeBlock title="Parameters">
          <ParamsDiff from={params.from} to={params.to} />
        </ChangeBlock>
      )}
    </DataSection>
  );
}

function ChangeBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      {children}
    </div>
  );
}

function SystemDiff({ from, to }: { from: TelemetryBlob | null; to: TelemetryBlob | null }) {
  const unavailable = [from, to].some((blob) => blob && blob.content === undefined);
  if (unavailable) {
    return (
      <p className="text-sm text-muted-foreground">
        The system prompt changed, but its text was not recorded, so no line diff is available.
      </p>
    );
  }
  const lines = diffLines(
    from ? systemText(blobValue(from)) : "",
    to ? systemText(blobValue(to)) : "",
  );
  return <DiffView lines={lines} />;
}

const diffStyles: Record<DiffLine["kind"], { marker: string; row: string }> = {
  same: { marker: " ", row: "text-muted-foreground" },
  add: { marker: "+", row: "bg-telemetry-assistant/10 text-telemetry-assistant" },
  remove: { marker: "−", row: "bg-destructive/10 text-destructive" },
};

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-xl border bg-muted/20 py-2 font-mono text-xs leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className={cn("flex gap-2 px-3", diffStyles[line.kind].row)}>
          <span aria-hidden="true" className="w-3 shrink-0 select-none">
            {diffStyles[line.kind].marker}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{line.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

type ToolChangeData = NonNullable<NonNullable<RequestResult["changes"]>["tools"]>;

function ToolChanges({ tools }: { tools: ToolChangeData }) {
  const { added, removed, changed, reordered } = tools;
  return (
    <div className="flex flex-col gap-2">
      {added.map((tool) => (
        <ToolItem key={`a-${tool.name}`} name={tool.name} blob={tool.blob} badge="added" />
      ))}
      {removed.map((tool) => (
        <ToolItem key={`r-${tool.name}`} name={tool.name} blob={tool.blob} badge="removed" />
      ))}
      {changed.map((tool) => (
        <ToolItem
          key={`c-${tool.name}`}
          name={tool.name}
          blob={tool.after}
          before={tool.before}
          badge="changed"
        />
      ))}
      {reordered && <p className="text-sm text-muted-foreground">The tool order changed.</p>}
    </div>
  );
}

function ParamsDiff({ from, to }: { from: TelemetryBlob | null; to: TelemetryBlob | null }) {
  const changes = diffParams(blobValue(from), blobValue(to));
  if (changes.length === 0) {
    return <p className="text-sm text-muted-foreground">Only the parameter fingerprint changed.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {changes.map((change) => (
        <li
          key={change.key}
          className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs"
        >
          <Tag>{change.kind}</Tag>
          <span className="font-medium">{change.key}</span>
          {change.kind !== "added" && (
            <span className="max-w-64 truncate text-destructive line-through">
              {inline(change.before)}
            </span>
          )}
          {change.kind === "changed" && <ArrowRightIcon className="size-3 text-muted-foreground" />}
          {change.kind !== "removed" && (
            <span className="max-w-64 truncate">{inline(change.after)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function inline(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function ParamsSection({
  params,
  headers,
}: {
  params: TelemetryBlob | null;
  headers: TelemetryBlob | null;
}) {
  return (
    <>
      <DataSection
        title="Parameters"
        description="The request body without messages and tools."
        contentClassName="p-3"
      >
        {params?.content !== undefined ? (
          <JsonBlock value={blobValue(params)} />
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground">No parameters were captured.</p>
        )}
      </DataSection>
      <DataSection
        title="Headers"
        description="Allowlisted client headers. Credentials are never stored."
        contentClassName="p-3"
      >
        {headers?.content !== undefined ? (
          <JsonBlock value={blobValue(headers)} />
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground">No headers were captured.</p>
        )}
      </DataSection>
    </>
  );
}

const attemptStates: Record<"ok" | "error" | "aborted", RunState> = {
  ok: "succeeded",
  error: "failed",
  aborted: "cancelled",
};

function Attempts({ data }: { data: RequestResult }) {
  const { request } = data;
  if (request.attempts.length === 0) return null;

  return (
    <DataSection
      title="Routing attempts"
      description="Each provider and credential Gateway tried, in order."
      contentClassName="flex flex-col"
    >
      {request.attempts.map((attempt, index) => (
        <div key={index} className="flex flex-col gap-1 border-b px-4 py-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="w-4 font-mono text-[11px] text-muted-foreground">{index + 1}</span>
            <AgentStatus state={attemptStates[attempt.outcome]} label={attempt.outcome} />
            <span className="flex items-center gap-1.5 font-medium">
              <ProviderLogo slug={attempt.provider} className="size-4" />
              {attempt.provider}
            </span>
            {attempt.providerModel && (
              <span className="font-mono text-xs text-muted-foreground">
                {attempt.providerModel}
              </span>
            )}
            <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
              +{formatTelemetryDuration(Math.max(0, attempt.startedAt - request.startedAt))} ·{" "}
              {formatTelemetryDuration(attempt.durationMs)}
            </span>
          </div>
          {(attempt.status !== undefined || attempt.errorKind || attempt.message) && (
            <p className="pl-7 font-mono text-xs text-muted-foreground">
              {[attempt.status, attempt.errorKind, attempt.message].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      ))}
    </DataSection>
  );
}

/** Requests migrated from the old AI SDK telemetry keep their payloads as opaque JSON. */
function LegacyPayloads({ data }: { data: RequestResult }) {
  const legacy = data.legacy!;
  const payloads = [
    { label: "Input", blob: legacy.input },
    { label: "Output", blob: legacy.output },
    { label: "Spans", blob: legacy.spans },
  ].filter((item): item is { label: string; blob: TelemetryBlob } => item.blob !== null);

  return (
    <DataSection
      title="Imported payloads"
      description={`Imported from AI SDK trace ${legacy.traceId}. These requests predate conversation tracking, so messages, tools, and lineage are unavailable.`}
      contentClassName="flex flex-col gap-3 p-3"
    >
      {payloads.length === 0 && (
        <p className="px-1 py-2 text-sm text-muted-foreground">No payloads were recorded.</p>
      )}
      {payloads.map(({ label, blob }) => (
        <div key={label} className="flex flex-col gap-1.5">
          {blob.truncated && (
            <Tag className="self-start">truncated at the old 32,000-character limit</Tag>
          )}
          {blob.content !== undefined ? (
            <JsonSection label={label} value={blobValue(blob)} />
          ) : (
            <p className="text-xs text-muted-foreground">{label} was not recorded.</p>
          )}
        </div>
      ))}
    </DataSection>
  );
}
