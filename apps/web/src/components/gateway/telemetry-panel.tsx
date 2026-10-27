import { convexQuery, useConvexAuth } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery } from "convex/react";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BoxIcon,
  BracesIcon,
  CircleAlertIcon,
  Clock3Icon,
  RouteIcon,
  TimerIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useIsHydrated } from "@/components/auth/use-is-hydrated";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { api } from "backend/convex/_generated/api";
import { DataSection } from "./data-section";
import { TelemetryDestinations } from "./telemetry-destinations";
import {
  ChangeTags,
  LineageBadge,
  RequestProviderLogo,
  RequestStatusLabel,
  type RequestRow,
} from "./telemetry-parts";
import {
  formatCost,
  formatTelemetryDate,
  formatTelemetryDuration,
  formatTokenCount,
  type RequestStatusValue,
} from "./telemetry-utils";

type Range = "24h" | "7d" | "30d" | "all";

const ranges: Record<Range, { label: string; days?: number }> = {
  "24h": { label: "Last 24 hours", days: 1 },
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
  all: { label: "All available" },
};

const MAX_RETENTION_DAYS = 3650;
const DEFAULT_CUSTOM_RETENTION_DAYS = 60;
const RETENTION_PRESETS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;

type RecordedContent = "inputs" | "outputs";

const recordedContent: Record<RecordedContent, { label: string; detail: string }> = {
  inputs: {
    label: "Inputs",
    detail: "Prompts, system instructions, tool definitions, and messages",
  },
  outputs: { label: "Outputs", detail: "Model responses, reasoning, and tool calls" },
};

/** Settings write: omitted `retentionDays` keeps the stored value, `null` keeps requests forever. */
type SettingsUpdate = {
  enabled: boolean;
  recordInputs: boolean;
  recordOutputs: boolean;
  retentionDays?: number | null;
};

