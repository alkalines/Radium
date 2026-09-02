import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BracesIcon,
  CheckCircle2Icon,
  Clock3Icon,
  RadioTowerIcon,
  RouteIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "../../../convex/_generated/api";
import { ProviderLogo } from "./provider-logo";
import { formatTelemetryDate, formatTelemetryDuration, formatTokenCount } from "./telemetry-utils";

type Trace = FunctionReturnType<typeof api.telemetry.listTraces>[number];
type TraceStatus = "all" | Trace["status"];
type TraceSource = "all" | Trace["source"];
type Range = "24h" | "7d" | "30d" | "all";

const ranges: Record<Range, { label: string; days?: number }> = {
  "24h": { label: "Last 24 hours", days: 1 },
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
  all: { label: "All available" },
};

export function TelemetryPanel() {
  const [now] = useState(() => Date.now());
  const [range, setRange] = useState<Range>("7d");
  const [status, setStatus] = useState<TraceStatus>("all");
  const [source, setSource] = useState<TraceSource>("all");
  const [saving, setSaving] = useState(false);
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const { data: settings } = useQuery(convexQuery(api.telemetry.getSettings, {}));
  const setSettings = useMutation(api.telemetry.setSettings);
  const since = ranges[range].days ? now - ranges[range].days! * 86_400_000 : undefined;
  const { data: traces, error: tracesError } = useQuery(
    convexQuery(
      api.telemetry.listTraces,
      balanceId ? { balance: balanceId, since, limit: 200 } : "skip",
    ),
  );
  const { data: summary } = useQuery(
    convexQuery(
      api.telemetry.getSummary,
      balanceId ? { balance: balanceId, since: since ?? 0 } : "skip",
    ),
  );
  const filtered = traces?.filter(
    (trace) =>
      (status === "all" || trace.status === status) &&
      (source === "all" || trace.source === source),
  );

  async function updateSettings(next: {
    enabled: boolean;
    recordInputs: boolean;
    recordOutputs: boolean;
  }) {
    setSaving(true);
    try {
      await setSettings(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update telemetry settings.");
    } finally {
      setSaving(false);
    }
  }

  const successRate = summary?.summary.traces
    ? (summary.summary.successful / summary.summary.traces) * 100
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <RadioTowerIcon className="size-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">AI SDK telemetry</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Inspect every model call, step, tool execution, payload, and billed gateway completion.
        </p>
      </header>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Collection</CardTitle>
          <CardDescription>
            Telemetry is private to your account and disabled by default.
          </CardDescription>
          <CardAction>
            <Badge variant={settings?.enabled ? "default" : "outline"}>
              {settings?.enabled ? "Recording" : "Disabled"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          {settings === undefined ? (
            <Skeleton className="h-32" />
          ) : (
            <FieldGroup className="gap-4 md:grid md:grid-cols-3">
              <TelemetrySwitch
                title="Telemetry"
                description="Record timings, usage, spans, and request identifiers."
                checked={settings.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  void updateSettings({
                    enabled,
                    recordInputs: enabled && settings.recordInputs,
                    recordOutputs: enabled && settings.recordOutputs,
                  })
                }
              />
              <TelemetrySwitch
                title="Record inputs"
                description="Persist prompts, messages, and tool arguments."
                checked={settings.recordInputs}
                disabled={saving || !settings.enabled}
                onCheckedChange={(recordInputs) =>
                  void updateSettings({ ...settings, recordInputs })
                }
              />
              <TelemetrySwitch
                title="Record outputs"
                description="Persist model content, tool results, and errors."
                checked={settings.recordOutputs}
                disabled={saving || !settings.enabled}
                onCheckedChange={(recordOutputs) =>
                  void updateSettings({ ...settings, recordOutputs })
                }
              />
            </FieldGroup>
          )}
        </CardContent>
      </Card>

      {!balanceId && userInfo !== undefined && (
        <Alert>
          <AlertTitle>No balance yet</AlertTitle>
          <AlertDescription>
            A balance is required before telemetry traces can be recorded.
          </AlertDescription>
        </Alert>
      )}

      {balanceId && (
        <>
          <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              icon={ActivityIcon}
              label="Requests"
              value={formatTokenCount(summary?.summary.traces ?? 0)}
            />
            <Metric
              icon={CheckCircle2Icon}
              label="Success rate"
              value={`${successRate.toFixed(1)}%`}
            />
            <Metric
              icon={Clock3Icon}
              label="Average latency"
              value={formatTelemetryDuration(summary?.summary.averageDurationMs ?? 0)}
            />
            <Metric
              icon={BracesIcon}
              label="Tokens"
              value={formatTokenCount(summary?.summary.totalTokens ?? 0)}
            />
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold">Request log</h2>
                <p className="text-xs text-muted-foreground">
                  Up to 200 requests in the selected window. Nested gateway calls are grouped into
                  their chatroom request.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 sm:ml-auto">
                <FilterSelect
                  value={range}
                  onValueChange={(value) => setRange(value as Range)}
                  label="Range"
                >
                  {Object.entries(ranges).map(([value, item]) => (
                    <SelectItem key={value} value={value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </FilterSelect>
                <FilterSelect
                  value={source}
                  onValueChange={(value) => setSource(value as TraceSource)}
                  label="Source"
                >
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="chatroom">Chatroom</SelectItem>
                  <SelectItem value="gateway">Gateway</SelectItem>
                </FilterSelect>
                <FilterSelect
                  value={status}
                  onValueChange={(value) => setStatus(value as TraceStatus)}
                  label="Status"
                >
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="ok">Succeeded</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="aborted">Aborted</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                </FilterSelect>
              </div>
            </div>

            {tracesError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not load telemetry</AlertTitle>
                <AlertDescription>{tracesError.message}</AlertDescription>
              </Alert>
            ) : traces === undefined ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
              </div>
            ) : filtered?.length === 0 ? (
              <Empty className="border py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <RouteIcon />
                  </EmptyMedia>
                  <EmptyTitle>No telemetry traces</EmptyTitle>
                  <EmptyDescription>
                    {traces.length
                      ? "No traces match these filters."
                      : "Enable collection and make an AI SDK request to start recording."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Request ID</TableHead>
                      <TableHead>Completion ID</TableHead>
                      <TableHead className="text-right">Latency</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered?.map((trace) => (
                      <TraceRow key={trace._id} trace={trace} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function TelemetrySwitch({
  title,
  description,
  ...props
}: { title: string; description: string } & React.ComponentProps<typeof Switch>) {
  return (
    <Field
      orientation="horizontal"
      data-disabled={props.disabled}
      className="rounded-lg border p-3"
    >
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch aria-label={title} {...props} />
    </Field>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ActivityIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 bg-card p-4">
      <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        <strong className="font-mono text-lg font-medium tabular-nums">{value}</strong>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & React.ComponentProps<typeof Select>) {
  return (
    <Select {...props}>
      <SelectTrigger size="sm" aria-label={label} className="w-auto min-w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>{children}</SelectGroup>
      </SelectContent>
    </Select>
  );
}

function TraceRow({ trace }: { trace: Trace }) {
  return (
    <TableRow className="group">
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatTelemetryDate(trace.startedAt)}
      </TableCell>
      <TableCell>
        <StatusBadge status={trace.status} />
      </TableCell>
      <TableCell>
        <Badge variant="outline">{trace.source}</Badge>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2 whitespace-nowrap">
          <ProviderLogo slug={trace.provider} className="size-4" />
          <span className="font-medium">{trace.model}</span>
        </span>
      </TableCell>
      <TableCell className="max-w-36 truncate font-mono text-xs text-muted-foreground">
        {trace.requestId}
      </TableCell>
      <TableCell className="max-w-36 truncate font-mono text-xs text-muted-foreground">
        {trace.chatCompletionId ?? "Not billed"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {formatTelemetryDuration(trace.durationMs)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {formatTokenCount(trace.usage?.totalTokens ?? 0)}
      </TableCell>
      <TableCell>
        <Link
          to="/gateway/telemetry/$id"
          params={{ id: trace._id }}
          aria-label={`Inspect trace ${trace._id}`}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowUpRightIcon className="size-4" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

export function StatusBadge({ status }: { status: Trace["status"] }) {
  const variant = status === "error" ? "destructive" : status === "ok" ? "secondary" : "outline";
  return <Badge variant={variant}>{status === "ok" ? "success" : status}</Badge>;
}
