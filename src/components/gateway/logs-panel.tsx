import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { CalendarIcon, ScrollTextIcon } from "lucide-react";
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
        <h2 className="text-lg font-semibold tracking-tight">Logs</h2>
        <p className="text-sm text-muted-foreground">
          Every gateway request billed to this balance. Select a row to inspect identifiers, tokens,
          throughput, and latency.
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
              <SelectGroup>
                {Object.entries(RANGE_PRESETS).map(([value, { label }]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
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
              {filtered.length} request{filtered.length === 1 ? "" : "s"}
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
              <EmptyTitle>No requests</EmptyTitle>
              <EmptyDescription>
                {generations && generations.length > 0
                  ? "No generations match the selected date range."
                  : "Gateway requests billed to this balance will appear here."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Usage Type</TableHead>
                  <TableHead className="text-right">Speed</TableHead>
                  <TableHead>Finish Reason</TableHead>
                  <TableHead>Telemetry</TableHead>
                  <TableHead>API Key</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((generation) => (
                  <GenerationRow key={generation._id} generation={generation} />
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : null}
    </div>
  );
}

function GenerationRow({ generation }: { generation: Generation }) {
  const navigate = useNavigate();
  const { request, response } = generation;
  const tps = tokensPerSecond(response.usage.completion_tokens, response.gen_time);
  const openGeneration = () =>
    navigate({ to: "/gateway/logs/$id", params: { id: generation._id } });

  return (
    <TableRow
      className="cursor-pointer"
      role="link"
      tabIndex={0}
      onClick={() => void openGeneration()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openGeneration();
        }
      }}
    >
      <TableCell className="text-muted-foreground">
        {formatDate(generation._creationTime)}
      </TableCell>
      <TableCell className="max-w-28 truncate font-mono text-xs text-muted-foreground">
        {response.genId}
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
      <TableCell>
        <Badge variant={generation.hasTelemetry ? "outline" : "secondary"}>
          {generation.hasTelemetry ? "Recorded" : "Off"}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {generation.apiKey?.name ?? generation.apiKey?.preview ?? "Radium Chatroom"}
      </TableCell>
    </TableRow>
  );
}
