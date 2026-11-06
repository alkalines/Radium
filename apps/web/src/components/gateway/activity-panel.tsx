import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import type { FunctionReturnType } from "convex/server";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BlocksIcon,
  BotIcon,
  BracesIcon,
  CircleDollarSignIcon,
  DatabaseZapIcon,
  FolderIcon,
  RouteIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";

import { GroupList, Row } from "@/components/harness/group-list";
import { ProjectGlyph } from "@/components/projects/project-glyph";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { formatRelativeTime } from "@/components/home/recency";
import { useWorkerPresenceClock } from "@/components/workspaces/worker-presence";
import { DataSection } from "./data-section";
import { formatCurrency } from "./telemetry-utils";

type Activity = FunctionReturnType<typeof api.observability.usage.getActivity>;

/**
 * `all` adds the ACP agent turns Workers report to the Gateway's own traffic; `gateway` shows only
 * what passed through the Gateway. The choice is client state kept in this browser.
 */
type ActivitySources = "all" | "gateway";

const SOURCES_STORAGE_KEY = "radium.activity.sources.v1";
const ALL_PROJECTS = "all";

const DAY = 24 * 60 * 60 * 1000;
const RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

const dailyCostConfig = {
  gatewayCost: { label: "Gateway", color: "var(--chart-3)" },
  agentCost: { label: "ACP", color: "var(--chart-1)" },
} satisfies ChartConfig;

const usageTypeConfig = {
  requests: { label: "Requests" },
  byok: { label: "BYOK", color: "var(--chart-2)" },
  legacyCredits: { label: "Historical credits", color: "var(--chart-4)" },
} satisfies ChartConfig;

const tokenConfig = {
  prompt: { label: "Prompt", color: "var(--chart-1)" },
  completion: { label: "Completion", color: "var(--chart-3)" },
  reasoning: { label: "Reasoning", color: "var(--chart-5)" },
} satisfies ChartConfig;

