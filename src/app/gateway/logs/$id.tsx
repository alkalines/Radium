import { ensureSession as ensureSessionClient } from "@better-auth-ui/core";
import { ensureSessionServer } from "@better-auth-ui/core/server";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowLeftIcon,
  ChartNoAxesCombinedIcon,
  CheckIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  CopyIcon,
  GaugeIcon,
  HashIcon,
  Settings2Icon,
} from "lucide-react";
import { useState } from "react";

import { CompletionTelemetryPanel } from "@/components/telemetry/completion-telemetry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ProviderLogo } from "@/components/gateway/provider-logo";

type Generation = NonNullable<FunctionReturnType<typeof api.logs.getGeneration>>;

export const Route = createFileRoute("/gateway/logs/$id")({
  staticData: { pageTitle: "Generation log" },
  async beforeLoad({ context: { queryClient }, location }) {
    const ensureSession = createIsomorphicFn()
      .server(() =>
        ensureSessionServer(queryClient, auth as any, {
          baseURL: getRequestUrl().origin,
          headers: getRequestHeaders(),
        }),
      )
      .client(() => ensureSessionClient(queryClient, authClient));
    const session = await ensureSession();

    if (!session) {
      throw redirect({
        to: "/auth/$path",
        params: { path: "sign-in" },
        search: { redirectTo: location.href },
      });
    }
  },
  loader: ({ context: { queryClient }, params: { id } }) => {
    void queryClient.prefetchQuery(
      convexQuery(api.logs.getGeneration, {
        generationId: id as Id<"chat_completions">,
      }),
    );
  },
  component: GenerationLogPage,
});

function GenerationLogPage() {
  const { id } = Route.useParams();
  const { data: generation } = useQuery(
    convexQuery(api.logs.getGeneration, {
      generationId: id as Id<"chat_completions">,
    }),
  );

  if (generation === undefined) return <GenerationSkeleton />;
  if (generation === null) throw notFound();

  return <GenerationDetails generation={generation} />;
}

