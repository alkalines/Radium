import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BlocksIcon,
  BracesIcon,
  CircleDollarSignIcon,
  DatabaseZapIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
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
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "backend/convex/_generated/api";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { DataSection } from "./data-section";

const DAY = 24 * 60 * 60 * 1000;
const RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

const dailyCostConfig = {
  cost: { label: "Known cost", color: "var(--chart-3)" },
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

function formatCurrency(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

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

export function ActivityPanel() {
  const [range, setRange] = useState("30");
  const since = useMemo(() => Date.now() - Number(range) * DAY, [range]);
  const { workspaceId } = useWorkspace();
  const { data: activity } = useQuery(
    convexQuery(
      api.observability.usage.getActivity,
      workspaceId ? { workspace: workspaceId, since } : "skip",
    ),
  );

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
        description="Gateway cost, traffic, and token behavior across your Radium Gateway."
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
                This view includes the 2,000 most recent requests in the selected period.
              </AlertDescription>
            </Alert>
          )}

          <DataSection
            title="Summary"
            contentClassName="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4"
          >
            <Metric
              title={activity.summary.unknownCostRequests > 0 ? "Known cost (partial)" : "Gateway cost"}
              value={formatCurrency(activity.summary.spend)}
              detail={activity.summary.unknownCostRequests > 0
                ? `${activity.summary.unknownCostRequests} requests with unknown cost`
                : `Across ${range} days`}
              icon={CircleDollarSignIcon}
            />
            <Metric
              title="Requests"
              value={formatCompact(activity.summary.requests)}
              detail={`${(activity.summary.requests / Number(range)).toFixed(1)} daily average`}
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
            <DailyCostChart data={activity.daily} />
            <UsageTypeChart usageTypes={activity.usageTypes} />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <ModelUsageChart models={activity.models} />
            <RequestVolumeChart daily={activity.daily} models={activity.models} />
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <TokenBreakdownCard summary={activity.summary} />
            <PromptCachingCard summary={activity.summary} hitRate={cacheHitRate} />
            <TopKeysCard keys={activity.apiKeys} />
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

function DailyCostChart({ data }: { data: Array<{ date: string; cost: number }> }) {
  return (
    <DataSection
      className="xl:col-span-3"
      contentClassName="p-4"
      title="Known daily cost"
      description="Known upstream costs over the selected period; requests with unknown costs are excluded"
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
            dataKey="cost"
            type="monotone"
            fill="var(--color-cost)"
            fillOpacity={0.15}
            stroke="var(--color-cost)"
            strokeWidth={2}
          />
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
      description="All requests use credentials configured in this workspace."
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

function ModelUsageChart({
  models,
}: {
  models: Array<{ id: string; name: string; tokens: number }>;
}) {
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

function RequestVolumeChart({
  daily,
  models,
}: {
  daily: Array<{ date: string; models: Record<string, number> }>;
  models: Array<{ id: string; name: string }>;
}) {
  const topModels = models.slice(0, 5);
  const data = daily.map((day) => ({
    date: day.date,
    ...Object.fromEntries(topModels.map((model) => [model.id, day.models[model.id] ?? 0])),
  }));
  const config = Object.fromEntries(
    topModels.map((model, index) => [
      model.id,
      { label: model.name, color: `var(--chart-${index + 1})` },
    ]),
  ) satisfies ChartConfig;

  return (
    <DataSection
      contentClassName="p-4"
      title="Request volume by model"
      description="Daily request mix for the top five models"
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
              key={model.id}
              dataKey={model.id}
              stackId="requests"
              fill={`var(--color-${model.id})`}
              radius={index === topModels.length - 1 ? [3, 3, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </DataSection>
  );
}

type ActivitySummary = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  writtenCacheTokens: number;
};

function TokenBreakdownCard({ summary }: { summary: ActivitySummary }) {
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

function PromptCachingCard({ summary, hitRate }: { summary: ActivitySummary; hitRate: number }) {
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

function TopKeysCard({
  keys,
}: {
  keys: Array<{ id: string; name: string; requests: number; cost: number }>;
}) {
  const topKeys = keys.slice(0, 5);
  const maxRequests = topKeys[0]?.requests ?? 0;

  return (
    <DataSection
      contentClassName="flex flex-col gap-4 p-4"
      title="Top API keys"
      description="Ranked by request volume; cost excludes requests with unknown prices"
    >
      {topKeys.length ? (
        topKeys.map((key) => (
          <div key={key.id} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-medium">{key.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {key.requests.toLocaleString()} · {formatCurrency(key.cost)}
              </span>
            </div>
            <Progress value={maxRequests ? (key.requests / maxRequests) * 100 : 0} />
          </div>
        ))
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowUpRightIcon className="size-4" />
          Requests from API keys will appear here.
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