const cachingConfig = {
  cached: { label: "Cached", color: "var(--chart-2)" },
  uncached: { label: "Uncached", color: "var(--chart-4)" },
} satisfies ChartConfig;

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatDay(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function readSources(): ActivitySources {
  try {
    return window.localStorage.getItem(SOURCES_STORAGE_KEY) === "gateway" ? "gateway" : "all";
  } catch {
    return "all";
  }
}

/** `1 request`, `2 ACP turns`. */
function count(value: number, noun: string) {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

/** "3 requests · 2 ACP turns · 1 local session", leaving out zero parts. */
function countLabel(requests: number, turns: number, sessions: number) {
  const parts = [];
  if (requests || (!turns && !sessions)) parts.push(count(requests, "request"));
  if (turns) parts.push(count(turns, "ACP turn"));
  if (sessions) parts.push(count(sessions, "local session"));
  return parts.join(" · ");
}

/**
 * Workspace usage: Gateway traffic plus, unless the owner narrows it to the Gateway, the turns of
 * ACP agents running on Workers, broken down by harness, Project and model. `project` (a Project
 * id or `none` for unfiled sessions) comes from the URL so Home can link to one Project's usage.
 */
export function ActivityPanel({
  project,
  onProjectChange,
}: {
  project?: string;
  onProjectChange: (project: string | undefined) => void;
}) {
  const [range, setRange] = useState("30");
  const [sources, setSources] = useState<ActivitySources>("all");
  useEffect(() => setSources(readSources()), []);
  const since = useMemo(() => Date.now() - Number(range) * DAY, [range]);
  const { workspaceId } = useWorkspace();
  const { data: projects } = useQuery(
    convexQuery(api.projects.list, workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const projectFilter =
    project === "none" || projects?.some((candidate) => candidate._id === project)
      ? (project as Id<"projects"> | "none")
      : undefined;
  const { data: activity } = useQuery(
    convexQuery(
      api.observability.usage.getActivity,
      workspaceId
        ? {
            workspace: workspaceId,
            since,
            sources,
            ...(projectFilter ? { project: projectFilter } : {}),
          }
        : "skip",
    ),
  );

  function changeSources(value: ActivitySources) {
    setSources(value);
    try {
      window.localStorage.setItem(SOURCES_STORAGE_KEY, value);
    } catch {
      // Storage can be unavailable (private mode, blocked site data); the choice lasts the visit.
    }
  }

  const includeAgents = sources === "all";
  const cacheHitRate = activity?.summary.promptTokens
    ? (activity.summary.cachedTokens / activity.summary.promptTokens) * 100
    : 0;
  const totalTokens = activity
    ? activity.summary.promptTokens + activity.summary.completionTokens
    : 0;

  return (
    <>
      <WorkspacePageHeader
        title="Activity"
        description={
          includeAgents
            ? "Estimated cost, traffic, and tokens across the Gateway, ACP agents, and coding CLIs on your Workers."
            : "Estimated cost, traffic, and tokens of requests through the Radium Gateway."
        }
        action={
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="w-40" size="sm" aria-label="Activity date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
      />

      {/* Filters sit on their own row so the workspace title is never squeezed. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={sources} onValueChange={(value) => changeSources(value as ActivitySources)}>
          <SelectTrigger className="w-56" size="sm" aria-label="Activity sources">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">Gateway, ACP and CLIs</SelectItem>
              <SelectItem value="gateway">Gateway only</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {projects && projects.length > 0 && (
          <Select
            value={projectFilter ?? ALL_PROJECTS}
            onValueChange={(value) => onProjectChange(value === ALL_PROJECTS ? undefined : value)}
          >
            <SelectTrigger className="w-48" size="sm" aria-label="Activity Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                <SelectItem value="none">No project</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                {projects.map((candidate) => (
                  <SelectItem key={candidate._id} value={candidate._id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>

      {includeAgents && workspaceId ? <LocalUsageStatus workspaceId={workspaceId} /> : null}

      {!workspaceId && (
        <Alert>
          <AlertTitle>No workspace selected</AlertTitle>
          <AlertDescription>Create a workspace to record gateway activity.</AlertDescription>
        </Alert>
      )}

      {workspaceId && activity === undefined ? (
        <ActivitySkeleton />
      ) : activity ? (
        <>
          {activity.truncated && (
            <Alert>
              <AlertTitle>High-volume window</AlertTitle>
              <AlertDescription>
                This view includes the 2,000 most recent requests, ACP turns and local session days
                in the selected period.
              </AlertDescription>
            </Alert>
          )}

          <DataSection
            title="Summary"
            contentClassName="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4"
          >
            <CostMetric summary={activity.summary} includeAgents={includeAgents} range={range} />
            <Metric
              title="Requests"
              value={formatCompact(activity.summary.requests)}
              detail={
                includeAgents
                  ? [
                      count(activity.summary.agentTurns, "ACP turn"),
                      count(activity.summary.localSessions, "local session"),
                    ].join(" · ")
                  : `${(activity.summary.requests / Number(range)).toFixed(1)} daily average`
              }
              icon={ActivityIcon}
            />
            <Metric
              title="Token volume"
              value={formatCompact(totalTokens)}
              detail={`${formatCompact(activity.summary.promptTokens)} prompt tokens`}
              icon={BracesIcon}
            />
            <Metric
              title="Cache hit rate"
              value={`${cacheHitRate.toFixed(1)}%`}
              detail={`${formatCompact(activity.summary.cachedTokens)} cached tokens`}
              icon={DatabaseZapIcon}
            />
          </DataSection>

          <div className="grid gap-6 xl:grid-cols-5">
            <DailyCostChart data={activity.daily} includeAgents={includeAgents} />
            <UsageTypeChart usageTypes={activity.usageTypes} />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <BreakdownCard
              title="Cost by harness"
              description="The built-in Radium agent, Gateway API clients, and each agent, wherever its sessions ran"
              empty="Usage will appear here once a harness runs."
              rows={activity.harnesses.map((harness) => ({
                id: harness.id,
                leading: harness.kind === "agent" ? <BotIcon /> : <RouteIcon />,
                name: harness.name,
                cost: harness.cost,
                detail: countLabel(harness.requests, harness.turns, harness.sessions),
              }))}
            />
            <BreakdownCard
              title="Cost by project"
              description="Sessions follow their current Project; CLI sessions their folder"
              empty="Usage will appear here once a session runs."
              rows={activity.projects.map((entry) => ({
                id: entry.id,
                leading:
                  entry.id === "none" || entry.id === "outside" ? (
                    <FolderIcon />
                  ) : (
                    <ProjectGlyph
                      project={{ color: entry.color, icon: entry.icon }}
                      className="size-4"
                    />
                  ),
                name: entry.name,
                cost: entry.cost,
                detail: countLabel(entry.requests, entry.turns, entry.sessions),
              }))}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <ModelUsageChart models={activity.models} />
            <ModelVolumeChart daily={activity.daily} models={activity.models} />
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <TokenBreakdownCard summary={activity.summary} />
            <PromptCachingCard summary={activity.summary} hitRate={cacheHitRate} />
            <BreakdownCard
              title="Top API keys"
              description="Ranked by request volume; cost excludes requests with unknown prices"
              empty="Requests from API keys will appear here."
              rows={activity.apiKeys.map((key) => ({
                id: key.id,
                name: key.name,
                cost: key.cost,
                detail: count(key.requests, "request"),
                weight: key.requests,
              }))}
            />
          </div>

          <GroupList>
            <Row
              icon={BlocksIcon}
              title="Top Apps"
              tag="Planned"
              description="Attribute gateway requests to products, agents, and environments."
            />
          </GroupList>
        </>
      ) : null}
    </>
  );
}

/**
 * Where local CLI usage comes from: each Worker's last ccusage sync, or the error that stopped it.
 * Workers re-read their logs every 15 minutes, so Radium's own priced turns fill the gap until then.
 */
function LocalUsageStatus({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const now = useWorkerPresenceClock();
  const { data: syncs } = useQuery(
    convexQuery(api.agent_usage.LocalUsageSyncs, { workspace: workspaceId }),
  );
  const { data: workers } = useQuery(convexQuery(api.workers.list, { workspace: workspaceId }));
  if (!syncs || now === 0) return null;
  const names = new Map((workers ?? []).map((worker) => [worker.workerId, worker.name]));

  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <TerminalIcon className="size-3.5" />
        Local CLI usage from ccusage
      </span>
      {syncs.length === 0 ? (
        <span>No Worker has uploaded yet.</span>
      ) : (
        syncs.map((sync) => {
          const age = formatRelativeTime(sync.lastSyncAt, now);
          return (
            <span key={sync.worker} title={sync.error}>
              {names.get(sync.worker) ?? "Removed Worker"}:{" "}
              {sync.error ? "sync failed" : `synced ${age === "now" ? "just now" : `${age} ago`}`}
            </span>
          );
        })
      )}
    </p>
  );
}

/** Known cost with what it leaves out: unpriced requests, turns or local models, and pricing turns. */
function CostMetric({
  summary,
  includeAgents,
  range,
}: {
  summary: Activity["summary"];
  includeAgents: boolean;
  range: string;
}) {
  const unknown = summary.unknownCostRequests + summary.unknownCostTurns;
  let detail = `Across ${range} days`;
  if (includeAgents && (summary.agentTurns > 0 || summary.localSessions > 0)) {
    detail = `Gateway ${formatCurrency(summary.gatewayCost)} · ACP ${formatCurrency(summary.agentCost)}`;
  }
  if (unknown > 0) detail = `${unknown.toLocaleString()} with unknown cost`;
  if (summary.pendingTurns > 0) detail += ` · ${summary.pendingTurns} pricing`;

  return (
    <Metric
      title={
        unknown > 0 ? "Known cost (partial)" : includeAgents ? "Estimated cost" : "Gateway cost"
      }
      value={formatCurrency(summary.spend)}
      detail={detail}
      icon={CircleDollarSignIcon}
    />
  );
}

function Metric({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}) {
  return (
    <div className="flex flex-col gap-1 bg-card p-4">
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        {title}
        <Icon className="size-4" />
      </div>
      <span className="text-xl font-medium tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function DailyCostChart({
  data,
  includeAgents,
}: {
  data: Activity["daily"];
  includeAgents: boolean;
}) {
  return (
    <DataSection
      className="xl:col-span-3"
      contentClassName="p-4"
      title="Known daily cost"
      description={
        includeAgents
          ? "Gateway and ACP costs over the selected period; usage with unknown costs is excluded"
          : "Known upstream costs over the selected period; requests with unknown costs are excluded"
      }
    >
      <ChartContainer config={dailyCostConfig} className="h-64 w-full">
        <AreaChart accessibilityLayer data={data} margin={{ left: 4, right: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            minTickGap={24}
            tickFormatter={formatDay}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) => `$${formatCompact(Number(value))}`}
            width={48}
          />
          <ChartTooltip
            content={<ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />}
          />
          <Area
            dataKey="gatewayCost"
            type="monotone"
            stackId="cost"
            fill="var(--color-gatewayCost)"
            fillOpacity={0.15}
            stroke="var(--color-gatewayCost)"
            strokeWidth={2}
          />
          {includeAgents && (
            <Area
              dataKey="agentCost"
              type="monotone"
              stackId="cost"
              fill="var(--color-agentCost)"
              fillOpacity={0.15}
              stroke="var(--color-agentCost)"
              strokeWidth={2}
            />
          )}
        </AreaChart>
      </ChartContainer>
    </DataSection>
  );
}

function UsageTypeChart({
  usageTypes,
}: {
  usageTypes: {
    byok: { requests: number };
    legacyCredits?: { requests: number };
  };
}) {
  const data = [
    { type: "byok", requests: usageTypes.byok.requests, fill: "var(--color-byok)" },
    {
      type: "legacyCredits",
      requests: usageTypes.legacyCredits?.requests ?? 0,
      fill: "var(--color-legacyCredits)",
    },
  ].filter((entry) => entry.requests > 0);
  const total = data.reduce((sum, entry) => sum + entry.requests, 0);

  return (
    <DataSection
      className="xl:col-span-2"
      contentClassName="flex items-center gap-4 p-4"
      title="Usage source"
      description="All Gateway requests use credentials configured in this workspace."
    >
      <ChartContainer config={usageTypeConfig} className="h-56 min-w-0 flex-1">
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="type" hideLabel />} />
          <Pie data={data} dataKey="requests" nameKey="type" innerRadius={54} outerRadius={78}>
            {data.map((entry) => (
              <Cell key={entry.type} fill={entry.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="flex min-w-28 flex-col gap-3 text-sm">
        {data.map((entry) => (
          <div key={entry.type} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">
              {entry.type === "byok" ? "BYOK" : "Historical credits"}
            </span>
            <span className="font-medium tabular-nums">
              {total ? ((entry.requests / total) * 100).toFixed(1) : "0.0"}%
            </span>
          </div>
        ))}
      </div>
    </DataSection>
  );
}

function ModelUsageChart({ models }: { models: Activity["models"] }) {
  const data = models
    .filter((model) => model.tokens > 0)
    .slice(0, 6)
    .map((model) => ({ ...model, displayName: model.name.slice(0, 24) }));
  const config = { tokens: { label: "Tokens", color: "var(--chart-3)" } } satisfies ChartConfig;

  return (
    <DataSection
      contentClassName="p-4"
      title="Usage by model"
      description="Token volume across your most-used models"
    >
      <ChartContainer config={config} className="h-72 w-full">
        <BarChart accessibilityLayer data={data} layout="vertical" margin={{ left: 8, right: 12 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" axisLine={false} tickLine={false} tickFormatter={formatCompact} />
          <YAxis
            type="category"
            dataKey="displayName"
            axisLine={false}
            tickLine={false}
            width={118}
            tick={{ fontSize: 11 }}
          />
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Bar dataKey="tokens" fill="var(--color-tokens)" radius={4} />
        </BarChart>
      </ChartContainer>
    </DataSection>
  );
}

function ModelVolumeChart({
  daily,
  models,
}: {
  daily: Activity["daily"];
  models: Activity["models"];
}) {
  // Model keys (`agent:…`, `slug:author/model`) are not valid CSS custom property names, so the
  // chart's series use positional keys.
  const topModels = models.slice(0, 5).map((model, index) => ({ ...model, key: `m${index}` }));
  const data = daily.map((day) => ({
    date: day.date,
    ...Object.fromEntries(topModels.map((model) => [model.key, day.models[model.id] ?? 0])),
  }));
  const config = Object.fromEntries(
    topModels.map((model, index) => [
      model.key,
      { label: model.name, color: `var(--chart-${index + 1})` },
    ]),
  ) satisfies ChartConfig;

  return (
    <DataSection
      contentClassName="p-4"
      title="Volume by model"
      description="Daily requests and ACP turns for the top five models"
    >
      <ChartContainer config={config} className="h-72 w-full">
        <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            axisLine={false}
            tickLine={false}
            minTickGap={24}
            tickFormatter={formatDay}
          />
          <YAxis axisLine={false} tickLine={false} width={32} allowDecimals={false} />
          <ChartTooltip
            content={<ChartTooltipContent labelFormatter={(label) => formatDay(String(label))} />}
          />
          {topModels.map((model, index) => (
            <Bar
              key={model.key}
              dataKey={model.key}
              stackId="volume"
              fill={`var(--color-${model.key})`}
              radius={index === topModels.length - 1 ? [3, 3, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </DataSection>
  );
}

function TokenBreakdownCard({ summary }: { summary: Activity["summary"] }) {
  const data = [
    {
      name: "Tokens",
      prompt: summary.promptTokens,
      completion: Math.max(0, summary.completionTokens - summary.reasoningTokens),
      reasoning: summary.reasoningTokens,
    },
  ];

  return (
    <DataSection
      contentClassName="flex flex-col gap-5 p-4"
      title="Token breakdown"
      description="Prompt and generated token composition"
    >
      <ChartContainer config={tokenConfig} className="h-24 w-full">
        <BarChart accessibilityLayer data={data} layout="vertical">
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" hide />
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Bar dataKey="prompt" stackId="tokens" fill="var(--color-prompt)" radius={[4, 0, 0, 4]} />
          <Bar dataKey="completion" stackId="tokens" fill="var(--color-completion)" />
          <Bar
            dataKey="reasoning"
            stackId="tokens"
            fill="var(--color-reasoning)"
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ChartContainer>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <BreakdownValue label="Prompt" value={summary.promptTokens} />
        <BreakdownValue
          label="Completion"
          value={Math.max(0, summary.completionTokens - summary.reasoningTokens)}
        />
        <BreakdownValue label="Reasoning" value={summary.reasoningTokens} />
      </div>
    </DataSection>
  );
}

function PromptCachingCard({
  summary,
  hitRate,
}: {
  summary: Activity["summary"];
  hitRate: number;
}) {
  const data = [
    {
      name: "Prompt",
      cached: summary.cachedTokens,
      uncached: Math.max(0, summary.promptTokens - summary.cachedTokens),
    },
  ];

  return (
    <DataSection
      contentClassName="flex flex-col gap-5 p-4"
      title="Prompt token caching"
      description="How much prompt context was served from cache"
    >
      <div className="flex items-end justify-between gap-3">
        <span className="text-xl font-medium tabular-nums">{hitRate.toFixed(1)}%</span>
        <span className="text-xs text-muted-foreground">
          {formatCompact(summary.writtenCacheTokens)} cache writes
        </span>
      </div>
      <ChartContainer config={cachingConfig} className="h-24 w-full">
        <BarChart accessibilityLayer data={data} layout="vertical">
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" hide />
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Bar dataKey="cached" stackId="cache" fill="var(--color-cached)" radius={[4, 0, 0, 4]} />
          <Bar
            dataKey="uncached"
            stackId="cache"
            fill="var(--color-uncached)"
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ChartContainer>
    </DataSection>
  );
}

/** One ranked row of a breakdown; the bar follows `weight` (default: cost). */
type BreakdownRow = {
  id: string;
  name: string;
  cost: number;
  detail: string;
  leading?: React.ReactNode;
  weight?: number;
};

/** A ranked list with relative bars: harnesses, Projects, API keys. */
function BreakdownCard({
  title,
  description,
  empty,
  rows,
}: {
  title: string;
  description: string;
  empty: string;
  rows: BreakdownRow[];
}) {
  const top = rows.slice(0, 6);
  const max = Math.max(0, ...top.map((row) => row.weight ?? row.cost));

  return (
    <DataSection contentClassName="flex flex-col gap-4 p-4" title={title} description={description}>
      {top.length ? (
        top.map((row) => (
          <div key={row.id} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2 font-medium [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
                {row.leading}
                <span className="truncate">{row.name}</span>
              </span>
              <span className="shrink-0 tabular-nums">{formatCurrency(row.cost)}</span>
            </div>
            <Progress value={max ? ((row.weight ?? row.cost) / max) * 100 : 0} />
            {/* Counts sit under the bar so long ones never squeeze the name. */}
            <span className="text-[11px] text-muted-foreground tabular-nums">{row.detail}</span>
          </div>
        ))
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowUpRightIcon className="size-4" />
          {empty}
        </div>
      )}
    </DataSection>
  );
}

function BreakdownValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{formatCompact(value)}</span>
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <>
      <DataSection title="Summary" contentClassName="p-4">
        <Skeleton className="h-16" />
      </DataSection>
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    </>
  );
}
