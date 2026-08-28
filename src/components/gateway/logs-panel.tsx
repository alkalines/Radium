import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import type { FunctionReturnType } from "convex/server";
import { CalendarIcon, CheckIcon, CopyIcon, ScrollTextIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import { ProviderLogo } from "./provider-logo";

type Generation = FunctionReturnType<typeof api.logs.getGenerations>[number];

function formatCredits(value: number): string {
  return `$${value.toFixed(Math.abs(value) < 1 ? 4 : 2)}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Format a millisecond duration as `s`/`ms` depending on magnitude. */
function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Tokens generated per second, derived from completion tokens and generation time. */
function tokensPerSecond(completionTokens: number, genTimeMs: number): number {
  return genTimeMs > 0 ? completionTokens / (genTimeMs / 1000) : 0;
}

const RANGE_PRESETS = {
  all: { label: "All time", days: null },
  "24h": { label: "Last 24 hours", days: 1 },
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
  custom: { label: "Custom range", days: null },
} as const;

type RangePreset = keyof typeof RANGE_PRESETS;

export function LogsPanel() {
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const { data: generations } = useQuery(
    convexQuery(api.logs.getGenerations, balanceId ? { balance: balanceId } : "skip"),
  );

  const [preset, setPreset] = useState<RangePreset>("all");
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [selected, setSelected] = useState<Generation | null>(null);

  const filtered = useMemo(() => {
    if (!generations) return generations;

    let from: number | undefined;
    let to: number | undefined;

    if (preset === "custom") {
      from = customRange?.from?.getTime();
      // Include the entire end day.
      to = customRange?.to ? customRange.to.getTime() + 24 * 60 * 60 * 1000 : undefined;
    } else if (RANGE_PRESETS[preset].days != null) {
      from = Date.now() - RANGE_PRESETS[preset].days! * 24 * 60 * 60 * 1000;
    }

    return generations.filter((generation) => {
      if (from != null && generation._creationTime < from) return false;
      if (to != null && generation._creationTime >= to) return false;
      return true;
    });
  }, [generations, preset, customRange]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Generation Logs</h2>
        <p className="text-sm text-muted-foreground">
          Every completion billed to this balance. Select a row to inspect model IDs, throughput,
          and latency.
        </p>
      </div>

      {!balanceId && userInfo !== undefined && (
        <Alert>
          <AlertTitle>No balance yet</AlertTitle>
          <AlertDescription>A balance is required to record generations.</AlertDescription>
        </Alert>
      )}

      {balanceId && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={preset} onValueChange={(value) => setPreset(value as RangePreset)}>
            <SelectTrigger className="w-44" size="sm">
              <CalendarIcon className="text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RANGE_PRESETS).map(([value, { label }]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {preset === "custom" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="font-normal">
                  <CalendarIcon className="text-muted-foreground" />
                  {customRange?.from ? (
                    customRange.to ? (
                      <>
                        {customRange.from.toLocaleDateString()} –{" "}
                        {customRange.to.toLocaleDateString()}
                      </>
                    ) : (
                      customRange.from.toLocaleDateString()
                    )
                  ) : (
                    "Pick dates"
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="range"
                  selected={customRange}
                  onSelect={setCustomRange}
                  numberOfMonths={2}
                  autoFocus
                />
              </PopoverContent>
            </Popover>
          )}

          {filtered && (
            <span className="ml-auto text-xs text-muted-foreground">
              {filtered.length} generation{filtered.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}

      {balanceId && generations === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : balanceId && filtered ? (
        filtered.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollTextIcon />
              </EmptyMedia>
              <EmptyTitle>No generations</EmptyTitle>
              <EmptyDescription>
                {generations && generations.length > 0
                  ? "No generations match the selected date range."
                  : "Completions billed to this balance will appear here."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Usage Type</TableHead>
                  <TableHead className="text-right">Speed</TableHead>
                  <TableHead>Finish Reason</TableHead>
                  <TableHead>API Key</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((generation) => (
                  <GenerationRow
                    key={generation._id}
                    generation={generation}
                    onSelect={() => setSelected(generation)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : null}

      <GenerationSheet generation={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

function GenerationRow({ generation, onSelect }: { generation: Generation; onSelect: () => void }) {
  const { request, response } = generation;
  const tps = tokensPerSecond(response.usage.completion_tokens, response.gen_time);

  return (
    <TableRow className="cursor-pointer" onClick={onSelect}>
      <TableCell className="text-muted-foreground">
        {formatDate(generation._creationTime)}
      </TableCell>
      <TableCell className="font-medium">
        {request.model?.name ?? request.model?.slug ?? "Unknown"}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5">
          <ProviderLogo slug={request.provider} className="size-4" />
          {request.provider}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">{response.usage.prompt_tokens}</TableCell>
      <TableCell className="text-right tabular-nums">{response.usage.completion_tokens}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatCredits(response.pricing.cost)}
      </TableCell>
      <TableCell>
        <Badge variant={request.byok ? "outline" : "secondary"}>
          {request.byok ? "BYOK" : "Credits"}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">{tps.toFixed(1)} tok/s</TableCell>
      <TableCell className="text-muted-foreground">{response.finish_reason}</TableCell>
      <TableCell className="text-muted-foreground">
        {generation.apiKey?.name ?? generation.apiKey?.preview ?? "—"}
      </TableCell>
    </TableRow>
  );
}

function GenerationSheet({
  generation,
  onOpenChange,
}: {
  generation: Generation | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={generation !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        {generation && <GenerationDetail generation={generation} />}
      </SheetContent>
    </Sheet>
  );
}

function GenerationDetail({ generation }: { generation: Generation }) {
  const { request, response } = generation;
  const tps = tokensPerSecond(response.usage.completion_tokens, response.gen_time);

  return (
    <>
      <SheetHeader className="gap-2 border-b">
        <div className="flex items-center gap-2">
          <ProviderLogo slug={request.provider} className="size-7" />
          <div className="flex min-w-0 flex-col">
            <SheetTitle className="truncate">
              {request.model?.name ?? request.model?.slug ?? "Unknown model"}
            </SheetTitle>
            <SheetDescription>
              {request.provider} · {formatDate(generation._creationTime)}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="flex flex-col gap-6 overflow-y-auto p-6">
        <DetailSection title="Identifiers">
          <DetailRow label="Model ID" value={request.model?.id ?? "—"} mono copyable />
          <DetailRow label="Canonical ID" value={request.model?.slug ?? "—"} mono copyable />
          <DetailRow label="Generation ID" value={response.genId} mono copyable />
          <DetailRow label="Provider gen ID" value={response.providerGenId} mono copyable />
        </DetailSection>

        <DetailSection title="Performance">
          <DetailRow label="TTFT" value={formatDuration(response.ttft)} />
          <DetailRow label="TPS" value={`${tps.toFixed(1)} tok/s`} />
          <DetailRow label="Provider Latency" value={formatDuration(response.gen_time)} />
          {response.moderation_latency !== undefined && (
            <DetailRow label="Moderation" value={formatDuration(response.moderation_latency)} />
          )}
        </DetailSection>

        <DetailSection title="Tokens & Cost">
          <DetailRow label="Input tokens" value={String(response.usage.prompt_tokens)} />
          <DetailRow label="Output tokens" value={String(response.usage.completion_tokens)} />
          {response.usage.completion_tokens_details.reasoning_tokens != null && (
            <DetailRow
              label="Reasoning tokens"
              value={String(response.usage.completion_tokens_details.reasoning_tokens)}
            />
          )}
          {response.usage.prompt_tokens_details.cached_tokens != null && (
            <DetailRow
              label="Cached tokens"
              value={String(response.usage.prompt_tokens_details.cached_tokens)}
            />
          )}
          <DetailRow label="Cost" value={formatCredits(response.pricing.cost)} mono />
        </DetailSection>

        <DetailSection title="Request">
          <DetailRow label="Usage type" value={request.byok ? "BYOK" : "Credits"} />
          <DetailRow label="Finish reason" value={response.finish_reason} />
          <DetailRow label="Streamed" value={request.streamed ? "Yes" : "No"} />
          <DetailRow label="Canceled" value={request.canceled ? "Yes" : "No"} />
          <DetailRow
            label="API key"
            value={generation.apiKey?.name ?? generation.apiKey?.preview ?? "—"}
          />
        </DetailSection>
      </div>
    </>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      <dl className="flex flex-col gap-1">{children}</dl>
    </div>
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
    <div className="flex items-center justify-between gap-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={cn("flex min-w-0 items-center gap-1 text-sm", mono && "font-mono text-xs")}>
        <span className="truncate">{value}</span>
        {copyable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-muted-foreground"
            onClick={() => {
              void navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            aria-label={`Copy ${label}`}
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </Button>
        )}
      </dd>
    </div>
  );
}