function GenerationDetails({ generation }: { generation: Generation }) {
  const { request, response } = generation;
  const totalTokens = response.usage.prompt_tokens + response.usage.completion_tokens;
  const tokensPerSecond = response.gen_time
    ? response.usage.completion_tokens / (response.gen_time / 1000)
    : 0;
  const upstreamCost = response.pricing.cost_details?.upstream_inference_cost;
  const displayedCost = request.byok
    ? (upstreamCost ?? response.pricing.cost)
    : response.pricing.cost;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-4 md:p-6">
      <header className="flex flex-col gap-5 border-b pb-6">
        <Button variant="outline" size="icon" asChild>
          <Link to="/gateway/$section" params={{ section: "logs" }}>
            <ArrowLeftIcon />
            <span className="sr-only">Back to generation logs</span>
          </Link>
        </Button>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted">
              <ProviderLogo slug={request.provider} className="size-6" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-heading text-2xl font-medium tracking-tight md:text-3xl">
                  {request.model?.name ?? request.model?.slug ?? "Unknown model"}
                </h1>
                <Badge variant={request.canceled ? "destructive" : "secondary"}>
                  {request.canceled ? "Canceled" : response.finish_reason}
                </Badge>
                {generation.telemetry && <Badge variant="outline">Telemetry recorded</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">
                {request.provider} · {formatDateTime(generation._creationTime)}
              </p>
              <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
                {generation._id}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={request.byok ? "outline" : "secondary"}>
              {request.byok ? "BYOK" : "Radium credits"}
            </Badge>
            <Badge variant="outline">{request.streamed ? "Streamed" : "Non-streaming"}</Badge>
          </div>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Generation summary">
        <MetricCard
          label="Total cost"
          value={formatCurrency(displayedCost)}
          detail={
            request.byok
              ? "Estimated cost · billed by the provider directly"
              : "Charged to your Radium balance"
          }
          icon={CircleDollarSignIcon}
        />
        <MetricCard
          label="Total tokens"
          value={totalTokens.toLocaleString()}
          detail={`${response.usage.prompt_tokens.toLocaleString()} input · ${response.usage.completion_tokens.toLocaleString()} output`}
          icon={HashIcon}
        />
        <MetricCard
          label="Time to first token"
          value={formatDuration(response.ttft)}
          detail={`${formatDuration(response.gen_time)} provider generation`}
          icon={Clock3Icon}
        />
        <MetricCard
          label="Throughput"
          value={`${tokensPerSecond.toFixed(1)} tok/s`}
          detail="Output tokens per second"
          icon={GaugeIcon}
        />
      </section>

      <TelemetryStatusCard hasTelemetry={generation.telemetry !== undefined} />

      <section className="grid items-start gap-4 lg:grid-cols-2" aria-label="Generation metadata">
        <DetailCard title="Identifiers" description="Radium and upstream references">
          <DetailRow label="Generation ID" value={generation._id} mono copyable />
          <DetailRow label="Created at" value={formatDateTime(generation._creationTime)} />
          <DetailRow label="Request ID" value={response.genId} mono copyable />
          <DetailRow label="Provider generation ID" value={response.providerGenId} mono copyable />
          <DetailRow label="Model ID" value={request.model?.id ?? "Not available"} mono copyable />
          <DetailRow label="Canonical model" value={request.model?.slug ?? "Not available"} mono />
          <DetailRow label="Model type" value={request.model?.type ?? "Not available"} />
        </DetailCard>

        <DetailCard title="Request" description="Routing and request behavior">
          <DetailRow label="Provider" value={request.provider} />
          <DetailRow label="Usage type" value={request.byok ? "BYOK" : "Radium credits"} />
          <DetailRow label="Streaming" value={request.streamed ? "Enabled" : "Disabled"} />
          <DetailRow label="Canceled" value={request.canceled ? "Yes" : "No"} />
          <DetailRow label="Finish reason" value={response.finish_reason} />
          <DetailRow
            label="API key"
            value={generation.apiKey?.name ?? generation.apiKey?.preview ?? "Radium Chatroom"}
          />
          {generation.apiKey && (
            <DetailRow label="API key ID" value={generation.apiKey.id} mono copyable />
          )}
          {generation.apiKey?.preview && (
            <DetailRow label="API key preview" value={generation.apiKey.preview} mono />
          )}
          {generation.app && <DetailRow label="App" value={generation.app.title} />}
          {generation.app && <DetailRow label="App ID" value={generation.app.id} mono copyable />}
          {generation.app && <DetailRow label="App URL" value={generation.app.url} mono copyable />}
          {generation.app?.icon && (
            <DetailRow label="App icon" value={generation.app.icon} mono copyable />
          )}
        </DetailCard>

        <DetailCard title="Token usage" description="Provider-reported generation usage">
          <DetailRow label="Input tokens" value={response.usage.prompt_tokens.toLocaleString()} />
          <DetailRow
            label="Output tokens"
            value={response.usage.completion_tokens.toLocaleString()}
          />
          <DetailRow label="Total tokens" value={totalTokens.toLocaleString()} />
          <DetailRow
            label="Reasoning tokens"
            value={formatOptionalNumber(response.usage.completion_tokens_details.reasoning_tokens)}
          />
          <DetailRow
            label="Cached input tokens"
            value={formatOptionalNumber(response.usage.prompt_tokens_details.cached_tokens)}
          />
          <DetailRow
            label="Cache write tokens"
            value={formatOptionalNumber(response.usage.prompt_tokens_details.written_cache_tokens)}
          />
        </DetailCard>

        <DetailCard
          title="Pricing"
          description={
            request.byok
              ? "Estimated provider costs and the Radium BYOK fee"
              : "Cost components persisted at billing time"
          }
        >
          <DetailRow
            label="Input token cost"
            value={formatCurrency(response.pricing.prompt_tokens)}
            mono
          />
          <DetailRow
            label="Output token cost"
            value={formatCurrency(response.pricing.completion_tokens)}
            mono
          />
          <DetailRow
            label="Cached input cost"
            value={formatCurrency(response.pricing.prompt_tokens_details.cached_tokens)}
            mono
          />
          <DetailRow
            label="Upstream inference"
            value={upstreamCost == null ? "Not reported" : formatCurrency(upstreamCost)}
            mono
          />
          <Separator />
          {request.byok ? (
            <>
              <DetailRow
                label="Estimated provider cost"
                value={formatCurrency(displayedCost)}
                mono
              />
              <DetailRow label="Radium fee" value={formatCurrency(response.pricing.cost)} mono />
            </>
          ) : (
            <DetailRow label="Total cost" value={formatCurrency(response.pricing.cost)} mono />
          )}
        </DetailCard>

        <DetailCard title="Latency" description="Recorded request timing">
          <DetailRow label="Time to first token" value={formatDuration(response.ttft)} />
          <DetailRow label="Provider generation" value={formatDuration(response.gen_time)} />
          <DetailRow
            label="Moderation"
            value={
              response.moderation_latency === undefined
                ? "Not recorded"
                : formatDuration(response.moderation_latency)
            }
          />
          <DetailRow label="Throughput" value={`${tokensPerSecond.toFixed(1)} tok/s`} />
        </DetailCard>
      </section>

      {generation.telemetry && <CompletionTelemetryPanel telemetry={generation.telemetry} />}
    </main>
  );
}

function TelemetryStatusCard({ hasTelemetry }: { hasTelemetry: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{hasTelemetry ? "Telemetry recorded" : "No telemetry recorded"}</CardTitle>
        <CardDescription>
          {hasTelemetry
            ? "Timing, tool execution, and recorded payload data are available for this generation."
            : "Enable telemetry to collect execution timing and optional input and output payloads for future generations."}
        </CardDescription>
        <CardAction>
          {hasTelemetry ? (
            <ChartNoAxesCombinedIcon className="size-4 text-muted-foreground" />
          ) : (
            <Settings2Icon className="size-4 text-muted-foreground" />
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        <Button variant="outline" size="sm" asChild>
          {hasTelemetry ? (
            <a href="#telemetry">View telemetry data</a>
          ) : (
            <Link to="/chatroom/$section" params={{ section: "preferences" }} hash="telemetry">
              Open telemetry settings
            </Link>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        <CardAction>
          <Icon className="size-4 text-muted-foreground" />
        </CardAction>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

function DetailCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-3">{children}</dl>
      </CardContent>
    </Card>
  );
}

function DetailRow({
  label,
  value,
  mono,
  copyable,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "flex min-w-0 items-center gap-1 text-right text-sm",
          mono && "font-mono text-xs",
        )}
      >
        <span className="break-all">{value}</span>
        {copyable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => {
              void navigator.clipboard.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
            aria-label={`Copy ${label}`}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}
      </dd>
    </div>
  );
}

function GenerationSkeleton() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-28" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </main>
  );
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.abs(value) < 1 ? 6 : 2,
    maximumFractionDigits: Math.abs(value) < 1 ? 6 : 2,
  }).format(value);
}

function formatOptionalNumber(value: number | null | undefined): string {
  return value == null ? "Not reported" : value.toLocaleString();
}