export function TelemetryPanel() {
  const [now] = useState(() => Date.now());
  const [range, setRange] = useState<Range>("7d");
  const [status, setStatus] = useState<"all" | RequestStatusValue>("all");
  const [model, setModel] = useState("all");
  const [saving, setSaving] = useState(false);
  const isHydrated = useIsHydrated();
  const { isAuthenticated } = useConvexAuth();
  const { workspaceId } = useWorkspace();
  const ready = isHydrated && isAuthenticated && workspaceId !== undefined;
  const { data: settings } = useQuery(
    convexQuery(
      api.observability.telemetry.getSettings,
      ready ? { workspace: workspaceId } : "skip",
    ),
  );
  const setSettings = useMutation(api.observability.telemetry.setSettings);
  const since = ranges[range].days ? now - ranges[range].days! * 86_400_000 : 0;
  const { data: summary } = useQuery(
    convexQuery(
      api.observability.telemetry.getSummary,
      ready ? { workspace: workspaceId, since } : "skip",
    ),
  );

  async function updateSettings(next: SettingsUpdate) {
    if (!workspaceId) return;
    setSaving(true);
    try {
      await setSettings({ workspace: workspaceId, ...next });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update telemetry settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <WorkspacePageHeader
        title="Telemetry"
        description="Every Gateway request, grouped into sessions with conversation lineage and configuration changes."
      />

      <GroupList
        title="Capture"
        description="Gateway requests are recorded only while capture is on. Content is stored once per workspace and never shared across workspaces."
      >
        {settings === undefined ? (
          <RowBlock>
            <Skeleton className="h-6" />
          </RowBlock>
        ) : (
          <>
            <TelemetrySwitch
              title="Capture requests"
              description="Record timings, usage, routing attempts, sessions, and request identifiers."
              checked={settings.enabled}
              disabled={saving}
              onCheckedChange={(enabled) =>
                void updateSettings({
                  ...settings,
                  enabled,
                  recordInputs: enabled && settings.recordInputs,
                  recordOutputs: enabled && settings.recordOutputs,
                })
              }
            />
            <RecordContentRow
              recordInputs={settings.recordInputs}
              recordOutputs={settings.recordOutputs}
              disabled={saving || !settings.enabled}
              onChange={(recorded) => void updateSettings({ ...settings, ...recorded })}
            />
            <RetentionRow
              key={settings.retentionDays ?? "forever"}
              retentionDays={settings.retentionDays}
              disabled={saving}
              onChange={(retentionDays) => void updateSettings({ ...settings, retentionDays })}
            />
          </>
        )}
      </GroupList>

      {!workspaceId && (
        <Alert>
          <AlertTitle>No workspace selected</AlertTitle>
          <AlertDescription>
            Select or create a workspace before requests can be recorded.
          </AlertDescription>
        </Alert>
      )}

      {workspaceId && (
        <>
          <DataSection
            title="Summary"
            contentClassName="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3"
            action={
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
            }
          >
            <Metric
              icon={ActivityIcon}
              label="Requests"
              value={formatTokenCount(summary?.requests ?? 0)}
              detail={summary?.truncated ? "Newest 2,000 in range" : "In the selected range"}
            />
            <Metric
              icon={CircleAlertIcon}
              label="Error rate"
              value={`${((summary?.errorRate ?? 0) * 100).toFixed(1)}%`}
              detail={summary ? `${formatTokenCount(summary.errors)} failed requests` : undefined}
            />
            <Metric
              icon={BracesIcon}
              label="Tokens"
              value={formatTokenCount(summary?.totalTokens ?? 0)}
              detail={
                summary
                  ? `${formatTokenCount(summary.inputTokens)} in · ${formatTokenCount(summary.outputTokens)} out`
                  : undefined
              }
            />
            <Metric
              icon={Clock3Icon}
              label="Latency (median)"
              value={formatTelemetryDuration(summary?.durationP50)}
              detail={`p95 ${formatTelemetryDuration(summary?.durationP95)}`}
            />
            <Metric
              icon={TimerIcon}
              label="Time to first token (median)"
              value={formatTelemetryDuration(summary?.ttftP50)}
              detail={`p95 ${formatTelemetryDuration(summary?.ttftP95)}`}
            />
            <Metric
              icon={BoxIcon}
              label="Top model"
              value={summary?.topModels[0]?.model ?? "—"}
              detail={
                summary?.topModels[0]
                  ? `${formatTokenCount(summary.topModels[0].requests)} requests`
                  : undefined
              }
            />
          </DataSection>

          <Tabs defaultValue="requests" className="gap-4">
            <TabsList>
              <TabsTrigger value="requests">Requests</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
            </TabsList>
            <TabsContent value="requests">
              <RequestsTab
                ready={ready}
                workspaceId={workspaceId}
                status={status}
                model={model}
                models={summary?.topModels.map((item) => item.model) ?? []}
                onStatusChange={setStatus}
                onModelChange={setModel}
              />
            </TabsContent>
            <TabsContent value="sessions">
              <SessionsTab ready={ready} workspaceId={workspaceId} />
            </TabsContent>
          </Tabs>

          <TelemetryDestinations workspaceId={workspaceId} />
        </>
      )}
    </>
  );
}

function TelemetrySwitch({
  title,
  description,
  ...props
}: { title: string; description: string } & React.ComponentProps<typeof Switch>) {
  return (
    <Row title={title} description={description} data-disabled={props.disabled}>
      <Switch aria-label={title} {...props} />
    </Row>
  );
}

/** Content recording as one multi-select: inputs and outputs are independent opt-ins. */
function RecordContentRow({
  recordInputs,
  recordOutputs,
  disabled,
  onChange,
}: {
  recordInputs: boolean;
  recordOutputs: boolean;
  disabled: boolean;
  onChange: (recorded: { recordInputs: boolean; recordOutputs: boolean }) => void;
}) {
  const anchor = useComboboxAnchor();
  const selected: RecordedContent[] = [
    ...(recordInputs ? (["inputs"] as const) : []),
    ...(recordOutputs ? (["outputs"] as const) : []),
  ];

  return (
    <Row
      title="Record content"
      description={
        selected.length === 0
          ? "Only fingerprints, metadata, and conversation shape are kept."
          : selected.map((item) => recordedContent[item].detail).join(" · ")
      }
      data-disabled={disabled}
    >
      <Combobox
        multiple
        items={Object.keys(recordedContent) as RecordedContent[]}
        itemToStringLabel={(item: RecordedContent) => recordedContent[item].label}
        value={selected}
        disabled={disabled}
        onValueChange={(next: RecordedContent[]) =>
          onChange({
            recordInputs: next.includes("inputs"),
            recordOutputs: next.includes("outputs"),
          })
        }
      >
        <ComboboxChips ref={anchor} className="w-48 justify-end">
          <ComboboxValue>
            {(values: RecordedContent[]) => (
              <>
                {values.map((value) => (
                  <ComboboxChip key={value}>{recordedContent[value].label}</ComboboxChip>
                ))}
                <ComboboxChipsInput
                  aria-label="Recorded content"
                  placeholder={values.length === 0 ? "Metadata only" : undefined}
                  readOnly
                  // Selected chips sit flush right; the input only shows the empty-state hint.
                  className={cn("text-right", values.length > 0 && "w-0 min-w-0 flex-none")}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor} align="end" className="w-80">
          <ComboboxList>
            {(item: RecordedContent) => (
              <ComboboxItem key={item} value={item}>
                <div className="flex flex-col">
                  <span>{recordedContent[item].label}</span>
                  <span className="text-xs text-muted-foreground">
                    {recordedContent[item].detail}
                  </span>
                </div>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Row>
  );
}

/**
 * Retention as one choice: a preset window, a custom number of days (1..3650), or keep until
 * deleted. A custom draft commits on blur or Enter.
 */
function RetentionRow({
  retentionDays,
  disabled,
  onChange,
}: {
  retentionDays: number | undefined;
  disabled: boolean;
  onChange: (retentionDays: number | null) => void;
}) {
  const isPreset = RETENTION_PRESETS.some((preset) => preset.days === retentionDays);
  const [custom, setCustom] = useState(retentionDays !== undefined && !isPreset);
  const [draft, setDraft] = useState(String(retentionDays ?? DEFAULT_CUSTOM_RETENTION_DAYS));
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_RETENTION_DAYS;
  const choice = custom
    ? "custom"
    : retentionDays === undefined
      ? "forever"
      : String(retentionDays);

  function commit() {
    if (!valid) {
      setDraft(String(retentionDays ?? DEFAULT_CUSTOM_RETENTION_DAYS));
      return;
    }
    if (parsed !== retentionDays) onChange(parsed);
  }

  function choose(value: string) {
    if (value === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    onChange(value === "forever" ? null : Number(value));
  }

  return (
    <Row
      title="Retention"
      description={
        retentionDays === undefined
          ? "Captured requests are kept until you delete them."
          : `Requests older than ${retentionDays} ${retentionDays === 1 ? "day" : "days"} are deleted automatically.`
      }
      data-disabled={disabled}
    >
      {custom && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_RETENTION_DAYS}
            value={draft}
            disabled={disabled}
            aria-label="Retention in days"
            aria-invalid={!valid}
            className="h-8 w-20 text-right tabular-nums"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="text-sm text-muted-foreground">days</span>
        </div>
      )}
      <Select value={choice} onValueChange={choose} disabled={disabled}>
        <SelectTrigger aria-label="Retention" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {RETENTION_PRESETS.map((preset) => (
              <SelectItem key={preset.days} value={String(preset.days)}>
                Delete after {preset.label}
              </SelectItem>
            ))}
            <SelectItem value="custom">Custom…</SelectItem>
            <SelectItem value="forever">Keep until deleted</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Row>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof ActivityIcon;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-card p-5">
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="truncate">{label}</span>
        <Icon className="size-4 shrink-0" />
      </div>
      <strong className="truncate text-2xl font-medium tabular-nums">{value}</strong>
      <span className="truncate text-xs text-muted-foreground">{detail ?? "\u00a0"}</span>
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

function RequestsTab({
  ready,
  workspaceId,
  status,
  model,
  models,
  onStatusChange,
  onModelChange,
}: {
  ready: boolean;
  workspaceId: Id<"workspaces"> | undefined;
  status: "all" | RequestStatusValue;
  model: string;
  models: string[];
  onStatusChange: (status: "all" | RequestStatusValue) => void;
  onModelChange: (model: string) => void;
}) {
  const {
    results,
    status: pageStatus,
    loadMore,
  } = usePaginatedQuery(
    api.observability.telemetry.listRequests,
    ready && workspaceId
      ? {
          workspace: workspaceId,
          status: status === "all" ? undefined : status,
          model: model === "all" ? undefined : model,
        }
      : "skip",
    { initialNumItems: 25 },
  );
  // A selected model must stay selectable even after it drops out of the summary's top list.
  const modelOptions = model !== "all" && !models.includes(model) ? [model, ...models] : models;

  return (
    <DataSection
      title="Requests"
      description="Newest first. Requests from other users' private chats are never shown."
      contentClassName="overflow-x-auto"
      action={
        <div className="flex flex-wrap gap-2">
          <FilterSelect value={model} onValueChange={onModelChange} label="Model">
            <SelectItem value="all">All models</SelectItem>
            {modelOptions.map((slug) => (
              <SelectItem key={slug} value={slug}>
                {slug}
              </SelectItem>
            ))}
          </FilterSelect>
          <FilterSelect
            value={status}
            onValueChange={(value) => onStatusChange(value as "all" | RequestStatusValue)}
            label="Status"
          >
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ok">Succeeded</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="aborted">Aborted</SelectItem>
          </FilterSelect>
        </div>
      }
    >
      {pageStatus === "LoadingFirstPage" || pageStatus === "LoadingMore" ? (
        results.length === 0 ? (
          <ListSkeleton />
        ) : (
          <RequestTable rows={results} footer={<LoadingMoreRow />} />
        )
      ) : results.length === 0 ? (
        <Empty className="py-14">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RouteIcon />
            </EmptyMedia>
            <EmptyTitle>No requests</EmptyTitle>
            <EmptyDescription>
              {status !== "all" || model !== "all"
                ? "No requests match these filters."
                : "Turn on capture and send a request through the Gateway to start recording."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <RequestTable
          rows={results}
          footer={
            pageStatus === "CanLoadMore" ? <LoadMoreRow onClick={() => loadMore(25)} /> : undefined
          }
        />
      )}
    </DataSection>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-6" />
      <Skeleton className="h-6" />
      <Skeleton className="h-6" />
    </div>
  );
}

function LoadMoreRow({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex justify-center border-t p-2">
      <Button variant="ghost" size="sm" onClick={onClick}>
        Load more
      </Button>
    </div>
  );
}

function LoadingMoreRow() {
  return (
    <div className="border-t p-3">
      <Skeleton className="h-5" />
    </div>
  );
}

function RequestTable({ rows, footer }: { rows: RequestRow[]; footer?: React.ReactNode }) {
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Lineage</TableHead>
            <TableHead className="text-right">Messages</TableHead>
            <TableHead className="text-right">Latency</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((request) => (
            <RequestTableRow key={request._id} request={request} />
          ))}
        </TableBody>
      </Table>
      {footer}
    </>
  );
}

function RequestTableRow({ request }: { request: RequestRow }) {
  return (
    <TableRow className="group">
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatTelemetryDate(request.startedAt)}
      </TableCell>
      <TableCell>
        <RequestStatusLabel status={request.status} />
      </TableCell>
      <TableCell>
        <span className="flex flex-col gap-1">
          <span className="flex items-center gap-2 whitespace-nowrap">
            <RequestProviderLogo slug={request.provider} className="size-4" />
            <span className="font-medium">{request.model}</span>
          </span>
          {request.changedFields.length > 0 && <ChangeTags fields={request.changedFields} />}
        </span>
      </TableCell>
      <TableCell>
        <LineageBadge lineage={request.lineage} />
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {request.inputDepth || "–"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {formatTelemetryDuration(request.durationMs)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {formatTokenCount(request.usage?.totalTokens ?? 0)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {formatCost(request.cost)}
      </TableCell>
      <TableCell>
        <Link
          to="/gateway/telemetry/$id"
          params={{ id: request._id }}
          aria-label={`Inspect request ${request._id}`}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowUpRightIcon className="size-4" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

function SessionsTab({
  ready,
  workspaceId,
}: {
  ready: boolean;
  workspaceId: Id<"workspaces"> | undefined;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.observability.telemetry.listSessions,
    ready && workspaceId ? { workspace: workspaceId } : "skip",
    { initialNumItems: 20 },
  );

  return (
    <DataSection
      title="Sessions"
      description="Requests that share a routing session key, such as one Chatroom chat or one coding-agent run."
      contentClassName="overflow-x-auto"
    >
      {status === "LoadingFirstPage" ? (
        <ListSkeleton />
      ) : results.length === 0 ? (
        <Empty className="py-14">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>No sessions</EmptyTitle>
            <EmptyDescription>Sessions appear after the first captured request.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Last request</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((session) => (
                <TableRow key={session._id}>
                  <TableCell className="max-w-64">
                    <span className="flex flex-col">
                      <span className="truncate font-mono text-xs">{session.key}</span>
                      {session.parentKey && (
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          subagent of {session.parentKey}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatTelemetryDate(session.startedAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatTelemetryDate(session.lastRequestAt)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {session.requestCount}
                    {session.requestCountCapped ? "+" : ""}
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/gateway/telemetry/sessions/$id"
                      params={{ id: session._id }}
                      aria-label={`Open session ${session.key}`}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ArrowUpRightIcon className="size-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {status === "CanLoadMore" && <LoadMoreRow onClick={() => loadMore(20)} />}
          {status === "LoadingMore" && <LoadingMoreRow />}
        </>
      )}
    </DataSection>
  );
}
