import { AlertCircleIcon, CheckCircle2Icon, ChevronDownIcon, TimerIcon } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

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
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type TelemetryTool = {
  name: string;
  status: "ok" | "error";
  startedAt: number;
  endedAt: number;
  durationMs: number;
  toolCallId?: string;
  error?: string;
  inputJson?: string;
  outputJson?: string;
};

export type CompletionTelemetry = {
  chatId?: string;
  stepNumber: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  inputJson?: string;
  outputJson?: string;
  tools: TelemetryTool[];
};

const timelineConfig = {
  offset: { label: "Started after", color: "transparent" },
  duration: { label: "Duration", color: "var(--chart-3)" },
} satisfies ChartConfig;

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Visualize one generation step and its tool spans. */
export function CompletionTelemetryPanel({ telemetry }: { telemetry: CompletionTelemetry }) {
  const failedTools = telemetry.tools.filter((tool) => tool.status === "error").length;

  return (
    <section
      id="telemetry"
      className="flex scroll-mt-20 flex-col gap-4"
      aria-labelledby="telemetry-heading"
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="telemetry-heading" className="font-heading text-xl font-medium">
            Telemetry
          </h2>
          <Badge variant="outline">Step {telemetry.stepNumber}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Internal timing, tool execution, and recorded payloads for this generation.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TelemetryMetric label="Step duration" value={formatDuration(telemetry.durationMs)} />
        <TelemetryMetric label="Tool calls" value={telemetry.tools.length.toLocaleString()} />
        <TelemetryMetric
          label="Tool status"
          value={failedTools ? `${failedTools} failed` : "All successful"}
        />
        <TelemetryMetric
          label="Started"
          value={new Date(telemetry.startedAt).toLocaleTimeString()}
        />
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Trace context</CardTitle>
          <CardDescription>Persisted identifiers and telemetry boundaries</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <TelemetryContextValue
              label="Started at"
              value={formatTimestamp(telemetry.startedAt)}
            />
            <TelemetryContextValue label="Ended at" value={formatTimestamp(telemetry.endedAt)} />
            <TelemetryContextValue
              label="Chat ID"
              value={telemetry.chatId ?? "Gateway request"}
              mono
            />
          </dl>
        </CardContent>
      </Card>

      <TelemetryTimeline telemetry={telemetry} />

      {telemetry.tools.length > 0 && <TelemetryTools tools={telemetry.tools} />}

      {(telemetry.inputJson !== undefined || telemetry.outputJson !== undefined) && (
        <TelemetryPayloads inputJson={telemetry.inputJson} outputJson={telemetry.outputJson} />
      )}
    </section>
  );
}

function TelemetryContextValue({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("break-all", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}

function TelemetryMetric({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

/** Render proportional generation and tool timing from a telemetry payload. */
export function TelemetryTimeline({ telemetry }: { telemetry: CompletionTelemetry }) {
  const data = [
    { name: `Step ${telemetry.stepNumber}`, offset: 0, duration: telemetry.durationMs },
    ...telemetry.tools.map((tool) => ({
      name: tool.name,
      offset: Math.max(0, tool.startedAt - telemetry.startedAt),
      duration: tool.durationMs,
    })),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution timeline</CardTitle>
        <CardDescription>Span offsets and duration relative to the generation step</CardDescription>
        <CardAction>
          <TimerIcon className="size-4 text-muted-foreground" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={timelineConfig}
          className="w-full"
          style={{ height: Math.max(180, data.length * 44) }}
        >
          <BarChart
            accessibilityLayer
            data={data}
            layout="vertical"
            margin={{ left: 12, right: 20 }}
          >
            <CartesianGrid horizontal={false} />
            <XAxis
              type="number"
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => formatDuration(Number(value))}
            />
            <YAxis
              type="category"
              dataKey="name"
              axisLine={false}
              tickLine={false}
              width={112}
              tick={{ fontSize: 11 }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(value, name) => (
                    <div className="flex min-w-36 items-center justify-between gap-4">
                      <span className="text-muted-foreground">
                        {name === "offset" ? "Started after" : "Duration"}
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {formatDuration(Number(value))}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <Bar dataKey="offset" stackId="timeline" fill="transparent" />
            <Bar
              dataKey="duration"
              stackId="timeline"
              fill="var(--color-duration)"
              radius={[0, 4, 4, 0]}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Show tool timing, status, errors, and optionally recorded payloads. */
export function TelemetryTools({ tools }: { tools: TelemetryTool[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool calls</CardTitle>
        <CardDescription>Execution details for tools invoked during this step</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Started</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Call ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((tool, index) => (
                <TableRow key={tool.toolCallId ?? `${tool.name}-${index}`}>
                  <TableCell className="font-medium">{tool.name}</TableCell>
                  <TableCell>
                    <Badge variant={tool.status === "ok" ? "secondary" : "destructive"}>
                      {tool.status === "ok" ? <CheckCircle2Icon /> : <AlertCircleIcon />}
                      {tool.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {new Date(tool.startedAt).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatDuration(tool.durationMs)}
                  </TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                    {tool.toolCallId ?? "Not recorded"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {tools.map((tool, index) =>
          tool.error || tool.inputJson !== undefined || tool.outputJson !== undefined ? (
            <ToolPayload key={tool.toolCallId ?? `${tool.name}-${index}`} tool={tool} />
          ) : null,
        )}
      </CardContent>
    </Card>
  );
}

function ToolPayload({ tool }: { tool: TelemetryTool }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-between rounded-lg px-3">
          <span className="truncate">{tool.name} payload</span>
          <ChevronDownIcon
            data-icon="inline-end"
            className={cn("transition-transform", open && "rotate-180")}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t p-3">
        {tool.error && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Error</span>
            <pre className="overflow-x-auto text-wrap rounded-md bg-muted p-3 font-mono text-xs">
              {tool.error}
            </pre>
          </div>
        )}
        {(tool.inputJson !== undefined || tool.outputJson !== undefined) && (
          <TelemetryPayloads inputJson={tool.inputJson} outputJson={tool.outputJson} compact />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Display recorded telemetry input and output as readable JSON or plain text. */
export function TelemetryPayloads({
  inputJson,
  outputJson,
  compact = false,
}: {
  inputJson?: string;
  outputJson?: string;
  compact?: boolean;
}) {
  const defaultTab = inputJson !== undefined ? "input" : "output";

  return (
    <Card className={cn(compact && "shadow-none")} size={compact ? "sm" : "default"}>
      <CardHeader>
        <CardTitle>{compact ? "Recorded data" : "Recorded payloads"}</CardTitle>
        {!compact && (
          <CardDescription>
            Input and output are only present when telemetry recording was enabled.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={defaultTab}>
          <TabsList>
            {inputJson !== undefined && <TabsTrigger value="input">Input</TabsTrigger>}
            {outputJson !== undefined && <TabsTrigger value="output">Output</TabsTrigger>}
          </TabsList>
          {inputJson !== undefined && (
            <TabsContent value="input">
              <JsonPayload value={inputJson} />
            </TabsContent>
          )}
          {outputJson !== undefined && (
            <TabsContent value="output">
              <JsonPayload value={outputJson} />
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function JsonPayload({ value }: { value: string }) {
  let formatted = value;
  try {
    formatted = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    // Telemetry can contain non-JSON text from third-party tools.
  }

  return (
    <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
      <code>{formatted}</code>
    </pre>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
}
